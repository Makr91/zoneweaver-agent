/**
 * @fileoverview Template Controller for Zoneweaver Agent — aggregating index
 * @description Handles template listing, discovery, and initiating download/delete tasks.
 * The implementation lives in ./Template/ (source/remote discovery, local queries,
 * mutation task creation); this index preserves the module's import path.
 */

export {
  listSources,
  listRemoteTemplates,
  getRemoteTemplateDetails,
} from './Template/TemplateSourceController.js';
export { listLocalTemplates, getLocalTemplate } from './Template/TemplateLocalController.js';
export {
  downloadTemplate,
  deleteLocalTemplate,
  publishTemplate,
  exportTemplate,
  moveTemplate,
} from './Template/TemplateMutationController.js';
