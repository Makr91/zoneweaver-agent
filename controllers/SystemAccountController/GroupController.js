/**
 * @fileoverview Group Management Controller for System Account Management
 * @description Handles group creation, modification, and deletion operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { validateGroupName, validateUID } from './utils/UserValidation.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/groups:
 *   post:
 *     summary: Create new system group
 *     description: Creates a new group using the groupadd command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - groupname
 *             properties:
 *               groupname:
 *                 type: string
 *                 pattern: '^[a-zA-Z_][a-zA-Z0-9_-]*$'
 *                 description: Group name (must follow OmniOS naming rules)
 *                 example: "webadmins"
 *               gid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: Group ID (100+ recommended for regular groups)
 *                 example: 1001
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this group
 *     responses:
 *       202:
 *         description: Group creation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create group task
 */
export const createSystemGroup = async (req, res) => {
  try {
    const { groupname, gid, created_by = 'api' } = req.body;

    // Validate required parameters
    if (!groupname) {
      return errorResponse(res, 400, 'groupname is required');
    }

    // Validate group name format
    const groupValidation = validateGroupName(groupname);
    if (!groupValidation.valid) {
      return errorResponse(res, 400, 'Invalid group name format', groupValidation.message);
    }

    // Validate GID if provided
    const gidValidation = validateUID(gid); // Same validation as UID
    if (!gidValidation.valid) {
      return errorResponse(res, 400, 'Invalid GID', gidValidation.message);
    }

    log.api.info('Group creation request received', {
      groupname,
      gid,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'group_create',
      {
        groupname,
        gid,
      },
      created_by,
      TaskPriority.MEDIUM
    );

    log.api.info('Group creation task created', {
      task_id: task.id,
      groupname,
      gid,
      created_by,
    });

    return taskCreatedResponse(res, `Group creation task created for ${groupname}`, task, {
      groupname,
      gid: gid || null,
      warnings: gidValidation.warning ? [gidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating group task', {
      error: error.message,
      stack: error.stack,
      groupname: req.body?.groupname,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create group creation task', error.message);
  }
};

/**
 * @swagger
 * /system/groups/{groupname}:
 *   delete:
 *     summary: Delete system group
 *     description: Deletes a group using the groupdel command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: groupname
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name to delete
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User performing this deletion
 *     responses:
 *       202:
 *         description: Group deletion task created successfully
 *       500:
 *         description: Failed to create group deletion task
 */
export const deleteSystemGroup = async (req, res) => {
  try {
    const { groupname } = req.params;
    const { created_by = 'api' } = req.query;

    log.api.info('Group deletion request received', {
      groupname,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'group_delete',
      { groupname },
      created_by,
      TaskPriority.CRITICAL // Group deletion is critical priority
    );

    log.api.info('Group deletion task created', {
      task_id: task.id,
      groupname,
      created_by,
    });

    return taskCreatedResponse(res, `Group deletion task created for ${groupname}`, task, {
      groupname,
    });
  } catch (error) {
    log.api.error('Error creating group deletion task', {
      error: error.message,
      stack: error.stack,
      groupname: req.params?.groupname,
      created_by: req.query?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create group deletion task', error.message);
  }
};

/**
 * @swagger
 * /system/groups/{groupname}:
 *   put:
 *     summary: Modify system group
 *     description: Modifies an existing group using the groupmod command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: groupname
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_groupname:
 *                 type: string
 *                 pattern: '^[a-zA-Z_][a-zA-Z0-9_-]*$'
 *                 description: New group name
 *                 example: "newgroupname"
 *               new_gid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: New Group ID
 *                 example: 1002
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this modification
 *     responses:
 *       202:
 *         description: Group modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create group modification task
 */
export const modifySystemGroup = async (req, res) => {
  try {
    const { groupname } = req.params;
    const { new_groupname, new_gid, created_by = 'api' } = req.body;

    // Validate new group name format if provided
    if (new_groupname) {
      const groupValidation = validateGroupName(new_groupname);
      if (!groupValidation.valid) {
        return errorResponse(res, 400, 'Invalid new group name format', groupValidation.message);
      }
    }

    // Validate new GID if provided
    if (new_gid) {
      const gidValidation = validateUID(new_gid);
      if (!gidValidation.valid) {
        return errorResponse(res, 400, 'Invalid new GID', gidValidation.message);
      }
    }

    log.api.info('Group modification request received', {
      groupname,
      new_groupname,
      new_gid,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'group_modify',
      {
        groupname,
        new_groupname,
        new_gid,
      },
      created_by,
      TaskPriority.MEDIUM
    );

    log.api.info('Group modification task created', {
      task_id: task.id,
      groupname,
      new_groupname,
      created_by,
    });

    return taskCreatedResponse(res, `Group modification task created for ${groupname}`, task, {
      groupname,
      new_groupname: new_groupname || groupname,
      modifications: {
        gid_change: !!new_gid,
        name_change: !!new_groupname,
      },
    });
  } catch (error) {
    log.api.error('Error creating group modification task', {
      error: error.message,
      stack: error.stack,
      groupname: req.params?.groupname,
      new_groupname: req.body?.new_groupname,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create group modification task', error.message);
  }
};
