/**
 * @fileoverview Per-machine, per-zvol disk I/O collector for Zoneweaver Agent
 * @description Runs ONE long-lived DTrace consumer that aggregates the guests'
 * pread/preadv/pwrite/pwritev RETURN values by (zonename, fd pathname) and
 * emits an interval every `zvol_io.interval_seconds`. This is the only source
 * of per-VM disk I/O on this platform — see ZvolIoStatsModel for the probe
 * receipts (no objset kstats on illumos ZFS, no zvol block kstat, and zone_vfs
 * misses bhyve's raw-zvol traffic entirely).
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { spawn } from 'child_process';
import os from 'os';
import { Op } from 'sequelize';
import config from '../config/ConfigLoader.js';
import ZvolIoStats from '../models/ZvolIoStatsModel.js';
import { log, createTimer } from '../lib/Logger.js';

/**
 * The DTrace program. Aggregates on RETURN because on entry `arg2` of a
 * *v syscall is the iovec COUNT, not a byte length — the return value is the
 * bytes actually transferred. Each aggregation prints on its own line type so
 * the parser never depends on multi-aggregation key alignment.
 * @param {number} intervalSeconds - Aggregation interval
 * @returns {string} DTrace program text
 */
const buildProgram = intervalSeconds => `
syscall::pread:entry,syscall::preadv:entry,syscall::pwrite:entry,syscall::pwritev:entry
/zonename != "global"/
{ self->fd = arg0; }

syscall::pread:return,syscall::preadv:return
/self->fd && arg0 > 0/
{
  @ro[zonename, fds[self->fd].fi_pathname] = count();
  @rb[zonename, fds[self->fd].fi_pathname] = sum(arg0);
}

syscall::pwrite:return,syscall::pwritev:return
/self->fd && arg0 > 0/
{
  @wo[zonename, fds[self->fd].fi_pathname] = count();
  @wb[zonename, fds[self->fd].fi_pathname] = sum(arg0);
}

syscall::pread:return,syscall::preadv:return,syscall::pwrite:return,syscall::pwritev:return
{ self->fd = 0; }

tick-${intervalSeconds}s
{
  printa("RO\\t%s\\t%s\\t%@d\\n", @ro);
  printa("RB\\t%s\\t%s\\t%@d\\n", @rb);
  printa("WO\\t%s\\t%s\\t%@d\\n", @wo);
  printa("WB\\t%s\\t%s\\t%@d\\n", @wb);
  printf("END\\t%d\\n", walltimestamp / 1000000000);
  trunc(@ro); trunc(@rb); trunc(@wo); trunc(@wb);
}
`;

/**
 * The device paths DTrace reports are zone-rooted:
 *   /Array-0/zones/<zone>/path/root/dev/zvol/rdsk/Array-0/zones/<zone>/boot
 * Everything up to and including the /dev/zvol/{r,}dsk/ segment is the zone's
 * lofs view — the dataset is what follows.
 * @param {string} pathname - fi_pathname from DTrace
 * @returns {string|null} The zvol dataset, or null when the path is not a zvol
 */
export const datasetFromDevicePath = pathname => {
  const match = pathname.match(/\/dev\/zvol\/r?dsk\/(?<dataset>.+)$/);
  return match ? match.groups.dataset : null;
};

/** DTrace line prefix → the counter it carries. */
const FIELD_BY_KIND = {
  RO: 'read_ops',
  RB: 'read_bytes',
  WO: 'write_ops',
  WB: 'write_bytes',
};

/**
 * Per-machine, per-zvol disk I/O collector (one supervised DTrace child).
 */
class ZvolIoCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.child = null;
    this.stdoutBuffer = '';
    this.interval = new Map();
    this.stopping = false;
    this.disabled = false;
    this.consecutiveFailures = 0;
    this.restartTimer = null;
  }

  /**
   * The collector's live config block (host_monitoring.zvol_io).
   * @returns {{enabled: boolean, interval_seconds: number}}
   */
  getConfig() {
    const zvolIo = this.hostMonitoringConfig.zvol_io || {};
    return {
      enabled: zvolIo.enabled !== false,
      intervalSeconds: Math.max(parseInt(zvolIo.interval_seconds, 10) || 10, 5),
    };
  }

  /**
   * Start the DTrace consumer (idempotent).
   * @returns {boolean} True when the consumer is running or was started
   */
  start() {
    const { enabled, intervalSeconds } = this.getConfig();
    if (!enabled) {
      log.monitoring.info('Per-zvol disk I/O collection disabled by config', {
        hostname: this.hostname,
      });
      return false;
    }
    if (this.disabled || this.child) {
      return Boolean(this.child);
    }

    this.stopping = false;
    this.spawnConsumer(intervalSeconds);
    return true;
  }

  /**
   * Spawn the DTrace child and wire its streams.
   * @param {number} intervalSeconds - Aggregation interval
   */
  spawnConsumer(intervalSeconds) {
    const program = buildProgram(intervalSeconds);
    this.intervalSeconds = intervalSeconds;

    const child = spawn('pfexec', ['dtrace', '-qn', program], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuffer = '';
    this.interval.clear();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.consumeStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const message = chunk.trim();
      if (!message) {
        return;
      }
      // A privilege or probe-compile failure will never fix itself by
      // restarting — disable loudly instead of spinning.
      if (
        /privilege|permission|not permitted|failed to (?:initialize|compile|enable)/i.test(message)
      ) {
        this.disabled = true;
        log.monitoring.error(
          'Per-zvol disk I/O collector disabled — DTrace cannot run (the agent user needs dtrace privileges)',
          { error: message, hostname: this.hostname }
        );
        return;
      }
      log.monitoring.warn('DTrace disk-I/O consumer stderr', {
        message,
        hostname: this.hostname,
      });
    });

    child.on('error', error => {
      log.monitoring.error('Failed to spawn the DTrace disk-I/O consumer', {
        error: error.message,
        hostname: this.hostname,
      });
      this.child = null;
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        log.monitoring.info('DTrace disk-I/O consumer stopped', { hostname: this.hostname });
        return;
      }
      log.monitoring.warn('DTrace disk-I/O consumer exited', {
        exit_code: code,
        signal,
        hostname: this.hostname,
      });
      this.scheduleRestart();
    });

    log.monitoring.info('DTrace disk-I/O consumer started', {
      pid: child.pid,
      interval_seconds: intervalSeconds,
      hostname: this.hostname,
    });
  }

  /**
   * Respawn after a failure, backing off and giving up after the configured
   * consecutive-error ceiling.
   */
  scheduleRestart() {
    if (this.stopping || this.disabled) {
      return;
    }
    this.consecutiveFailures++;
    const maxErrors = this.hostMonitoringConfig.error_handling.max_consecutive_errors;
    if (this.consecutiveFailures >= maxErrors) {
      this.disabled = true;
      log.monitoring.error(
        'Per-zvol disk I/O collector disabled after repeated DTrace failures — machine disk I/O will not be collected',
        {
          failures: this.consecutiveFailures,
          max_errors: maxErrors,
          hostname: this.hostname,
        }
      );
      return;
    }
    const delay = this.hostMonitoringConfig.error_handling.retry_delay * 1000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping && !this.disabled) {
        this.spawnConsumer(this.intervalSeconds);
      }
    }, delay);
  }

  /**
   * Stop the consumer.
   */
  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  /**
   * Buffer DTrace stdout and process it line by line (chunks split anywhere).
   * @param {string} chunk - stdout chunk
   */
  consumeStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  /**
   * Handle one DTrace output line: a metric row (RO/RB/WO/WB) accumulates into
   * the current interval; END flushes it.
   * @param {string} line - One output line
   */
  consumeLine(line) {
    const parts = line.split('\t').map(part => part.trim());
    const [kind] = parts;

    if (kind === 'END') {
      const rows = [...this.interval.values()];
      this.interval.clear();
      this.consecutiveFailures = 0;
      if (rows.length > 0) {
        this.persist(rows).catch(error => {
          log.database.error('Failed to store per-zvol disk I/O', {
            error: error.message,
            hostname: this.hostname,
          });
        });
      }
      return;
    }

    const field = FIELD_BY_KIND[kind];
    if (!field || parts.length < 4) {
      return;
    }

    const [, zoneName, pathname, rawValue] = parts;
    const dataset = datasetFromDevicePath(pathname);
    if (!dataset) {
      // The machine's own file-backed devices (ISOs, uefivars) also ride these
      // syscalls — only zvols are machine disks.
      return;
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return;
    }

    const key = `${zoneName}\t${dataset}`;
    const [pool] = dataset.split('/');
    const device = dataset.split('/').pop();
    const row = this.interval.get(key) || {
      host: this.hostname,
      zone_name: zoneName,
      dataset,
      pool,
      device,
      read_ops: 0,
      read_bytes: 0,
      write_ops: 0,
      write_bytes: 0,
    };
    row[field] += value;
    this.interval.set(key, row);
  }

  /**
   * Store one interval's rows, deriving the per-second rates.
   * @param {Array<Object>} rows - Accumulated rows
   */
  async persist(rows) {
    const scanTimestamp = new Date();
    const seconds = this.intervalSeconds || 10;
    await ZvolIoStats.bulkCreate(
      rows.map(row => ({
        ...row,
        read_bps: row.read_bytes / seconds,
        write_bps: row.write_bytes / seconds,
        read_iops: row.read_ops / seconds,
        write_iops: row.write_ops / seconds,
        interval_seconds: seconds,
        scan_timestamp: scanTimestamp,
      }))
    );
    log.monitoring.debug('Per-zvol disk I/O interval stored', {
      rows: rows.length,
      hostname: this.hostname,
    });
  }

  /**
   * Drop rows past the storage retention window.
   */
  async cleanupOldData() {
    const timer = createTimer('zvol_io_cleanup');
    try {
      const days = this.hostMonitoringConfig.retention.storage;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const deleted = await ZvolIoStats.destroy({
        where: { scan_timestamp: { [Op.lt]: cutoff } },
      });
      const duration = timer.end();
      if (deleted > 0) {
        log.database.info('Per-zvol disk I/O cleanup completed', {
          deleted,
          duration_ms: duration,
          hostname: this.hostname,
        });
      }
    } catch (error) {
      timer.end();
      log.database.error('Failed to clean up per-zvol disk I/O data', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }
}

export default ZvolIoCollector;
