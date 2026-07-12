import config from '../config/ConfigLoader.js';

/**
 * @fileoverview Help & Support ticket-link config feed — the Server's public
 * GET /api/config/ticket served from this agent (Go agent parity), so Direct
 * mode renders the same profile-dropdown link. The UI consumes BoxVault's
 * {value}-wrapped field shape and builds
 * base_url&req=<req_type>&customerId=&user=&email=&context=<context>;
 * it renders the link only when enabled AND base_url are set.
 */

/**
 * Effective values when ticket_system is absent from config.yaml (mirrors the
 * settings schema defaults).
 */
const TICKET_DEFAULTS = {
  enabled: true,
  base_url: 'https://xd.prominic.net/app/apprequest.nsf/router?openagent',
  req_type: 'sso',
  context: 'https://github.com/Makr91/zoneweaver-agent',
};

/**
 * @swagger
 * /api/config/ticket:
 *   get:
 *     summary: Get ticket system configuration
 *     description: |
 *       Public feed for the Help & Support link (no authentication — the UI
 *       fetches it before sign-in, exactly like the Hyperweaver Server's).
 *       Fields use BoxVault's {value}-wrapped shape.
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Ticket system configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ticket_system:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: object
 *                       properties:
 *                         value:
 *                           type: boolean
 *                     base_url:
 *                       type: object
 *                       properties:
 *                         value:
 *                           type: string
 *                     req_type:
 *                       type: object
 *                       properties:
 *                         value:
 *                           type: string
 *                     context:
 *                       type: object
 *                       properties:
 *                         value:
 *                           type: string
 */
export const getTicketConfig = (req, res) => {
  void req;
  const ticket = { ...TICKET_DEFAULTS, ...(config.get('ticket_system') || {}) };
  return res.json({
    ticket_system: {
      enabled: { value: ticket.enabled },
      base_url: { value: ticket.base_url },
      req_type: { value: ticket.req_type },
      context: { value: ticket.context },
    },
  });
};
