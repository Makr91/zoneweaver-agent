/**
 * @fileoverview Resource Over-Provisioning Prevention — aggregating index
 * @description Pre-flight resource validation for zone creation and modification.
 *              Validates storage, memory (with ZFS ARC accounting), and CPU resources.
 *              Two strategies: "committed" (full configured allocations) vs "actual" (current free space).
 *              The implementation lives in ./resourcevalidation/ (storage, memory, CPU validators,
 *              shared helpers, orchestrators); this index preserves the module's import path.
 */

import {
  validateZoneCreationResources,
  validateZoneModificationResources,
} from './resourcevalidation/ZoneResourceValidation.js';

export { validateZoneCreationResources, validateZoneModificationResources };
