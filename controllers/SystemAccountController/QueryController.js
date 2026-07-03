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
    // Get current user info
    const currentUser = os.userInfo();

    // Get additional user details from system
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

    // Get user groups
    const groupsResult = await executeCommand(`groups ${currentUser.username}`);
    let groups = [];

    if (groupsResult.success) {
      // Parse groups output: "username : group1 group2 group3"
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
 * /system/user-lookup:
 *   get:
 *     summary: Lookup user by UID or username
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: uid
 *         schema:
 *           type: integer
 *         description: User ID to lookup
 *         example: 1000
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *         description: Username to lookup
 *         example: "mvcs"
 *     responses:
 *       200:
 *         description: User information retrieved successfully
 *       404:
 *         description: User not found
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to lookup user
 */
export const lookupUser = async (req, res) => {
  try {
    const { uid, username } = req.query;

    if (!uid && !username) {
      return errorResponse(res, 400, 'Either uid or username parameter is required');
    }

    let command = 'getent passwd';
    if (uid) {
      command += ` ${uid}`;
    } else {
      command += ` ${username}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return errorResponse(
        res,
        404,
        uid ? `User with UID ${uid} not found` : `User '${username}' not found`
      );
    }

    const fields = result.output.split(':');
    if (fields.length < 7) {
      throw new Error('Invalid passwd entry format');
    }

    const userInfo = {
      username: fields[0],
      uid: parseInt(fields[2]),
      gid: parseInt(fields[3]),
      comment: fields[4] || '',
      home: fields[5] || '',
      shell: fields[6] || '',
    };

    return directSuccessResponse(res, 'User information retrieved successfully', userInfo);
  } catch (error) {
    log.api.error('Error looking up user', {
      error: error.message,
      stack: error.stack,
      uid: req.query.uid,
      username: req.query.username,
    });
    return errorResponse(res, 500, 'Failed to lookup user', error.message);
  }
};

/**
 * @swagger
 * /system/group-lookup:
 *   get:
 *     summary: Lookup group by GID or group name
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: gid
 *         schema:
 *           type: integer
 *         description: Group ID to lookup
 *         example: 1000
 *       - in: query
 *         name: groupname
 *         schema:
 *           type: string
 *         description: Group name to lookup
 *         example: "staff"
 *     responses:
 *       200:
 *         description: Group information retrieved successfully
 *       404:
 *         description: Group not found
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to lookup group
 */
export const lookupGroup = async (req, res) => {
  try {
    const { gid, groupname } = req.query;

    if (!gid && !groupname) {
      return errorResponse(res, 400, 'Either gid or groupname parameter is required');
    }

    let command = 'getent group';
    if (gid) {
      command += ` ${gid}`;
    } else {
      command += ` ${groupname}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return errorResponse(
        res,
        404,
        gid ? `Group with GID ${gid} not found` : `Group '${groupname}' not found`
      );
    }

    const fields = result.output.split(':');
    if (fields.length < 4) {
      throw new Error('Invalid group entry format');
    }

    const groupInfo = {
      groupname: fields[0],
      gid: parseInt(fields[2]),
      members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : [],
    };

    return directSuccessResponse(res, 'Group information retrieved successfully', groupInfo);
  } catch (error) {
    log.api.error('Error looking up group', {
      error: error.message,
      stack: error.stack,
      gid: req.query.gid,
      groupname: req.query.groupname,
    });
    return errorResponse(res, 500, 'Failed to lookup group', error.message);
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

    // Get users with type=role from user_attr
    const userAttrResult = await executeCommand('cat /etc/user_attr');
    if (!userAttrResult.success) {
      throw new Error(`Failed to read user_attr database: ${userAttrResult.error}`);
    }

    const roles = [];
    const lines = userAttrResult.output.split('\n');

    // First pass: collect role names
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

    // Second pass: get passwd info for all roles in parallel
    const passwdPromises = roleNames.map(attributes =>
      executeCommand(`getent passwd ${attributes.username}`)
        .then(result => ({ attributes, passwdResult: result }))
        .catch(() => ({ attributes, passwdResult: { success: false } }))
    );

    const passwdResults = await Promise.all(passwdPromises);

    // Third pass: build final role objects
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

    // Sort by role name
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

/**
 * @swagger
 * /system/users/{username}/attributes:
 *   get:
 *     summary: Get user RBAC attributes
 *     description: Get detailed RBAC attributes for a specific user from user_attr database
 *     tags: [User Attributes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to get attributes for
 *     responses:
 *       200:
 *         description: User attributes retrieved successfully
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to get user attributes
 */
export const getUserAttributes = async (req, res) => {
  try {
    const { username } = req.params;

    // Check if user exists first
    const userExists = await executeCommand(`getent passwd ${username}`);
    if (!userExists.success) {
      return errorResponse(res, 404, `User '${username}' not found`);
    }

    // Get user attributes from user_attr
    const userAttrResult = await executeCommand(`grep "^${username}:" /etc/user_attr`);

    const attributes = {
      username,
      type: 'normal',
      authorizations: [],
      profiles: [],
      roles: [],
      project: null,
      default_privileges: null,
      limit_privileges: null,
      lock_after_retries: null,
    };

    if (userAttrResult.success && userAttrResult.output) {
      const parsedAttrs = parseUserAttrLine(userAttrResult.output);
      if (parsedAttrs) {
        Object.assign(attributes, parsedAttrs);
      }
    }

    return directSuccessResponse(res, 'User attributes retrieved successfully', attributes);
  } catch (error) {
    log.api.error('Error getting user attributes', {
      error: error.message,
      stack: error.stack,
      username: req.params.username,
    });
    return errorResponse(res, 500, 'Failed to get user attributes', error.message);
  }
};
