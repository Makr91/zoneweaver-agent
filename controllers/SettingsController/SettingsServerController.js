/**
 * @fileoverview Server restart endpoint
 */

import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /server/restart:
 *   post:
 *     summary: Restart the server
 *     description: |
 *       Answers immediately, then exits the process — SMF's restarter brings
 *       the service back up with the reloaded configuration. No
 *       self-referencing svcadm call (a service restarting itself races its
 *       own contract kill); boot recovery closes out any in-flight tasks.
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Server restart initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       500:
 *         description: Failed to initiate server restart
 */
export const restartServer = (req, res) => {
  try {
    log.app.warn('Server restart requested — exiting for SMF-driven restart', {
      user: req.entity.name,
    });

    const response = res.json({
      success: true,
      message:
        'Server restart initiated. Please wait 30-60 seconds before reconnecting. The server will reload all configuration changes.',
    });

    // Exit after the response flushes; SMF restarts the service.
    setTimeout(() => {
      process.exit(0);
    }, 1000);

    return response;
  } catch (error) {
    log.api.error('Error initiating server restart', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to initiate server restart',
      details: error.message,
    });
  }
};
