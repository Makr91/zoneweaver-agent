import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import CPUStats from '../../models/CPUStatsModel.js';
import MemoryStats from '../../models/MemoryStatsModel.js';
import ZoneMetrics from '../../models/ZoneMetricsModel.js';
import { log } from '../../lib/Logger.js';
import {
  parseVmstatOutput,
  parseKstatMemory,
  parseSwapOutput,
  getLoadAverages,
  parseZonestatSummary,
  parseZoneKstats,
} from './parsers.js';

const execProm = util.promisify(exec);

/**
 * The frozen io_delay_pct sample (cross-agent consensus 2026-07-19): the
 * MAX ZFS pool %w over a 2s iostat interval — the share of the interval
 * with I/O WAITING in the bottleneck pool's queue. CPU iowait is hardwired
 * 0 on illumos; the pool queue is where delay truthfully surfaces
 * (host-verified: a pool read %w 4 while its member disks read 0). Device
 * %w is the pool-less fallback; null when nothing measures.
 * @param {number} timeout - Base command timeout (ms)
 * @returns {Promise<number|null>} io_delay_pct or null
 */
export const collectIoDelay = async (collector, timeout) => {
  try {
    const [poolsResult, iostatResult] = await Promise.all([
      execProm('zpool list -H -o name', { timeout }),
      execProm('iostat -xn 2 2', { timeout: timeout + 10000 }),
    ]);
    const poolNames = new Set(
      poolsResult.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    );
    const blocks = iostatResult.stdout.split('extended device statistics');
    const lastBlock = blocks[blocks.length - 1] || '';
    let poolMax = null;
    let deviceMax = null;
    for (const line of lastBlock.split('\n')) {
      const fields = line.trim().split(/\s+/u);
      if (fields.length < 11 || fields[0] === 'r/s') {
        continue;
      }
      const waitPct = Number(fields[8]);
      if (!Number.isFinite(waitPct)) {
        continue;
      }
      if (poolNames.has(fields[10])) {
        poolMax = Math.max(poolMax ?? 0, waitPct);
      } else {
        deviceMax = Math.max(deviceMax ?? 0, waitPct);
      }
    }
    return poolMax ?? deviceMax;
  } catch (error) {
    log.monitoring.warn('io_delay collection failed', {
      error: error.message,
      hostname: collector.hostname,
    });
    return null;
  }
};

/**
 * Collect CPU statistics with per-core data
 * @returns {Promise<boolean>} Success status
 */
export const collectCPUStats = async collector => {
  if (collector.isCollecting) {
    return true;
  }

  collector.isCollecting = true;

  try {
    const timeout = collector.hostMonitoringConfig.performance.command_timeout * 1000;

    const [{ stdout: vmstatOutput }, ioDelayPct] = await Promise.all([
      execProm('vmstat 1 2', { timeout }),
      collectIoDelay(collector, timeout),
    ]);
    const vmstatStats = parseVmstatOutput(vmstatOutput, collector.hostname);

    // Get per-core CPU data using os.cpus()
    const currentCPUTimes = os.cpus();
    let perCoreData = [];

    if (collector.lastCPUTimes) {
      // Clamp to [0,100] and round to 2 decimals: kstat snapshot jitter can make
      // per-bucket deltas fractionally negative, and raw ratios serialize as
      // exponent-notation numbers — clamped, rounded values keep the stored
      // JSON sane and compact.
      const pct = (part, whole) =>
        Math.min(100, Math.max(0, Math.round((part / whole) * 10000) / 100));

      // Stored in the COMPACT per-core form: [user_pct, system_pct, idle_pct,
      // utilization_pct], array index = core number. cpu_id derives from the
      // index and iowait is always 0 (os.cpus() exposes none), so nothing is
      // lost — /monitoring/system/cpu expands rows back to the full
      // per_core_parsed objects. Cuts the stored JSON ~4x (repeated keys gone).
      perCoreData = currentCPUTimes.map((core, i) => {
        const lastCore = collector.lastCPUTimes[i];
        // irq is deliberately EXCLUDED: illumos cpu_nsec_intr overlaps the
        // user/kernel/idle partition, so counting it inflates the denominator
        // ~3× and every core reads a flat ~70% (user+sys+idle alone account
        // for exactly wall clock — verified on box 1162)
        const totalDiff =
          core.times.user -
          lastCore.times.user +
          (core.times.nice - lastCore.times.nice) +
          (core.times.sys - lastCore.times.sys) +
          (core.times.idle - lastCore.times.idle);

        if (totalDiff <= 0) {
          return [0, 0, 100, 0];
        }

        const idleDiff = core.times.idle - lastCore.times.idle;
        const userDiff = core.times.user - lastCore.times.user;
        const sysDiff = core.times.sys - lastCore.times.sys;

        return [
          pct(userDiff, totalDiff),
          pct(sysDiff, totalDiff),
          pct(idleDiff, totalDiff),
          pct(totalDiff - idleDiff, totalDiff),
        ];
      });
    }

    collector.lastCPUTimes = currentCPUTimes;

    // Get load averages
    const loadStats = getLoadAverages();

    // Get CPU count
    const cpuCount = os.cpus().length;

    // Calculate overall CPU utilization
    const cpuUtilization = 100 - vmstatStats.cpu.idle_pct;

    // Serialize per-core data using non-blocking JSON
    const perCoreDataJson = perCoreData.length > 0 ? JSON.stringify(perCoreData) : null;

    const cpuData = {
      host: collector.hostname,
      cpu_count: cpuCount,
      cpu_utilization_pct: cpuUtilization,
      user_pct: vmstatStats.cpu.user_pct,
      system_pct: vmstatStats.cpu.system_pct,
      idle_pct: vmstatStats.cpu.idle_pct,
      iowait_pct: null, // OmniOS vmstat doesn't directly show iowait
      io_delay_pct: ioDelayPct,
      load_avg_1min: loadStats.load_avg_1min,
      load_avg_5min: loadStats.load_avg_5min,
      load_avg_15min: loadStats.load_avg_15min,
      processes_running: vmstatStats.processes.running,
      processes_blocked: vmstatStats.processes.blocked,
      context_switches: vmstatStats.cpu.context_switches,
      interrupts: vmstatStats.cpu.interrupts,
      system_calls: vmstatStats.cpu.system_calls,
      page_faults: vmstatStats.memory.minor_faults,
      page_ins: vmstatStats.memory.page_in,
      page_outs: vmstatStats.memory.page_out,
      per_core_data: perCoreDataJson,
      scan_timestamp: new Date(),
    };

    // Store CPU statistics
    await CPUStats.create(cpuData);

    // Log CPU collection success with core info for monitoring
    if (perCoreData.length > 0) {
      log.monitoring.debug('CPU statistics collected', {
        cpu_count: cpuCount,
        cores_processed: perCoreData.length,
        hostname: collector.hostname,
      });
    }

    await collector.updateHostInfo({
      last_cpu_scan: new Date(),
      cpu_count: cpuCount,
    });

    return true;
  } catch (error) {
    const shouldContinue = await collector.handleError(error, 'CPU statistics collection');
    return shouldContinue;
  } finally {
    collector.isCollecting = false;
  }
};

/**
 * Collect memory statistics
 * @returns {Promise<boolean>} Success status
 */
export const collectMemoryStats = async collector => {
  try {
    const timeout = collector.hostMonitoringConfig.performance.command_timeout * 1000;

    // Get comprehensive memory information from kstat
    const { stdout: kstatOutput } = await execProm('kstat -p unix:0:system_pages', { timeout });
    const kstatStats = parseKstatMemory(kstatOutput);

    // Debug output for kstat parsing

    // Get swap information
    const { stdout: swapOutput } = await execProm('pfexec swap -s', { timeout });
    const swapStats = parseSwapOutput(swapOutput, collector.hostname);

    // Also get memory information from Node.js os module for cross-reference
    const nodeTotalMem = os.totalmem();
    const nodeFreeMem = os.freemem();

    // Calculate memory values
    const pageSize = kstatStats.page_size_bytes || 4096;
    const totalMemoryBytes = (kstatStats.physmem_pages || 0) * pageSize;
    const freeMemoryBytes = (kstatStats.freemem_pages || 0) * pageSize;
    const availableMemoryBytes =
      (kstatStats.availrmem_pages || kstatStats.freemem_pages || 0) * pageSize;

    // Use Node.js values as fallback if kstat parsing failed
    const finalTotalBytes = totalMemoryBytes > 0 ? totalMemoryBytes : nodeTotalMem;
    const finalFreeBytes = freeMemoryBytes > 0 ? freeMemoryBytes : nodeFreeMem;
    const finalUsedBytes = finalTotalBytes - finalFreeBytes;

    // Calculate memory utilization percentage
    const memoryUtilization = finalTotalBytes > 0 ? (finalUsedBytes / finalTotalBytes) * 100 : 0;

    // Convert swap from KB to bytes
    const swapTotalBytes = (swapStats.swap_total_kb || 0) * 1024;
    const swapUsedBytes = (swapStats.swap_used_kb || 0) * 1024;
    const swapFreeBytes = swapTotalBytes - swapUsedBytes;
    const swapUtilization = swapTotalBytes > 0 ? (swapUsedBytes / swapTotalBytes) * 100 : 0;

    // Additional memory statistics from kstat
    const kernelMemoryBytes = (kstatStats.pp_kernel_pages || 0) * pageSize;

    const memoryData = {
      host: collector.hostname,
      total_memory_bytes: finalTotalBytes,
      available_memory_bytes: availableMemoryBytes,
      used_memory_bytes: finalUsedBytes,
      free_memory_bytes: finalFreeBytes,
      buffers_bytes: null, // Not easily available on OmniOS
      cached_bytes: null, // Not easily available on OmniOS
      memory_utilization_pct: memoryUtilization,
      swap_total_bytes: swapTotalBytes,
      swap_used_bytes: swapUsedBytes,
      swap_free_bytes: swapFreeBytes,
      swap_utilization_pct: swapUtilization,
      arc_size_bytes: null, // Could be collected from ZFS ARC stats
      arc_target_bytes: null,
      kernel_memory_bytes: kernelMemoryBytes,
      page_size_bytes: pageSize,
      pages_total: kstatStats.physmem_pages || Math.floor(nodeTotalMem / pageSize),
      pages_free: kstatStats.freemem_pages || Math.floor(nodeFreeMem / pageSize),
      scan_timestamp: new Date(),
    };

    // Store memory statistics
    await MemoryStats.create(memoryData);

    // Log memory collection success with statistics for monitoring
    log.monitoring.debug('Memory statistics collected', {
      total_memory_gb: (finalTotalBytes / 1024 ** 3).toFixed(1),
      used_memory_gb: (finalUsedBytes / 1024 ** 3).toFixed(1),
      swap_total_gb: (swapTotalBytes / 1024 ** 3).toFixed(1),
      memory_utilization_pct: memoryUtilization.toFixed(2),
      hostname: collector.hostname,
    });

    await collector.updateHostInfo({
      last_memory_scan: new Date(),
      total_memory_bytes: finalTotalBytes,
    });

    return true;
  } catch (error) {
    const shouldContinue = await collector.handleError(error, 'CPU statistics collection');
    return shouldContinue;
  }
};

/**
 * Collect per-zone CPU + memory (zonestat + memory_cap + bhyvectl — all
 * verified on host-1162). Disk I/O is NOT collected here: it is per-zvol and
 * only DTrace sees it (ZvolIoCollector).
 * @returns {Promise<boolean>} Success status
 */
export const collectZoneMetrics = async collector => {
  try {
    const timeout = collector.hostMonitoringConfig.performance.command_timeout * 1000;

    const [zonestatResult, memResult] = await Promise.all([
      // zonestat samples for 1 second — pad the timeout accordingly.
      execProm('pfexec zonestat -p -r summary 1 1', { timeout: timeout + 5000 }),
      execProm('kstat -p -m memory_cap', { timeout }),
    ]);

    const cpu = parseZonestatSummary(zonestatResult.stdout);
    const mem = parseZoneKstats(memResult.stdout);

    const now = new Date();
    const names = new Set([...Object.keys(cpu), ...Object.keys(mem)]);

    // bhyve guest RAM is not host-attributed in memory_cap (rss stays ~8MB
    // for a 4G guest) — bhyvectl's "Resident memory" is the real wired
    // figure (verified host-1162). Probe every non-global zone; non-bhyve /
    // not-running zones simply fail the probe and keep their memory_cap rss.
    const bhyveProbes = await Promise.all(
      [...names]
        .filter(name => name !== 'global')
        .map(async name => {
          try {
            const { stdout } = await execProm(`pfexec bhyvectl --vm=${name} --get-stats`, {
              timeout,
            });
            const match = stdout.match(/^Resident memory\s+(?<bytes>\d+)/m);
            return match ? [name, Number(match.groups.bytes)] : null;
          } catch {
            return null;
          }
        })
    );
    const bhyveRss = new Map(bhyveProbes.filter(Boolean));

    const rows = [...names].map(name => ({
      host: collector.hostname,
      zone_name: name,
      cpu_used: cpu[name]?.cpu_used ?? null,
      cpu_pct: cpu[name]?.cpu_pct ?? null,
      rss_bytes: bhyveRss.get(name) ?? (mem[name] ? Number(mem[name].rss) : null),
      swap_bytes: mem[name] ? Number(mem[name].swap) : null,
      scan_timestamp: now,
    }));

    if (rows.length > 0) {
      await ZoneMetrics.bulkCreate(rows);
    }

    log.monitoring.debug('Zone metrics collected', {
      zones: rows.length,
      hostname: collector.hostname,
    });

    return true;
  } catch (error) {
    const shouldContinue = await collector.handleError(error, 'Zone metrics collection');
    return shouldContinue;
  }
};
