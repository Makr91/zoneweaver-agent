/**
 * @fileoverview VNC framebuffer screenshot capture (zero-dependency)
 * @description Captures a single frame from a bhyve zone's VNC framebuffer by
 *   connecting directly to its RFB unix socket (<zoneroot>/tmp/vm.vnc), doing the
 *   RFB 3.8 handshake, requesting one full (non-incremental) framebuffer update,
 *   reading the Raw-encoded rectangle, and encoding it to PNG. Pure Node — only
 *   `net` and `zlib`, no external packages. This is a Node port of the manually
 *   validated RFB capture sequence; bhyve serves a 32bpp framebuffer.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import net from 'net';
import zlib from 'zlib';

/**
 * Minimal buffered reader over a socket. `read(n)` resolves with exactly n bytes
 * once that many have arrived (RFB is a strict request/response byte protocol).
 */
class SocketReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    socket.on('data', data => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this._flush();
    });
  }

  read(n) {
    return new Promise(resolve => {
      this.pending = { n, resolve };
      this._flush();
    });
  }

  _flush() {
    if (!this.pending || this.buffer.length < this.pending.n) {
      return;
    }
    const { n, resolve } = this.pending;
    this.pending = null;
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    resolve(out);
  }
}

// CRC32 (PNG chunks) — table-based, version-proof (no reliance on zlib.crc32).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode a tightly-packed RGB buffer to a PNG (color type 2, 8-bit).
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgb - width*height*3 bytes
 * @returns {Buffer} PNG file bytes
 */
const encodePng = (width, height, rgb) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // bytes 10-12 (compression, filter, interlace) left 0

  const stride = width * 3;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter type "none"
    rgb.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(filtered)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

/**
 * Convert one raw RFB framebuffer rectangle into a packed RGB buffer using the
 * server's advertised pixel format (shifts + maxes). Handles 8/16/32 bpp.
 */
const rawToRgb = (pixels, width, height, format) => {
  const { bytesPerPixel, bigEndian, redShift, greenShift, blueShift, redMax, greenMax, blueMax } =
    format;
  const rgb = Buffer.alloc(width * height * 3);
  const scale = (value, max) => (max === 255 ? value : Math.round((value * 255) / max));
  for (let p = 0; p < width * height; p++) {
    const i = p * bytesPerPixel;
    let px;
    if (bytesPerPixel === 4) {
      px = bigEndian ? pixels.readUInt32BE(i) : pixels.readUInt32LE(i);
    } else if (bytesPerPixel === 2) {
      px = bigEndian ? pixels.readUInt16BE(i) : pixels.readUInt16LE(i);
    } else {
      px = pixels[i];
    }
    rgb[p * 3] = scale((px >>> redShift) & redMax, redMax);
    rgb[p * 3 + 1] = scale((px >>> greenShift) & greenMax, greenMax);
    rgb[p * 3 + 2] = scale((px >>> blueShift) & blueMax, blueMax);
  }
  return rgb;
};

/**
 * Capture a single frame from a VNC server listening on a unix socket and return
 * it as PNG bytes.
 * @param {string} socketPath - Path to the RFB unix socket (e.g. .../tmp/vm.vnc)
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=10000] - Overall capture timeout
 * @returns {Promise<Buffer>} PNG file bytes
 */
export const captureVncFrame = (socketPath, options = {}) => {
  const timeoutMs = options.timeoutMs || 10000;

  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    const reader = new SocketReader(socket);
    let settled = false;
    let timer = null;

    const finish = (err, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    timer = setTimeout(() => finish(new Error('VNC capture timed out')), timeoutMs);
    socket.on('error', err => finish(err));
    socket.on('close', () => finish(new Error('VNC socket closed before a frame was captured')));

    const run = async () => {
      await reader.read(12); // ProtocolVersion (e.g. "RFB 003.008\n")
      socket.write('RFB 003.008\n');

      const [secCount] = await reader.read(1);
      if (secCount === 0) {
        throw new Error('VNC server rejected the connection (no security types offered)');
      }
      const secTypes = await reader.read(secCount);
      if (!secTypes.includes(1)) {
        throw new Error('VNC server requires authentication (no "None" security type)');
      }
      socket.write(Buffer.from([1])); // choose security type: None
      const secResult = await reader.read(4);
      if (secResult.readUInt32BE(0) !== 0) {
        throw new Error('VNC security handshake failed');
      }

      socket.write(Buffer.from([1])); // ClientInit: shared
      const init = await reader.read(24); // ServerInit (before the desktop name)
      const fbWidth = init.readUInt16BE(0);
      const fbHeight = init.readUInt16BE(2);
      const format = {
        bytesPerPixel: init[4] / 8,
        bigEndian: init[6] !== 0,
        redMax: init.readUInt16BE(8),
        greenMax: init.readUInt16BE(10),
        blueMax: init.readUInt16BE(12),
        redShift: init[14],
        greenShift: init[15],
        blueShift: init[16],
      };
      const nameLen = init.readUInt32BE(20);
      if (nameLen > 0) {
        await reader.read(nameLen); // consume desktop name
      }
      if (!fbWidth || !fbHeight) {
        throw new Error('VNC server reported an empty framebuffer');
      }

      // FramebufferUpdateRequest: type=3, incremental=0, full screen
      const request = Buffer.alloc(10);
      request[0] = 3;
      request[1] = 0;
      request.writeUInt16BE(0, 2);
      request.writeUInt16BE(0, 4);
      request.writeUInt16BE(fbWidth, 6);
      request.writeUInt16BE(fbHeight, 8);
      socket.write(request);

      const updateHeader = await reader.read(4); // msgType(1) pad(1) numRects(2)
      if (updateHeader[0] !== 0) {
        throw new Error(`Unexpected VNC message type ${updateHeader[0]}`);
      }
      const numRects = updateHeader.readUInt16BE(2);
      if (numRects === 0) {
        throw new Error('VNC server sent no framebuffer rectangles');
      }

      // For a non-incremental full request the server sends the whole screen as
      // one Raw rectangle.
      const rectHeader = await reader.read(12); // x(2) y(2) w(2) h(2) encoding(4)
      const rectWidth = rectHeader.readUInt16BE(4);
      const rectHeight = rectHeader.readUInt16BE(6);
      const encoding = rectHeader.readInt32BE(8);
      if (encoding !== 0) {
        throw new Error(`Unsupported VNC encoding ${encoding} (only Raw is supported)`);
      }

      const pixels = await reader.read(rectWidth * rectHeight * format.bytesPerPixel);
      const rgb = rawToRgb(pixels, rectWidth, rectHeight, format);
      finish(null, encodePng(rectWidth, rectHeight, rgb));
    };

    run().catch(finish);
  });
};
