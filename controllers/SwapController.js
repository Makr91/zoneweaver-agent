/**
 * @fileoverview Swap Management Controller — aggregating index
 * @description Provides API endpoints for swap area monitoring and management on
 * OmniOS systems. The implementation lives in ./Swap/ (Query vs Modification,
 * the AggregateController split precedent); this index preserves the module's
 * import path.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

export { listSwapAreas, getSwapSummary, getHostsWithLowSwap } from './Swap/SwapQueryController.js';
export { addSwapArea, removeSwapArea } from './Swap/SwapModificationController.js';
