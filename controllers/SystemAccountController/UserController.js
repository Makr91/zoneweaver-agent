/**
 * @fileoverview User Management Controller for System Account Management — aggregating index
 * @description Handles user creation, modification, deletion, password management, and account
 * locking. The implementation lives in ./UserCreationController.js (create/modify) and
 * ./UserAccountStateController.js (delete/password/lock/unlock); this index preserves the
 * module's import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export { createSystemUser, modifySystemUser } from './UserCreationController.js';
export {
  deleteSystemUser,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,
} from './UserAccountStateController.js';
