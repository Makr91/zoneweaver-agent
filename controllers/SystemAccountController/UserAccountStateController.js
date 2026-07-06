/**
 * @fileoverview User Account State Controller for System Account Management
 * @description Handles user deletion, password management, and account locking
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/users/{username}:
 *   delete:
 *     summary: Delete system user
 *     description: Deletes a user account using the userdel command with optional home directory removal
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to delete
 *       - in: query
 *         name: remove_home
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Remove user's home directory and mail spool
 *       - in: query
 *         name: delete_personal_group
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also delete personal group if it exists
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User performing this deletion
 *     responses:
 *       202:
 *         description: User deletion task created successfully
 *       500:
 *         description: Failed to create user deletion task
 */
export const deleteSystemUser = async (req, res) => {
  try {
    const { username } = req.params;
    const { remove_home = false, delete_personal_group = false, created_by = 'api' } = req.query;

    log.api.info('User deletion request received', {
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_delete',
      {
        username,
        remove_home: remove_home === 'true' || remove_home === true,
        delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
      },
      created_by,
      TaskPriority.CRITICAL // User deletion is critical priority
    );

    log.api.info('User deletion task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `User deletion task created for ${username}`, task, {
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
    });
  } catch (error) {
    log.api.error('Error creating user deletion task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.query?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create user deletion task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/password:
 *   post:
 *     summary: Set user password
 *     description: Sets or changes a user's password using the passwd command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to set password for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 minLength: 1
 *                 description: New password for the user
 *               force_change:
 *                 type: boolean
 *                 default: false
 *                 description: Force password change on next login
 *               unlock_account:
 *                 type: boolean
 *                 default: true
 *                 description: Unlock account after setting password
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Password setting task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create password setting task
 */
export const setUserPassword = async (req, res) => {
  try {
    const { username } = req.params;
    const { password, force_change = false, unlock_account = true, created_by = 'api' } = req.body;

    if (!password) {
      return errorResponse(res, 400, 'password is required');
    }

    log.api.info('Password setting request received', {
      username,
      force_change,
      unlock_account,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_set_password',
      {
        username,
        password,
        force_change,
        unlock_account,
      },
      created_by,
      TaskPriority.HIGH // Password operations are high priority
    );

    log.api.info('Password setting task created', {
      task_id: task.id,
      username,
      force_change,
      created_by,
    });

    return taskCreatedResponse(res, `Password setting task created for ${username}`, task, {
      username,
      force_change,
      unlock_account,
    });
  } catch (error) {
    log.api.error('Error creating password setting task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create password setting task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/lock:
 *   post:
 *     summary: Lock user account
 *     description: Locks a user account using passwd -l command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to lock
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Account locking task created successfully
 *       500:
 *         description: Failed to create account locking task
 */
export const lockUserAccount = async (req, res) => {
  try {
    const { username } = req.params;
    const { created_by = 'api' } = req.body || {};

    log.api.info('Account locking request received', {
      username,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask('user_lock', { username }, created_by, TaskPriority.HIGH);

    log.api.info('Account locking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `Account locking task created for ${username}`, task, {
      username,
    });
  } catch (error) {
    log.api.error('Error creating account locking task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create account locking task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/unlock:
 *   post:
 *     summary: Unlock user account
 *     description: Unlocks a user account using passwd -u command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to unlock
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Account unlocking task created successfully
 *       500:
 *         description: Failed to create account unlocking task
 */
export const unlockUserAccount = async (req, res) => {
  try {
    const { username } = req.params;
    const { created_by = 'api' } = req.body || {};

    log.api.info('Account unlocking request received', {
      username,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask('user_unlock', { username }, created_by, TaskPriority.HIGH);

    log.api.info('Account unlocking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `Account unlocking task created for ${username}`, task, {
      username,
    });
  } catch (error) {
    log.api.error('Error creating account unlocking task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create account unlocking task', error.message);
  }
};
