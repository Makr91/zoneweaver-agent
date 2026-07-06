/**
 * @fileoverview Link Aggregation Management Controller — aggregating index
 * @description Link aggregation creation, deletion, and management via dladm.
 * The implementation lives in ./Aggregate/ (Query vs Modification, the
 * VnicController split precedent); this index preserves the module's import
 * path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export {
  getAggregates,
  getAggregateDetails,
  getAggregateStats,
} from './Aggregate/AggregateQueryController.js';
export {
  createAggregate,
  deleteAggregate,
  modifyAggregateLinks,
} from './Aggregate/AggregateModificationController.js';
