/**
 * @fileoverview Server restart endpoint
 */

import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /server/restart:
 *   post:
 *     summary: Restart the server
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
  void req;
  try {
    // Send success response immediately before initiating restart
    const response = res.json({
      success: true,
      message:
        'Server restart initiated. Please wait 30-60 seconds before reconnecting. The server will reload all configuration changes.',
    });

    // Schedule restart in detached process after response is sent
    // This ensures the HTTP response is delivered before the process is terminated
    setTimeout(() => {
      log.app.warn('Initiating server restart via SMF');

      // Import exec here to avoid loading it at module level
      import('child_process')
        .then(({ exec }) => {
          // Use pfexec to restart the SMF service in a detached process
          exec(
            'pfexec svcadm restart system/virtualization/zoneweaver-agent',
            {
              detached: true,
              stdio: 'ignore',
            },
            (error, _stdout, _stderr) => {
              void _stdout;
              void _stderr;
              // This callback likely won't execute since the process will be killed
              // but we include it for completeness
              if (error) {
                log.app.error('Restart command error', {
                  error: error.message,
                });
              }
            }
          );
        })
        .catch(err => {
          log.app.error('Failed to import child_process for restart', {
            error: err.message,
          });
        });
    }, 1000); // 1 second delay to ensure HTTP response is fully sent

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
