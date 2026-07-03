/**
 * @fileoverview WebSocket Ticket Controller for Zoneweaver Agent
 * @description Mints the short-lived tickets that authorize WebSocket upgrades.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { mintTicket } from '../lib/WsTicket.js';

/**
 * @swagger
 * /ws-ticket:
 *   get:
 *     summary: Mint a WebSocket upgrade ticket
 *     description: |
 *       Returns a short-lived (60s) ticket that must be appended as `?ticket=` to every
 *       WebSocket upgrade URL (terminal, zlogin, SSH, log stream, task stream, VNC).
 *       Tickets are unbound — any valid unexpired ticket authorizes any upgrade — and
 *       reusable within their lifetime. Fetch a fresh ticket before each WebSocket
 *       connect or reconnect.
 *     tags: [WebSocket Tickets]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Ticket minted successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ticket:
 *                   type: string
 *                   description: Hex ticket valid for 60 seconds
 *                   example: "9f2c4a...64 hex chars"
 */
export const getWsTicket = (req, res) => {
  void req;
  return res.json({ ticket: mintTicket() });
};
