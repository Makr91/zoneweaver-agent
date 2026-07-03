/**
 * @fileoverview Privileged VNC screenshot CLI
 * @description Captures a single frame from a bhyve zone's RFB unix socket and
 *   writes it to stdout as base64-encoded PNG. Run via the existing pfexec
 *   command tooling (executeCommand) because the zone root —
 *   <zonepath>/root/tmp/vm.vnc — is root-only. base64 keeps the image intact
 *   over the command runner's text stdout capture.
 *
 *   Usage: pfexec <node> lib/vncScreenshotCli.js <socketPath>
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { captureVncFrame } from './VncScreenshot.js';

const [, , socketPath] = process.argv;

if (!socketPath) {
  process.stderr.write('Usage: vncScreenshotCli.js <socketPath>\n');
  process.exit(2);
}

captureVncFrame(socketPath, { timeoutMs: 10000 })
  .then(png => {
    process.stdout.write(png.toString('base64'), () => {
      process.exit(0);
    });
  })
  .catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
