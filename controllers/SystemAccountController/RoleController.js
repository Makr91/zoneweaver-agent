/**
 * @fileoverview Role Management Controller for System Account Management
 * @description Handles role creation, modification, and deletion operations with RBAC support
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { validateUsername, validateUID, validateRBACArray } from './utils/UserValidation.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/roles:
 *   post:
 *     summary: Create new system role
 *     description: Creates a new role using the roleadd command with RBAC support
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - rolename
 *             properties:
 *               rolename:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: Role name (must follow OmniOS naming rules)
 *                 example: "backup_admin"
 *               uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: Role ID (100+ recommended for roles)
 *                 example: 2001
 *               gid:
 *                 type: integer
 *                 description: Primary group ID for role
 *                 example: 100
 *               comment:
 *                 type: string
 *                 description: Role description
 *                 example: "Backup Administration Role"
 *               home_directory:
 *                 type: string
 *                 description: Home directory path for role
 *                 example: "/export/home/backup_admin"
 *               shell:
 *                 type: string
 *                 description: Shell (defaults to /bin/pfsh for roles)
 *                 example: "/bin/pfsh"
 *               create_home:
 *                 type: boolean
 *                 default: false
 *                 description: Create home directory for role
 *               authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: RBAC authorizations for role
 *                 example: ["solaris.admin.dcmgr.*", "solaris.smf.read"]
 *               profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: RBAC profiles for role
 *                 example: ["Media Backup", "File System Management"]
 *               project:
 *                 type: string
 *                 description: Associated project name
 *                 example: "backup_services"
 *     responses:
 *       202:
 *         description: Role creation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create role task
 */
export const createSystemRole = async (req, res) => {
  try {
    const {
      rolename,
      uid,
      gid,
      comment,
      home_directory,
      shell = '/bin/pfsh',
      create_home = false,
      authorizations = [],
      profiles = [],
      project,
    } = req.body;
    const createdBy = req.entity.name;

    // Validate required parameters
    if (!rolename) {
      return errorResponse(res, 400, 'rolename is required');
    }

    // Validate role name format (same as username)
    const rolenameValidation = validateUsername(rolename);
    if (!rolenameValidation.valid) {
      return errorResponse(res, 400, 'Invalid role name format', rolenameValidation.message);
    }

    // Validate UID if provided
    const uidValidation = validateUID(uid);
    if (!uidValidation.valid) {
      return errorResponse(res, 400, 'Invalid UID', uidValidation.message);
    }

    // Validate RBAC arrays
    const validations = [
      validateRBACArray('authorizations', authorizations),
      validateRBACArray('profiles', profiles),
    ];

    for (const validation of validations) {
      if (!validation.valid) {
        return errorResponse(res, 400, validation.message);
      }
    }

    log.api.info('Role creation request received', {
      rolename,
      uid,
      gid,
      created_by: createdBy,
      has_rbac: authorizations.length > 0 || profiles.length > 0,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'role_create',
      {
        rolename,
        uid,
        gid,
        comment,
        home_directory,
        shell,
        create_home,
        authorizations,
        profiles,
        project,
      },
      createdBy,
      TaskPriority.MEDIUM
    );

    log.api.info('Role creation task created', {
      task_id: task.id,
      rolename,
      uid,
      created_by: createdBy,
    });

    return taskCreatedResponse(res, `Role creation task created for ${rolename}`, task, {
      rolename,
      uid: uid || null,
      warnings: uidValidation.warning ? [uidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating role task', {
      error: error.message,
      stack: error.stack,
      rolename: req.body?.rolename,
    });
    return errorResponse(res, 500, 'Failed to create role creation task', error.message);
  }
};

/**
 * @swagger
 * /system/roles/{rolename}:
 *   delete:
 *     summary: Delete system role
 *     description: Deletes a role using the roledel command
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: rolename
 *         required: true
 *         schema:
 *           type: string
 *         description: Role name to delete
 *       - in: query
 *         name: remove_home
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Remove role's home directory
 *     responses:
 *       202:
 *         description: Role deletion task created successfully
 *       500:
 *         description: Failed to create role deletion task
 */
export const deleteSystemRole = async (req, res) => {
  try {
    const { rolename } = req.params;
    const { remove_home = false } = req.query;
    const createdBy = req.entity.name;

    log.api.info('Role deletion request received', {
      rolename,
      remove_home: remove_home === 'true' || remove_home === true,
      created_by: createdBy,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'role_delete',
      {
        rolename,
        remove_home: remove_home === 'true' || remove_home === true,
      },
      createdBy,
      TaskPriority.CRITICAL // Role deletion is critical priority
    );

    log.api.info('Role deletion task created', {
      task_id: task.id,
      rolename,
      created_by: createdBy,
    });

    return taskCreatedResponse(res, `Role deletion task created for ${rolename}`, task, {
      rolename,
      remove_home: remove_home === 'true' || remove_home === true,
    });
  } catch (error) {
    log.api.error('Error creating role deletion task', {
      error: error.message,
      stack: error.stack,
      rolename: req.params?.rolename,
    });
    return errorResponse(res, 500, 'Failed to create role deletion task', error.message);
  }
};

/**
 * @swagger
 * /system/roles/{rolename}:
 *   put:
 *     summary: Modify system role
 *     description: Modifies an existing role using the rolemod command
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: rolename
 *         required: true
 *         schema:
 *           type: string
 *         description: Role name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_rolename:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: New role name
 *                 example: "newrolename"
 *               new_uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: New Role ID
 *                 example: 2002
 *               new_gid:
 *                 type: integer
 *                 description: New primary group ID
 *                 example: 100
 *               new_comment:
 *                 type: string
 *                 description: New role description
 *                 example: "Updated Role Description"
 *               new_authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC authorizations (replaces existing)
 *                 example: ["solaris.admin.dcmgr.*"]
 *               new_profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC profiles (replaces existing)
 *                 example: ["System Administrator"]
 *     responses:
 *       202:
 *         description: Role modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create role modification task
 */
export const modifySystemRole = async (req, res) => {
  try {
    const { rolename } = req.params;
    const {
      new_rolename,
      new_uid,
      new_gid,
      new_comment,
      new_authorizations = [],
      new_profiles = [],
    } = req.body;
    const createdBy = req.entity.name;

    // Validate new role name format if provided
    if (new_rolename) {
      const rolenameValidation = validateUsername(new_rolename);
      if (!rolenameValidation.valid) {
        return errorResponse(res, 400, 'Invalid new role name format', rolenameValidation.message);
      }
    }

    // Validate new UID if provided
    if (new_uid) {
      const uidValidation = validateUID(new_uid);
      if (!uidValidation.valid) {
        return errorResponse(res, 400, 'Invalid new UID', uidValidation.message);
      }
    }

    // Validate RBAC arrays
    const validations = [
      validateRBACArray('new_authorizations', new_authorizations),
      validateRBACArray('new_profiles', new_profiles),
    ];

    for (const validation of validations) {
      if (!validation.valid) {
        return errorResponse(res, 400, validation.message);
      }
    }

    log.api.info('Role modification request received', {
      rolename,
      new_rolename,
      new_uid,
      created_by: createdBy,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'role_modify',
      {
        rolename,
        new_rolename,
        new_uid,
        new_gid,
        new_comment,
        new_authorizations,
        new_profiles,
      },
      createdBy,
      TaskPriority.MEDIUM
    );

    log.api.info('Role modification task created', {
      task_id: task.id,
      rolename,
      new_rolename,
      created_by: createdBy,
    });

    return taskCreatedResponse(res, `Role modification task created for ${rolename}`, task, {
      rolename,
      new_rolename: new_rolename || rolename,
      modifications: {
        uid_change: !!new_uid,
        name_change: !!new_rolename,
        rbac_update: new_authorizations.length > 0 || new_profiles.length > 0,
      },
    });
  } catch (error) {
    log.api.error('Error creating role modification task', {
      error: error.message,
      stack: error.stack,
      rolename: req.params?.rolename,
      new_rolename: req.body?.new_rolename,
    });
    return errorResponse(res, 500, 'Failed to create role modification task', error.message);
  }
};
