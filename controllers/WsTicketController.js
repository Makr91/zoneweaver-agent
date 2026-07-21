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
 *       WebSocket upgrade URL. Without `machine`, the ticket is UNSCOPED and authorizes
 *       host-level streams only: the host terminal, log streams, and task output streams
 *       of non-machine tasks. With `machine`, the ticket is bound to that machine and
 *       authorizes only that machine's streams: VNC, zlogin, SSH, and its task output
 *       streams. A scope mismatch at upgrade is rejected exactly like an invalid ticket
 *       (frozen cross-agent wire). Tickets are reusable within their lifetime — fetch a
 *       fresh ticket before each WebSocket connect or reconnect.
 *     tags: [WebSocket Tickets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: machine
 *         required: false
 *         schema:
 *           type: string
 *         description: Machine name to bind the ticket to (verbatim). Omit for an unscoped host-level ticket.
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
  const machine =
    typeof req.query.machine === 'string' && req.query.machine ? req.query.machine : null;
  return res.json({ ticket: mintTicket(machine) });
};
