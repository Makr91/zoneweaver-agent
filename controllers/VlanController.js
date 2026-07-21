/**
 * @fileoverview VLAN Management Controller for Zoneweaver Agent
 * @description Handles VLAN creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import os from 'os';
import { log } from '../lib/Logger.js';
import { executeCommand } from '../lib/CommandManager.js';

/**
 * @swagger
 * /network/vlans:
 *   get:
 *     summary: List VLANs
 *     description: Returns VLAN information from monitoring data or live system query
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: vid
 *         schema:
 *           type: integer
 *         description: Filter by VLAN ID
 *       - in: query
 *         name: over
 *         schema:
 *           type: string
 *         description: Filter by underlying physical link
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of VLANs to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *     responses:
 *       200:
 *         description: VLANs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vlans:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get VLANs
 */
export const getVlans = async (req, res) => {
  const { vid, over, limit = 100, live = false } = req.query;

  try {
    if (live === 'true' || live === true) {
      const command = 'pfexec dladm show-vlan -p -o link,vid,over,flags';

      const result = await executeCommand(command);

      if (!result.success) {
        return res.status(500).json({
          error: 'Failed to get live VLAN data',
          details: result.error,
        });
      }

      const vlans = result.output
        ? result.output
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
              const [link, vlanId, overLink, flags] = line.split(':');
              return {
                link,
                class: 'vlan',
                vid: parseInt(vlanId),
                over: overLink,
                flags: flags || '',
                source: 'live',
              };
            })
            .filter(vlan => {
              if (vid && vlan.vid !== parseInt(vid)) {
                return false;
              }
              if (over && vlan.over !== over) {
                return false;
              }
              return true;
            })
            .slice(0, parseInt(limit))
        : [];

      return res.json({
        vlans,
        total: vlans.length,
        source: 'live',
      });
    }

    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'vlan',
    };

    if (vid) {
      whereClause.vid = parseInt(vid);
    }
    if (over) {
      whereClause.over = over;
    }

    const { count, rows } = await NetworkInterfaces.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    return res.json({
      vlans: rows,
      total: count,
      source: 'database',
    });
  } catch (error) {
    log.api.error('Error getting VLANs', {
      error: error.message,
      stack: error.stack,
      live,
      vid,
      over,
    });
    return res.status(500).json({
      error: 'Failed to get VLANs',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vlans/{vlan}:
 *   get:
 *     summary: Get VLAN details
 *     description: Returns detailed information about a specific VLAN
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vlan
 *         required: true
 *         schema:
 *           type: string
 *         description: VLAN link name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *     responses:
 *       200:
 *         description: VLAN details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: VLAN not found
 *       500:
 *         description: Failed to get VLAN details
 */
export const getVlanDetails = async (req, res) => {
  const { vlan } = req.params;
  const { live = false } = req.query;

  try {
    if (live === 'true' || live === true) {
      const vlanResult = await executeCommand(
        `pfexec dladm show-vlan ${vlan} -p -o link,vid,over,flags`
      );

      if (!vlanResult.success) {
        return res.status(404).json({
          error: `VLAN ${vlan} not found`,
          details: vlanResult.error,
        });
      }

      const [link, vid, over, flags] = vlanResult.output.split(':');

      const vlanDetails = {
        link,
        class: 'vlan',
        vid: parseInt(vid),
        over,
        flags: flags || '',
        source: 'live',
      };

      const linkResult = await executeCommand(
        `pfexec dladm show-link ${vlan} -p -o link,class,mtu,state`
      );
      if (linkResult.success) {
        const [, _linkClass, mtu, state] = linkResult.output.split(':');
        void _linkClass;
        vlanDetails.mtu = parseInt(mtu) || null;
        vlanDetails.state = state;
      }

      return res.json(vlanDetails);
    }

    const hostname = os.hostname();
    const vlanData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: vlan,
        class: 'vlan',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!vlanData) {
      return res.status(404).json({
        error: `VLAN ${vlan} not found`,
      });
    }

    return res.json(vlanData);
  } catch (error) {
    log.api.error('Error getting VLAN details', {
      error: error.message,
      stack: error.stack,
      vlan,
      live,
    });
    return res.status(500).json({
      error: 'Failed to get VLAN details',
      details: error.message,
    });
  }
};
