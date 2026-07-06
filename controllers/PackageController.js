/**
 * @fileoverview Package Management Controller — aggregating index
 * @description Handles package management operations via pkg commands. The
 * implementation lives in ./Package/ (Query vs Modification, the
 * AggregateController split precedent); this index preserves the module's
 * import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export { listPackages, searchPackages, getPackageInfo } from './Package/PackageQueryController.js';
export { installPackages, uninstallPackages } from './Package/PackageModificationController.js';
