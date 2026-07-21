/**
 * @fileoverview Lookup Controller for System Account Management
 * @description Single-entity lookups — user by uid/username, group by gid/name, and user RBAC attributes
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../lib/CommandManager.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { parseUserAttrLine } from './utils/SystemParsers.js';
import { log } from '../../lib/Logger.js';

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

    const userExists = await executeCommand(`getent passwd ${username}`);
    if (!userExists.success) {
      return errorResponse(res, 404, `User '${username}' not found`);
    }

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
