/**
 * @fileoverview Repository modification operations — aggregating index
 * @description The implementation lives in ./RepositoryLifecycleController.js
 * (add, remove, modify) and ./RepositoryStateController.js (enable, disable);
 * this index preserves the module's import path.
 */

export {
  addRepository,
  removeRepository,
  modifyRepository,
} from './RepositoryLifecycleController.js';
export { enableRepository, disableRepository } from './RepositoryStateController.js';
