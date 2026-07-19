/**
 * @fileoverview QEMU Guest Agent client over bhyve virtio-console
 * @description Speaks the QGA protocol on the zone's virtio-console socket
 * (<zonepath>/root/tmp/qga.sock — the `-s 9,virtio-console` extra attr; needs
 * the r151054az bhyve fix for Windows guests and stale-socket reboots).
 * Wire: newline-terminated JSON both ways. Every exchange opens the socket
 * fresh, resynchronizes with guest-sync-delimited (the 0xFF sentinel flushes
 * any stale partial line), runs ONE command, and closes. The channel takes
 * exactly one client, so access is serialized per socket.
 */

import net from 'net';
import path from 'path';
import config from '../config/ConfigLoader.js';
import { executeCommand } from './CommandManager.js';
import { readZonecfgAttr } from './ZoneConfigUtils.js';

export const QGA_EXTRA_VALUE = '-s 9,virtio-console,org.qemu.guest_agent.0=/tmp/qga.sock';

export const isGuestAgentEnabled = () => Boolean(config.get('guest_agent.enabled'));

export const guestSocketPath = zonepath => path.join(zonepath, 'root', 'tmp', 'qga.sock');

const joinAttrValue = value => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter(part => typeof part === 'string').join(' ');
  }
  return '';
};

/**
 * Read the zone's `extra` attr from a zadm-shaped config — zadm surfaces
 * brand-known attrs top-level (string OR array rendering) and everything else
 * in the attr array. Display/knob reads only; the channel toggle's
 * add-vs-select decision rides readExtraAttr (zonecfg truth) instead.
 * @param {Object} liveConfig - zadm show output
 * @returns {string} The extra attr value ('' when absent)
 */
export const readExtraValue = liveConfig => {
  const topLevel = joinAttrValue(liveConfig?.extra);
  if (topLevel) {
    return topLevel;
  }
  if (Array.isArray(liveConfig?.attr)) {
    const entry = liveConfig.attr.find(a => a?.name === 'extra');
    if (entry) {
      return joinAttrValue(entry.value);
    }
  }
  return '';
};

/**
 * Read the `extra` attr straight from zonecfg — the same store the channel
 * toggle writes. The add-vs-select decision MUST ride this, never zadm's JSON
 * rendering: zadm hid an existing attr on at least one shape and the toggle
 * then ran a blind `add attr` that zonecfg refused ("attr resource with the
 * name 'extra' already exists").
 * @param {string} zoneName - Zone name
 * @returns {Promise<{exists: boolean, value: string}>} Attr presence + value
 */
export const readExtraAttr = zoneName => readZonecfgAttr(zoneName, 'extra');

/**
 * Whether the config carries the guest-agent virtio-console channel.
 * @param {Object} liveConfig - zadm show output
 * @returns {boolean}
 */
export const hasGuestAgentChannel = liveConfig =>
  readExtraValue(liveConfig).includes('virtio-console');

const channelQueues = new Map();

const runExclusive = (key, fn) => {
  const previous = channelQueues.get(key) || Promise.resolve();
  const next = previous.then(fn, fn);
  channelQueues.set(
    key,
    next.catch(() => {})
  );
  return next;
};

const SYNC_SENTINEL = 0xff;

const exchange = (socketPath, execute, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const syncId = Date.now() & 0x7fffffff;
    let buffer = Buffer.alloc(0);
    let stage = 'sync-sentinel';
    let delivered = false;
    let settled = false;
    let timer = null;

    const finish = (err, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    timer = setTimeout(() => {
      // Delivered but unanswered is guest-shutdown's normal exit.
      finish(delivered ? null : new Error('guest agent did not answer'), { noReply: true });
    }, timeoutMs);

    const takeLine = () => {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        return null;
      }
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      return line;
    };

    const handleSyncLine = line => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(new Error(`guest-sync answered unparseable line: ${line.trim()}`));
        return;
      }
      if (parsed.return !== syncId) {
        finish(new Error(`guest-sync answered ${line.trim()} (want id ${syncId})`));
        return;
      }
      const request = { execute };
      if (args) {
        request.arguments = args;
      }
      socket.write(`${JSON.stringify(request)}\n`);
      delivered = true;
      stage = 'reply';
    };

    const handleReplyLine = line => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        finish(new Error(`parse guest answer ${line.trim()}: ${err.message}`));
        return;
      }
      if (parsed.error) {
        finish(new Error(`guest agent error (${parsed.error.class}): ${parsed.error.desc}`));
        return;
      }
      finish(null, { reply: parsed.return });
    };

    socket.on('connect', () => {
      const syncRequest = JSON.stringify({
        execute: 'guest-sync-delimited',
        arguments: { id: syncId },
      });
      socket.write(Buffer.concat([Buffer.from([SYNC_SENTINEL]), Buffer.from(`${syncRequest}\n`)]));
    });

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'sync-sentinel') {
        const sentinel = buffer.indexOf(SYNC_SENTINEL);
        if (sentinel < 0) {
          buffer = Buffer.alloc(0);
          return;
        }
        buffer = buffer.subarray(sentinel + 1);
        stage = 'sync-line';
      }
      if (stage === 'sync-line') {
        const line = takeLine();
        if (line === null) {
          return;
        }
        handleSyncLine(line);
      }
      if (stage === 'reply') {
        const line = takeLine();
        if (line !== null) {
          handleReplyLine(line);
        }
      }
    });

    const closeOut = err => {
      if (delivered) {
        finish(null, { noReply: true });
      } else {
        finish(err || new Error('guest agent channel closed before answering'));
      }
    };
    socket.on('error', closeOut);
    socket.on('close', () => closeOut());
  });

export const runGuestCommand = (socketPath, execute, args = null, timeoutMs = 5000) =>
  runExclusive(socketPath, async () => {
    // bhyve mints the socket root-owned each boot; the agent runs unprivileged.
    await executeCommand(`pfexec chmod 666 ${socketPath}`);
    return exchange(socketPath, execute, args, timeoutMs);
  });

/**
 * Run a guest command via guest-exec and wait for its exit — stdout/stderr
 * decoded from base64. path/args ride verbatim (shell selection is the
 * caller's).
 * @param {string} socketPath - qga socket
 * @param {string} path - Guest executable
 * @param {string[]} args - Arguments
 * @param {number} timeoutMs - Total wait for exit
 * @returns {Promise<{exitcode: number|null, stdout: string, stderr: string}>}
 */
export const guestExecAndWait = async (socketPath, path, args, timeoutMs = 120000) => {
  const started = await runGuestCommand(
    socketPath,
    'guest-exec',
    { path, arg: args, 'capture-output': true },
    10000
  );
  const pid = started.reply?.pid;
  if (typeof pid !== 'number') {
    throw new Error('guest-exec answered no pid');
  }
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const outcome = await runGuestCommand(socketPath, 'guest-exec-status', { pid }, 5000);
    const reply = outcome.reply || {};
    if (reply.exited) {
      return {
        exitcode: typeof reply.exitcode === 'number' ? reply.exitcode : null,
        stdout: reply['out-data'] ? Buffer.from(reply['out-data'], 'base64').toString('utf8') : '',
        stderr: reply['err-data'] ? Buffer.from(reply['err-data'], 'base64').toString('utf8') : '',
      };
    }
    if (Date.now() > deadline) {
      throw new Error(`guest-exec pid ${pid} did not exit within ${timeoutMs}ms`);
    }
    await new Promise(resolve => {
      setTimeout(resolve, 1000);
    });
    return poll();
  };
  return poll();
};

/**
 * Write a guest file whole via guest-file-open/write/close (mode w —
 * truncate-and-write).
 * @param {string} socketPath - qga socket
 * @param {string} destPath - Guest file path
 * @param {string} content - File content
 * @returns {Promise<void>}
 */
export const guestFileWrite = async (socketPath, destPath, content) => {
  const opened = await runGuestCommand(socketPath, 'guest-file-open', { path: destPath, mode: 'w' }, 5000);
  const handle = opened.reply;
  if (typeof handle !== 'number') {
    throw new Error(`guest-file-open answered no handle for ${destPath}`);
  }
  try {
    await runGuestCommand(
      socketPath,
      'guest-file-write',
      { handle, 'buf-b64': Buffer.from(content, 'utf8').toString('base64') },
      10000
    );
  } finally {
    await runGuestCommand(socketPath, 'guest-file-close', { handle }, 5000).catch(() => {});
  }
};

export const guestIPv4s = async (socketPath, timeoutMs = 3000) => {
  const outcome = await runGuestCommand(
    socketPath,
    'guest-network-get-interfaces',
    null,
    timeoutMs
  );
  if (outcome.noReply) {
    throw new Error('guest agent sent no reply');
  }
  const ips = [];
  for (const iface of outcome.reply || []) {
    for (const addr of iface['ip-addresses'] || []) {
      const address = addr['ip-address'] || '';
      if (
        addr['ip-address-type'] !== 'ipv4' ||
        !address ||
        address === '0.0.0.0' ||
        address.startsWith('127.')
      ) {
        continue;
      }
      ips.push(address);
    }
  }
  return ips;
};
