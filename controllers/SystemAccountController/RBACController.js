/**
 * @fileoverview RBAC Discovery Controller for System Account Management
 * @description Handles RBAC authorization, profile, and role discovery operations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { executeCommand } from '../../lib/CommandManager.js';
import {
  directSuccessResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import { parseAuthAttrLine, parseProfAttrLine, parseUserAttrLine } from './utils/SystemParsers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/rbac/authorizations:
 *   get:
 *     summary: List available authorizations
 *     description: Lists all available RBAC authorizations from auth_attr database
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *         description: Filter authorizations by name pattern
 *         example: "solaris.admin"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of authorizations to return
 *     responses:
 *       200:
 *         description: Authorizations retrieved successfully
 *       500:
 *         description: Failed to get authorizations
 */
export const getAvailableAuthorizations = async (req, res) => {
  try {
    const { filter, limit = 100 } = req.query;

    // Get authorizations from auth_attr
    const authAttrResult = await executeCommand('cat /etc/security/auth_attr');
    if (!authAttrResult.success) {
      throw new Error(`Failed to read auth_attr database: ${authAttrResult.error}`);
    }

    const authorizations = [];
    const lines = authAttrResult.output.split('\n');

    for (const line of lines) {
      const auth = parseAuthAttrLine(line);
      if (!auth) {
        continue;
      }

      // Apply filter if provided
      if (filter && !auth.name.toLowerCase().includes(filter.toLowerCase())) {
        continue;
      }

      authorizations.push(auth);

      if (authorizations.length >= parseInt(limit)) {
        break;
      }
    }

    // Sort by authorization name
    authorizations.sort((a, b) => a.name.localeCompare(b.name));

    return directSuccessResponse(res, 'Authorizations retrieved successfully', {
      authorizations,
      total: authorizations.length,
      limit_applied: parseInt(limit),
      filter_applied: filter || null,
    });
  } catch (error) {
    log.api.error('Error getting available authorizations', {
      error: error.message,
      stack: error.stack,
      filter: req.query.filter,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get available authorizations', error.message);
  }
};

/**
 * @swagger
 * /system/rbac/profiles:
 *   get:
 *     summary: List available execution profiles
 *     description: Lists all available RBAC execution profiles from prof_attr database
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *         description: Filter profiles by name pattern
 *         example: "admin"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of profiles to return
 *     responses:
 *       200:
 *         description: Profiles retrieved successfully
 *       500:
 *         description: Failed to get profiles
 */
export const getAvailableProfiles = async (req, res) => {
  try {
    const { filter, limit = 100 } = req.query;

    // Get profiles from prof_attr
    const profAttrResult = await executeCommand('cat /etc/security/prof_attr');
    if (!profAttrResult.success) {
      throw new Error(`Failed to read prof_attr database: ${profAttrResult.error}`);
    }

    const profiles = [];
    const lines = profAttrResult.output.split('\n');

    for (const line of lines) {
      const profile = parseProfAttrLine(line);
      if (!profile) {
        continue;
      }

      // Apply filter if provided
      if (filter && !profile.name.toLowerCase().includes(filter.toLowerCase())) {
        continue;
      }

      profiles.push(profile);

      if (profiles.length >= parseInt(limit)) {
        break;
      }
    }

    // Sort by profile name
    profiles.sort((a, b) => a.name.localeCompare(b.name));

    return directSuccessResponse(res, 'Profiles retrieved successfully', {
      profiles,
      total: profiles.length,
      limit_applied: parseInt(limit),
      filter_applied: filter || null,
    });
  } catch (error) {
    log.api.error('Error getting available profiles', {
      error: error.message,
      stack: error.stack,
      filter: req.query.filter,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get available profiles', error.message);
  }
};

/**
 * @swagger
 * /system/rbac/roles:
 *   get:
 *     summary: List available roles for assignment
 *     description: Lists roles that can be assigned to users (same as /system/roles but focused on assignment)
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Available roles retrieved successfully
 *       500:
 *         description: Failed to get available roles
 */
export const getAvailableRoles = async (req, res) => {
  try {
    // Reuse the getSystemRoles logic but return simplified format for assignment
    const { limit = 100 } = req.query;

    const userAttrResult = await executeCommand('cat /etc/user_attr');
    if (!userAttrResult.success) {
      throw new Error(`Failed to read user_attr database: ${userAttrResult.error}`);
    }

    const roles = [];
    const lines = userAttrResult.output.split('\n');

    // First pass: collect role names
    const roleAttributes = [];
    for (const line of lines) {
      const attributes = parseUserAttrLine(line);
      if (attributes && attributes.type === 'role') {
        roleAttributes.push(attributes);
        if (roleAttributes.length >= parseInt(limit)) {
          break;
        }
      }
    }

    // Second pass: get passwd info for all roles in parallel
    const passwdPromises = roleAttributes.map(attributes =>
      executeCommand(`getent passwd ${attributes.username}`)
        .then(result => ({ username: attributes.username, passwdResult: result }))
        .catch(() => ({ username: attributes.username, passwdResult: { success: false } }))
    );

    const passwdResults = await Promise.all(passwdPromises);

    // Third pass: build final role objects
    for (const { username, passwdResult } of passwdResults) {
      let comment = '';

      if (passwdResult.success) {
        const passwdFields = passwdResult.output.split(':');
        if (passwdFields.length >= 5) {
          comment = passwdFields[4] || '';
        }
      }

      roles.push({
        name: username,
        description: comment,
      });
    }

    // Sort by role name
    roles.sort((a, b) => a.name.localeCompare(b.name));

    return directSuccessResponse(res, 'Available roles retrieved successfully', {
      roles,
      total: roles.length,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting available roles', {
      error: error.message,
      stack: error.stack,
      limit: req.query.limit,
    });
    return errorResponse(res, 500, 'Failed to get available roles', error.message);
  }
};
