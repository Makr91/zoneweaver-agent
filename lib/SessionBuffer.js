import { log } from './Logger.js';

/**
 * @fileoverview Debounced session_buffer writer for console sessions
 * @description Console output previously hit the DB once per output chunk.
 * This buffers in memory (last MAX_LINES lines) and flushes on an interval
 * and on close — reconnect-replay still reads the flushed column.
 */

const FLUSH_INTERVAL_MS = 2000;
const MAX_LINES = 1000;

export const createSessionBufferWriter = session => {
  let buffer = session.session_buffer || '';
  let dirty = false;
  let timer = null;
  let closed = false;

  const flush = async () => {
    timer = null;
    if (!dirty) {
      return;
    }
    dirty = false;
    try {
      await session.update({ session_buffer: buffer, last_activity: new Date() });
    } catch (error) {
      log.websocket.error('Error flushing session buffer', {
        session_id: session.id,
        error: error.message,
      });
    }
  };

  const schedule = () => {
    dirty = true;
    if (!timer && !closed) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  };

  return {
    append(text) {
      buffer = (buffer + text).split('\n').slice(-MAX_LINES).join('\n');
      schedule();
    },
    touch() {
      schedule();
    },
    async close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
};
