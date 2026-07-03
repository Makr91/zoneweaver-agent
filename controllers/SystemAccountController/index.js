/**
 * @fileoverview System Account Controller Index
 * @description Main entry point for system account management controllers
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

// Import user management functions
import {
  createSystemUser,
  deleteSystemUser,
  modifySystemUser,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,
} from './UserController.js';

// Import group management functions
import { createSystemGroup, deleteSystemGroup, modifySystemGroup } from './GroupController.js';

// Import role management functions
import { createSystemRole, deleteSystemRole, modifySystemRole } from './RoleController.js';

// Import query functions
import {
  getCurrentUserInfo,
  getUsers,
  getGroups,
  lookupUser,
  lookupGroup,
  getRoles,
  getUserAttributes,
} from './QueryController.js';

// Import RBAC discovery functions
import {
  getAvailableAuthorizations,
  getAvailableProfiles,
  getAvailableRoles,
} from './RBACController.js';

// Export all functions with their original names for backward compatibility
export {
  // User management
  createSystemUser,
  deleteSystemUser,
  modifySystemUser,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,

  // Group management
  createSystemGroup,
  deleteSystemGroup,
  modifySystemGroup,

  // Role management
  createSystemRole,
  deleteSystemRole,
  modifySystemRole,

  // Query operations
  getCurrentUserInfo,
  lookupUser,
  lookupGroup,
  getUserAttributes,

  // List operations (maintain original names)
  getUsers as getSystemUsers,
  getGroups as getSystemGroups,
  getRoles as getSystemRoles,

  // RBAC discovery
  getAvailableAuthorizations,
  getAvailableProfiles,
  getAvailableRoles,
};

// Default export for compatibility
export default {
  // User management
  createSystemUser,
  deleteSystemUser,
  modifySystemUser,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,

  // Group management
  createSystemGroup,
  deleteSystemGroup,
  modifySystemGroup,

  // Role management
  createSystemRole,
  deleteSystemRole,
  modifySystemRole,

  // Query operations
  getCurrentUserInfo,
  getSystemUsers: getUsers,
  getSystemGroups: getGroups,
  lookupUser,
  lookupGroup,
  getSystemRoles: getRoles,
  getUserAttributes,

  // RBAC discovery
  getAvailableAuthorizations,
  getAvailableProfiles,
  getAvailableRoles,
};
