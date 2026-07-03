/**
 * @fileoverview WebSocket Upgrade Tickets for Zoneweaver Agent
 * @description Short-lived unbound tickets minted via the authenticated
 *              GET /ws-ticket endpoint and required as ?ticket= on every
 *              WebSocket upgrade (Phase H hardening). In-memory only — a
 *              restart just means the client fetches a fresh ticket.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import crypto from 'crypto';

const TICKET_TTL_MS = 60 * 1000;

/**
 * Active tickets: ticket hex → expiry timestamp (ms epoch)
 * @type {Map<string, number>}
 */
const tickets = new Map();

/**
 * Mint an unbound WebSocket upgrade ticket, valid for 60 seconds and reusable
 * within the window (covers connect plus quick auto-reconnects).
 * @returns {string} The ticket (hex)
 */
export const mintTicket = () => {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, Date.now() + TICKET_TTL_MS);
  return ticket;
};

/**
 * Verify a WebSocket upgrade ticket. Expired entries are deleted lazily;
 * valid tickets are NOT consumed (reusable within the TTL).
 * @param {string|null} ticket - Value of the ?ticket= query param
 * @returns {boolean} True if the ticket is present and unexpired
 */
export const verifyTicket = ticket => {
  if (!ticket) {
    return false;
  }

  const expiresAt = tickets.get(ticket);
  if (!expiresAt) {
    return false;
  }

  if (Date.now() > expiresAt) {
    tickets.delete(ticket);
    return false;
  }

  return true;
};

// Periodic sweep so abandoned tickets don't accumulate between lookups
setInterval(() => {
  const now = Date.now();
  for (const [ticket, expiresAt] of tickets) {
    if (now > expiresAt) {
      tickets.delete(ticket);
    }
  }
}, TICKET_TTL_MS);
