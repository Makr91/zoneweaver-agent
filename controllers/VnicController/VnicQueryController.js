/**
 * @fileoverview VNIC query operations
 */

import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import os from 'os';
import { log } from '../../lib/Logger.js';
import { executeCommand } from '../../lib/CommandManager.js';

/**
 * @swagger
 * /network/vnics:
 *   get:
 *     summary: List VNICs
 *     description: Returns VNIC information from monitoring data or live system query
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: over
 *         schema:
 *           type: string
 *         description: Filter by underlying physical link
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone assignment
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [up, down, unknown]
 *         description: Filter by VNIC state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of VNICs to return
 *     responses:
 *       200:
 *         description: VNICs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnics:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkInterface'
 *                 returned:
 *                   type: integer
 *                   description: Number of records in this response
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get VNICs
 */
export const getVNICs = async (req, res) => {
  const { over, zone, state, limit = 100 } = req.query;

  try {
    // Always get data from database (monitoring data)
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'vnic',
    };

    if (over) {
      whereClause.over = over;
    }
    if (zone) {
      whereClause.zone = zone;
    }
    if (state) {
      whereClause.state = state;
    }

    // Optimize: Remove expensive COUNT query, only include existing columns
    const rows = await NetworkInterfaces.findAll({
      where: whereClause,
      attributes: [
        'id',
        'link',
        'class',
        'state',
        'zone',
        'over',
        'speed',
        'duplex',
        'scan_timestamp',
        'vid',
        'macaddress',
        'macaddrtype',
        'mtu',
        'flags',
      ], // Only include columns that exist in database
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      vnics: rows,
      source: 'database',
      returned: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting VNICs', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNICs',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}:
 *   get:
 *     summary: Get VNIC details
 *     description: Returns detailed information about a specific VNIC
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *     responses:
 *       200:
 *         description: VNIC details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NetworkInterface'
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC details
 */
export const getVNICDetails = async (req, res) => {
  const { vnic } = req.params;

  try {
    // Always get data from database
    const hostname = os.hostname();
    const vnicData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: vnic,
        class: 'vnic',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!vnicData) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found`,
      });
    }

    return res.json(vnicData);
  } catch (error) {
    log.api.error('Error getting VNIC details', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vnics/{vnic}/stats:
 *   get:
 *     summary: Get VNIC statistics
 *     description: |
 *       Live cumulative counters for a VNIC, from `dladm show-link -s`. (NOT
 *       `show-vnic -s`: that subcommand has no ipackets/rbytes/ierrors/… fields
 *       at all — it answers "unknown output fields" and this endpoint returned
 *       zeros for every VNIC. show-link's stat table carries them and accepts a
 *       VNIC as its link, verified on host-1162.)
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *     responses:
 *       200:
 *         description: |
 *           A single snapshot of the link's CUMULATIVE counters (since the link came up).
 *           To chart a rate, take two snapshots and difference them — this endpoint does
 *           not sample. (It previously advertised an `interval` query parameter and echoed
 *           it back as if it had; it never sampled, so the parameter is gone rather than
 *           left lying.)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 statistics:
 *                   type: object
 *                   properties:
 *                     link:
 *                       type: string
 *                     ipackets:
 *                       type: integer
 *                     rbytes:
 *                       type: integer
 *                     ierrors:
 *                       type: integer
 *                     opackets:
 *                       type: integer
 *                     obytes:
 *                       type: integer
 *                     oerrors:
 *                       type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC statistics
 */
export const getVNICStats = async (req, res) => {
  const { vnic } = req.params;

  try {
    // show-LINK, not show-vnic: `dladm show-vnic -s` has no packet/byte fields
    // (it rejects every one of them as an unknown output field, whatever the
    // flag order), so this endpoint answered zeros for every VNIC. show-link's
    // stat table has them and takes a VNIC as its link. Options precede the
    // operand, as illumos requires.
    const result = await executeCommand(
      `pfexec dladm show-link -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors ${vnic}`
    );

    if (!result.success) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found or failed to get statistics`,
        details: result.error,
      });
    }

    const [link, ipackets, rbytes, ierrors, opackets, obytes, oerrors] = result.output
      .trim()
      .split(':');

    const statistics = {
      link,
      ipackets: parseInt(ipackets) || 0,
      rbytes: parseInt(rbytes) || 0,
      ierrors: parseInt(ierrors) || 0,
      opackets: parseInt(opackets) || 0,
      obytes: parseInt(obytes) || 0,
      oerrors: parseInt(oerrors) || 0,
    };

    return res.json({
      vnic,
      statistics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting VNIC statistics', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC statistics',
      details: error.message,
    });
  }
};

/**
 * Split one `dladm` parseable record into its fields.
 *
 * Per dladm(8) "Parsable Output Format": fields are colon-separated, a literal
 * colon inside a value is escaped as `\:`, and a literal backslash as `\\`. A
 * regex split cannot do this correctly — a value ENDING in an escaped
 * backslash (`…\\`) makes a lookbehind read the real delimiter as escaped and
 * swallow it — so the scan below consumes escapes explicitly.
 * @param {string} line - One parseable output line
 * @returns {string[]} The record's fields, unescaped
 */
const splitDladmRecord = line => {
  const fields = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      // The escaped character is literal, whatever it is (`\:` or `\\`).
      current += line[i + 1];
      i++;
    } else if (char === ':') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
};

/**
 * Normalize one dladm field. Per dladm(8): an unset value prints as `--` (and
 * as empty in parseable mode), a value dladm cannot determine prints as `?`,
 * and a property with no default prints as `--`. All three mean "no usable
 * value here" — they answer null rather than leaking a sentinel the UI would
 * render as if it were real.
 * @param {string} field - Raw field
 * @returns {string|null} The value, or null when unset/unknown
 */
const dladmValue = field => {
  const value = (field || '').trim();
  return value === '' || value === '--' || value === '?' ? null : value;
};

/**
 * @swagger
 * /network/vnics/{vnic}/properties:
 *   get:
 *     summary: Get VNIC link properties (current + default + possible)
 *     description: |
 *       The VNIC's own dladm LINK properties — `protection` (mac-nospoof,
 *       ip-nospoof, dhcp-nospoof, restricted), maxbw, priority, allowed-ips,
 *       mtu, promisc-filtered, … Each carries its CURRENT value, its DEFAULT,
 *       and its POSSIBLE values, so a UI can render true values and real
 *       dropdowns.
 *
 *       NOT to be confused with the bhyve brand's zonecfg NET-RESOURCE
 *       properties (promiscphys, vqsize, feature_mask, …), which configure the
 *       viona device and ride PUT /machines/{name} update_nics. Different
 *       family, different store. MAC/IP spoofing lives HERE, in `protection`.
 *
 *       Write with PUT on this same path.
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: property
 *         schema:
 *           type: string
 *         description: Comma-separated property names (omit for all properties)
 *     responses:
 *       200:
 *         description: VNIC properties retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 properties:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       property:
 *                         type: string
 *                         example: "protection"
 *                       value:
 *                         type: string
 *                         nullable: true
 *                         description: Current value (null when unset)
 *                       default:
 *                         type: string
 *                         nullable: true
 *                         description: The value that applies when unset (null when dladm reports none)
 *                       possible:
 *                         type: array
 *                         items:
 *                           type: string
 *                         description: Allowed values. A numeric range arrives as one entry ("60-1500").
 *                         example: ["mac-nospoof", "restricted", "ip-nospoof", "dhcp-nospoof"]
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC properties
 */
export const getVNICProperties = async (req, res) => {
  const { vnic } = req.params;
  const { property } = req.query;

  try {
    // Options MUST precede the operand, and machine-parseable output for
    // show-linkprop is -c (its -p is --prop=, which takes a property LIST).
    // The old command put the VNIC first and used -p with no argument, so it
    // never produced the colon-separated records this parser expects — same
    // flag-order class as the zpool-get 404.
    const propFilter = property ? ` -p ${property}` : '';
    const result = await executeCommand(
      `pfexec dladm show-linkprop -c -o property,value,default,possible${propFilter} ${vnic}`
    );

    if (!result.success) {
      return res.status(404).json({
        error: `VNIC ${vnic} not found or failed to get properties`,
        details: result.error,
      });
    }

    const properties = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [prop, value, defaultVal, possible] = splitDladmRecord(line);
        const possibleValues = dladmValue(possible);
        return {
          property: prop,
          value: dladmValue(value),
          default: dladmValue(defaultVal),
          possible: possibleValues ? possibleValues.split(',') : [],
        };
      })
      .filter(entry => entry.property);

    return res.json({
      vnic,
      properties,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error getting VNIC properties', {
      vnic,
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to get VNIC properties',
      details: error.message,
    });
  }
};
