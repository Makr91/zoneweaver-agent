import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS pool query controllers - list, details, status
 */

/**
 * @swagger
 * /storage/pools:
 *   get:
 *     summary: List ZFS pools
 *     description: Retrieves a list of all ZFS storage pools
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Pools retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pools:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       size:
 *                         type: string
 *                       alloc:
 *                         type: string
 *                       free:
 *                         type: string
 *                       capacity_percent:
 *                         type: string
 *                       dedup_ratio:
 *                         type: string
 *                       health:
 *                         type: string
 *                       altroot:
 *                         type: string
 *                         nullable: true
 *                 total:
 *                   type: integer
 */
export const listPools = async (req, res) => {
  void req;
  try {
    const result = await executeCommand(
      'pfexec zpool list -H -p -o name,size,alloc,free,cap,dedup,health,altroot'
    );

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list pools',
        details: result.error,
      });
    }

    const pools = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, size, alloc, free, cap, dedup, health, altroot] = line.split('\t');
        return {
          name,
          size,
          alloc,
          free,
          capacity_percent: cap,
          dedup_ratio: dedup,
          health,
          altroot: altroot === '-' ? null : altroot,
        };
      });

    return res.json({
      pools,
      total: pools.length,
    });
  } catch (error) {
    log.api.error('Error listing pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list pools',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}:
 *   get:
 *     summary: Get pool details
 *     description: Retrieves all properties for a specific ZFS pool
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 properties:
 *                   type: object
 *                   description: Map of zpool property name to { value, source }
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       value:
 *                         type: string
 *                       source:
 *                         type: string
 *       404:
 *         description: Pool not found
 */
export const getPoolDetails = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    // Flags MUST precede the property operand — `zpool get all -H -p <pool>`
    // parses -H as a pool name and fails, which answered 404 for every real pool.
    const result = await executeCommand(`pfexec zpool get -H -p all ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    const properties = {};
    result.output.split('\n').forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const [, prop, value, source] = parts;
        properties[prop] = { value, source };
      }
    });

    return res.json({
      name: pool,
      properties,
    });
  } catch (error) {
    log.api.error('Error getting pool details', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool details',
      details: error.message,
    });
  }
};

const VDEV_GROUP_PATTERN = /^(?:mirror|raidz|draid|spare)/u;
const VDEV_CLASS_WORDS = ['logs', 'cache', 'spares', 'special', 'dedup'];

/**
 * Parse one config-tree row into the wire device shape.
 * @param {string} line - Raw config line
 * @returns {{indent: number, row: Object}}
 */
const parseVdevRow = line => {
  const indent = line.length - line.trimStart().length;
  const [name, state, read, write, cksum, ...noteParts] = line.trim().split(/\s+/u);
  return {
    indent,
    row: {
      name,
      state: state ?? null,
      read: read ?? null,
      write: write ?? null,
      cksum: cksum ?? null,
      note: noteParts.length > 0 ? noteParts.join(' ') : null,
    },
  };
};

/**
 * Parse the `config:` tree into wire vdev rows — depth-relative to the pool
 * row: depth 1 = a vdev group (mirror/raidz/draid/spare, or the logs/cache/
 * spares/special/dedup class words) or a bare top-level disk (its own
 * single-device vdev); anything deeper belongs to the current vdev.
 * @param {string[]} lines - Raw status lines
 * @returns {Array<{type: string, state: string|null, devices: Array}>}
 */
const parseVdevTree = lines => {
  const headerIndex = lines.findIndex(line =>
    /^\s*NAME\s+STATE\s+READ\s+WRITE\s+CKSUM/u.test(line)
  );
  if (headerIndex === -1) {
    return [];
  }
  const vdevs = [];
  let poolIndent = null;
  let current = null;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*errors:/u.test(line)) {
      break;
    }
    const { indent, row } = parseVdevRow(line);
    if (poolIndent === null) {
      poolIndent = indent;
      continue;
    }
    if (indent <= poolIndent + 2) {
      const isGroup = VDEV_GROUP_PATTERN.test(row.name) || VDEV_CLASS_WORDS.includes(row.name);
      current = {
        type: isGroup ? row.name : 'disk',
        state: row.state,
        devices: isGroup ? [] : [row],
      };
      vdevs.push(current);
    } else if (current) {
      current.devices.push(row);
    }
  }
  return vdevs;
};

/**
 * Parse the `scan:` section into {action, pct} — non-null ONLY while a scrub
 * or resilver is in progress; a completed/canceled scan answers null.
 * @param {string[]} lines - Raw status lines
 * @returns {{action: string, pct: number|null}|null}
 */
const parseScanProgress = lines => {
  const scanIndex = lines.findIndex(line => line.trim().startsWith('scan:'));
  if (scanIndex === -1) {
    return null;
  }
  const sectionText = [];
  for (let i = scanIndex; i < lines.length; i++) {
    if (i > scanIndex && /^\s*(?:config|errors|status|action|see)\s*:/u.test(lines[i])) {
      break;
    }
    sectionText.push(lines[i]);
  }
  const text = sectionText.join(' ').replace(/^\s*scan:\s*/u, '');
  if (!text.includes('in progress')) {
    return null;
  }
  const pctMatch = /(?<pct>\d+(?:\.\d+)?)% done/u.exec(text);
  return {
    action: text.split(/\s+/u)[0],
    pct: pctMatch ? Number(pctMatch.groups.pct) : null,
  };
};

/**
 * @swagger
 * /storage/pools/{pool}/status:
 *   get:
 *     summary: Get pool status
 *     description: |
 *       Retrieves detailed status information for a ZFS pool. The raw
 *       `zpool status` text rides in `status` (debug field), and the agent's
 *       OWN parse rides beside it in `parsed` (the structured-JSON ruling —
 *       the UI never regex-parses raw command text): the vdev tree
 *       depth-resolved into vdevs[].devices[], and scan progress non-null
 *       only while a scrub/resilver is running.
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 status:
 *                   type: string
 *                   description: Raw `zpool status` output (vdev tree, scan status, errors)
 *                 parsed:
 *                   type: object
 *                   properties:
 *                     vdevs:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type:
 *                             type: string
 *                             description: mirror-N/raidzN-M/draid/spare group name, a class word (logs, cache, spares, special, dedup), or "disk" for a bare top-level device
 *                           state:
 *                             type: string
 *                             nullable: true
 *                           devices:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 name:
 *                                   type: string
 *                                 state:
 *                                   type: string
 *                                   nullable: true
 *                                 read:
 *                                   type: string
 *                                   nullable: true
 *                                 write:
 *                                   type: string
 *                                   nullable: true
 *                                 cksum:
 *                                   type: string
 *                                   nullable: true
 *                                 note:
 *                                   type: string
 *                                   nullable: true
 *                                   description: Trailing annotation (resilvering, was /dev/..., etc.)
 *                     scan:
 *                       type: object
 *                       nullable: true
 *                       description: Non-null only while a scrub/resilver is IN PROGRESS
 *                       properties:
 *                         action:
 *                           type: string
 *                           example: "scrub"
 *                         pct:
 *                           type: number
 *                           nullable: true
 *       404:
 *         description: Pool not found
 */
export const getPoolStatus = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool status ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    const lines = result.output.split('\n');
    return res.json({
      name: pool,
      status: result.output,
      parsed: {
        vdevs: parseVdevTree(lines),
        scan: parseScanProgress(lines),
      },
    });
  } catch (error) {
    log.api.error('Error getting pool status', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool status',
      details: error.message,
    });
  }
};
