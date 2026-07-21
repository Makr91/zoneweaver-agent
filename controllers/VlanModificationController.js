/**
 * @fileoverview VLAN create and delete operations for Zoneweaver Agent
 * @description Handles VLAN creation and deletion via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';
import { executeCommand } from '../lib/CommandManager.js';

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
    if (!vid || !link) {
      return res.status(400).json({
        error: 'vid and link are required',
      });
    }

    if (vid < 1 || vid > 4094) {
      return res.status(400).json({
        error: 'VLAN ID must be between 1 and 4094',
      });
    }

    const linkResult = await executeCommand(`pfexec dladm show-link ${link}`);
    if (!linkResult.success) {
      return res.status(400).json({
        error: `Underlying link ${link} not found or not available`,
      });
    }

    let vlanName = name;
    if (!vlanName) {
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

    const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlanName}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `VLAN ${vlanName} already exists`,
      });
    }

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
    const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlan}`);

    if (!existsResult.success) {
      return res.status(404).json({
        error: `VLAN ${vlan} not found`,
        details: existsResult.error,
      });
    }

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
