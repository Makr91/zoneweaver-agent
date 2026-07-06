/**
 * @fileoverview VNC Screenshot Controller
 * @description Captures a single frame from a zone's bhyve framebuffer socket
 *   (<zonepath>/root/tmp/vm.vnc) and returns it as PNG. The socket exists
 *   whenever a UEFI bhyve zone is running, so this yields a console thumbnail
 *   without an active VNC session. Capture runs through the existing pfexec
 *   command tooling because the zone root is root-only.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { executeCommand } from '../../lib/CommandManager.js';
import { validateZoneName } from './utils/VncValidation.js';
import { errorResponse } from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * Absolute path to the privileged capture CLI.
 */
const SCREENSHOT_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../lib/vncScreenshotCli.js'
);

/**
 * Capture timeout (ms) for the privileged child.
 */
const SCREENSHOT_TIMEOUT_MS = 20000;

/**
 * Resolve a zone's RFB unix socket path from its live zonepath.
 * `pfexec zoneadm -z <zone> list -p` →
 *   zoneid:zonename:state:zonepath:uuid:brand:ip-type:...
 * @param {string} zoneName
 * @returns {Promise<string|null>} Socket path, or null if the zone/zonepath is unavailable
 */
const resolveVncSocketPath = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
  if (!result.success || !result.output) {
    return null;
  }
  const [, , , zonepath] = result.output.split(':');
  return zonepath ? `${zonepath}/root/tmp/vm.vnc` : null;
};

/**
 * @swagger
 * /machines/{machineName}/vnc/screenshot:
 *   get:
 *     summary: Capture a VNC console screenshot
 *     description: Captures a single frame from the machine's bhyve framebuffer and returns it as PNG. Works without an active VNC session as long as the machine is running.
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: PNG screenshot
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Invalid machine name
 *       404:
 *         description: Machine not found or zonepath unavailable
 *       502:
 *         description: Failed to capture screenshot
 */
export const getVncScreenshot = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    const socketPath = await resolveVncSocketPath(zoneName);
    if (!socketPath) {
      return errorResponse(res, 404, 'Zone not found or zonepath unavailable');
    }

    const result = await executeCommand(
      `pfexec "${process.execPath}" "${SCREENSHOT_CLI}" "${socketPath}"`,
      SCREENSHOT_TIMEOUT_MS
    );

    if (!result.success || !result.output) {
      return errorResponse(res, 502, 'Failed to capture VNC screenshot', result.error);
    }

    const png = Buffer.from(result.output, 'base64');

    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    return res.send(png);
  } catch (error) {
    log.websocket.error('VNC screenshot capture failed', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return errorResponse(res, 502, 'Failed to capture VNC screenshot', error.message);
  }
};
