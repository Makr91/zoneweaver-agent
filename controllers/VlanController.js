/**
 * @fileoverview VLAN Management Controller for Zoneweaver Agent
 * @description Handles VLAN creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import yj from 'yieldable-json';
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
      // Get live data directly from dladm
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

    // Get data from database (monitoring data)
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
      // Get VLAN details
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

      // Get additional link information
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

    // Get data from database
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

/**
 * @swagger
 * /network/vlans:
 *   post:
 *     summary: Create VLAN
 *     description: Creates a new VLAN using dladm create-vlan
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vid
 *               - link
 *             properties:
 *               vid:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 4094
 *                 description: VLAN ID (1-4094)
 *                 example: 100
 *               link:
 *                 type: string
 *                 description: Physical ethernet link to create VLAN over
 *                 example: "e1000g0"
 *               name:
 *                 type: string
 *                 description: Custom VLAN link name (auto-generated if not provided)
 *                 example: "vlan100"
 *               force:
 *                 type: boolean
 *                 description: Force creation on devices without VLAN header support
 *                 default: false
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary VLAN (not persistent)
 *                 default: false
 *     responses:
 *       202:
 *         description: VLAN creation task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 vlan_name:
 *                   type: string
 *                 vid:
 *                   type: integer
 *                 over:
 *                   type: string
 *                   description: The underlying physical link the VLAN is created over
 *                 temporary:
 *                   type: boolean
 *                   description: Whether the VLAN is temporary (echoed from the request)
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create VLAN task
 */
export const createVlan = async (req, res) => {
  const { vid, link, name, force = false, temporary = false } = req.body;

  try {
    // Validate required fields
    if (!vid || !link) {
      return res.status(400).json({
        error: 'vid and link are required',
      });
    }

    // Validate VLAN ID range
    if (vid < 1 || vid > 4094) {
      return res.status(400).json({
        error: 'VLAN ID must be between 1 and 4094',
      });
    }

    // Validate that the underlying link exists
    const linkResult = await executeCommand(`pfexec dladm show-link ${link}`);
    if (!linkResult.success) {
      return res.status(400).json({
        error: `Underlying link ${link} not found or not available`,
      });
    }

    // Generate VLAN name if not provided
    let vlanName = name;
    if (!vlanName) {
      // Auto-generate name based on dladm convention: <name><1000 * vid + PPA>
      const linkMatch = link.match(/^(?<baseName>[a-zA-Z]+)(?<ppa>\d+)$/);
      if (linkMatch) {
        const { baseName, ppa } = linkMatch.groups;
        const calculatedSuffix = 1000 * vid + parseInt(ppa);
        vlanName = `${baseName}${calculatedSuffix}`;

        log.api.debug('VLAN name generation', {
          link,
          vid,
          baseName,
          ppa,
          calculatedSuffix,
          generatedName: vlanName,
        });
      } else {
        vlanName = `vlan${vid}`;
        log.api.debug('VLAN name fallback', {
          link,
          vid,
          fallbackName: vlanName,
        });
      }
    }

    // Check if VLAN already exists
    const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlanName}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `VLAN ${vlanName} already exists`,
      });
    }

    // Create task for VLAN creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_vlan',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            vid,
            link,
            name: vlanName,
            force,
            temporary,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `VLAN creation task created for ${vlanName} (VID ${vid}) over ${link}`,
      task_id: task.id,
      vlan_name: vlanName,
      vid,
      over: link,
      temporary,
    });
  } catch (error) {
    log.api.error('Error creating VLAN', {
      error: error.message,
      stack: error.stack,
      vid,
      link,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create VLAN task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/vlans/{vlan}:
 *   delete:
 *     summary: Delete VLAN
 *     description: Deletes a VLAN using dladm delete-vlan
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vlan
 *         required: true
 *         schema:
 *           type: string
 *         description: VLAN link name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *     responses:
 *       202:
 *         description: VLAN deletion task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 vlan_name:
 *                   type: string
 *                 temporary:
 *                   type: boolean
 *                   description: Whether only the temporary configuration was deleted (echoed from the request)
 *       404:
 *         description: VLAN not found
 *       500:
 *         description: Failed to create VLAN deletion task
 */
export const deleteVlan = async (req, res) => {
  const { vlan } = req.params;
  const { temporary = false } = req.query;

  try {
    // Check if VLAN exists
    const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlan}`);

    if (!existsResult.success) {
      return res.status(404).json({
        error: `VLAN ${vlan} not found`,
        details: existsResult.error,
      });
    }

    // Create task for VLAN deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_vlan',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            vlan,
            temporary: temporary === 'true' || temporary === true,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.app.info('VLAN deletion task created', {
      task_id: task.id,
      vlan,
      temporary: temporary === 'true' || temporary === true,
      created_by: req.entity.name,
    });

    return res.status(202).json({
      success: true,
      message: `VLAN deletion task created for ${vlan}`,
      task_id: task.id,
      vlan_name: vlan,
      temporary: temporary === 'true' || temporary === true,
    });
  } catch (error) {
    log.api.error('Error deleting VLAN', {
      error: error.message,
      stack: error.stack,
      vlan: req.params.vlan,
    });
    return res.status(500).json({
      error: 'Failed to create VLAN deletion task',
      details: error.message,
    });
  }
};
