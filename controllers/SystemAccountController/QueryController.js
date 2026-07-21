/**
 * @fileoverview Query Controller for System Account Management
 * @description Handles user, group, and role lookup and listing operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';
import { executeCommand } from '../../lib/CommandManager.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { getSystemUsers, getSystemGroups, parseUserAttrLine } from './utils/SystemParsers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     SystemUser:
 *       type: object
 *       properties:
 *         username:
 *           type: string
 *         uid:
 *           type: integer
 *         gid:
 *           type: integer
 *         home:
 *           type: string
 *         shell:
 *           type: string
 *         comment:
 *           type: string
 *     SystemGroup:
 *       type: object
 *       properties:
 *         groupname:
 *           type: string
 *         gid:
 *           type: integer
 *         members:
 *           type: array
 *           items:
 *             type: string
 */

/**
 * @swagger
 * /system/user-info:
 *   get:
 *     summary: Get current API user information
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current user information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_user:
 *                   type: string
 *                   description: Current username
 *                   example: "zwagent"
 *                 uid:
 *                   type: integer
 *                   description: Current user ID
 *                   example: 1001
 *                 gid:
 *                   type: integer
 *                   description: Current group ID
 *                   example: 1001
 *                 home_directory:
 *                   type: string
 *                   description: Home directory path
 *                   example: "/opt/zoneweaver-agent"
 *                 shell:
 *                   type: string
 *                   description: Default shell
 *                   example: "/bin/bash"
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Groups the user belongs to
 *                   example: ["zwagent", "staff", "sys"]
 *       500:
 *         description: Failed to get user information
 */
export const getCurrentUserInfo = async (req, res) => {
  void req;
  try {
    const currentUser = os.userInfo();

    const passwdResult = await executeCommand(`getent passwd ${currentUser.username}`);
    let homeDirectory = currentUser.homedir;
    let shell = currentUser.shell || '/bin/bash';

    if (passwdResult.success) {
      const passwdFields = passwdResult.output.split(':');
      if (passwdFields.length >= 7) {
        homeDirectory = passwdFields[5] || homeDirectory;
        shell = passwdFields[6] || shell;
      }
    }

    const groupsResult = await executeCommand(`groups ${currentUser.username}`);
    let groups = [];

    if (groupsResult.success) {
      const groupsLine = groupsResult.output;
      const colonIndex = groupsLine.indexOf(':');
      if (colonIndex !== -1) {
        groups = groupsLine
          .substring(colonIndex + 1)
          .trim()
          .split(/\s+/);
      }
    }

    return directSuccessResponse(res, 'Current user information retrieved successfully', {
      current_user: currentUser.username,
      uid: currentUser.uid,
      gid: currentUser.gid,
      home_directory: homeDirectory,
      shell,
      groups,
      hostname: os.hostname(),
    });
  } catch (error) {
    log.api.error('Error getting current user info', {
      error: error.message,
      stack: error.stack,
      username: os.userInfo().username,
    });
    return errorResponse(res, 500, 'Failed to get current user information', error.message);
  }
};

/**
 * @swagger
 * /system/users:
 *   get:
 *     summary: List system users
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: include_system
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include system users (uid < 1000)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of users to return
 *     responses:
 *       200:
 *         description: System users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SystemUser'
 *                 total_users:
 *                   type: integer
 *       500:
 *         description: Failed to get users
 */
export const getUsers = async (req, res) => {
  try {
    const { include_system = false, limit = 50 } = req.query;

    const users = await getSystemUsers({
      include_system: include_system === 'true' || include_system === true,
      limit: parseInt(limit),
    });

    return directSuccessResponse(res, 'System users retrieved successfully', {
      users,
      total_users: users.length,
      include_system: include_system === 'true' || include_system === true,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system users', {
      error: error.message,
      stack: error.stack,
      include_system: req.query.include_system,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get system users', error.message);
  }
};

/**
 * @swagger
 * /system/groups:
 *   get:
 *     summary: List system groups
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: include_system
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include system groups (gid < 1000)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of groups to return
 *     responses:
 *       200:
 *         description: System groups retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SystemGroup'
 *                 total_groups:
 *                   type: integer
 *       500:
 *         description: Failed to get groups
 */
export const getGroups = async (req, res) => {
  try {
    const { include_system = false, limit = 50 } = req.query;

    const groups = await getSystemGroups({
      include_system: include_system === 'true' || include_system === true,
      limit: parseInt(limit),
    });

    return directSuccessResponse(res, 'System groups retrieved successfully', {
      groups,
      total_groups: groups.length,
      include_system: include_system === 'true' || include_system === true,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system groups', {
      error: error.message,
      stack: error.stack,
      include_system: req.query.include_system,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get system groups', error.message);
  }
};

/**
 * @swagger
 * /system/roles:
 *   get:
 *     summary: List system roles
 *     description: Lists all system roles with their properties and assigned users
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of roles to return
 *     responses:
 *       200:
 *         description: System roles retrieved successfully
 *       500:
 *         description: Failed to get roles
 */
export const getRoles = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const userAttrResult = await executeCommand('cat /etc/user_attr');
    if (!userAttrResult.success) {
      throw new Error(`Failed to read user_attr database: ${userAttrResult.error}`);
    }

    const roles = [];
    const lines = userAttrResult.output.split('\n');

    const roleNames = [];
    for (const line of lines) {
      const attributes = parseUserAttrLine(line);
      if (attributes && attributes.type === 'role') {
        roleNames.push(attributes);
        if (roleNames.length >= parseInt(limit)) {
          break;
        }
      }
    }

    const passwdPromises = roleNames.map(attributes =>
      executeCommand(`getent passwd ${attributes.username}`)
        .then(result => ({ attributes, passwdResult: result }))
        .catch(() => ({ attributes, passwdResult: { success: false } }))
    );

    const passwdResults = await Promise.all(passwdPromises);

    for (const { attributes, passwdResult } of passwdResults) {
      let roleInfo = { uid: null, gid: null, comment: '', home: '', shell: '' };

      if (passwdResult.success) {
        const passwdFields = passwdResult.output.split(':');
        if (passwdFields.length >= 7) {
          roleInfo = {
            uid: parseInt(passwdFields[2]),
            gid: parseInt(passwdFields[3]),
            comment: passwdFields[4] || '',
            home: passwdFields[5] || '',
            shell: passwdFields[6] || '',
          };
        }
      }

      roles.push({
        rolename: attributes.username,
        ...roleInfo,
        authorizations: attributes.authorizations,
        profiles: attributes.profiles,
        project: attributes.project,
      });
    }

    roles.sort((a, b) => a.rolename.localeCompare(b.rolename));

    return directSuccessResponse(res, 'System roles retrieved successfully', {
      roles,
      total_roles: roles.length,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system roles', {
      error: error.message,
      stack: error.stack,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get system roles', error.message);
  }
};
