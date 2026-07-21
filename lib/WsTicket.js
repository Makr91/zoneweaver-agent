/**
 * @fileoverview WebSocket Upgrade Tickets for Zoneweaver Agent
 * @description Short-lived tickets minted via the authenticated GET /ws-ticket
 *              endpoint and required as ?ticket= on every WebSocket upgrade.
 *              A ticket minted with a machine scope authorizes only that
 *              machine's streams; an unscoped ticket authorizes only
 *              host-level streams (frozen cross-agent wire). In-memory only —
 *              a restart just means the client fetches a fresh ticket.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import crypto from 'crypto';

const TICKET_TTL_MS = 60 * 1000;

/**
 * Active tickets: ticket hex → {expiresAt (ms epoch), machine (name or null)}
 * @type {Map<string, {expiresAt: number, machine: string|null}>}
 */
const tickets = new Map();

/**
 * Mint a WebSocket upgrade ticket, valid for 60 seconds and reusable within
 * the window (covers connect plus quick auto-reconnects). A machine name
 * binds the ticket to that machine's streams; null mints an unscoped ticket
 * valid only for host-level streams.
 * @param {string|null} machine - Machine name to bind the ticket to, or null
 * @returns {string} The ticket (hex)
 */
export const mintTicket = machine => {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { expiresAt: Date.now() + TICKET_TTL_MS, machine: machine || null });
  return ticket;
};

/**
 * Verify a WebSocket upgrade ticket and return its scope. Expired entries are
 * deleted lazily; valid tickets are NOT consumed (reusable within the TTL).
 * @param {string|null} ticket - Value of the ?ticket= query param
 * @returns {{machine: string|null}|null} The ticket's scope, or null if the
 *          ticket is missing, unknown, or expired
 */
export const verifyTicket = ticket => {
  if (!ticket) {
    return null;
  }

  const entry = tickets.get(ticket);
  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    tickets.delete(ticket);
    return null;
  }

  return { machine: entry.machine };
};

// Periodic sweep so abandoned tickets don't accumulate between lookups
setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (now > entry.expiresAt) {
      tickets.delete(ticket);
    }
  }
}, TICKET_TTL_MS);
