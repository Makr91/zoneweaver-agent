/**
 * @fileoverview CPU Core Helper Utilities for Host Monitoring
 * @description Expansion of compact per-core CPU utilization storage
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Expand the compact stored per-core form — [[user_pct, system_pct, idle_pct,
 * utilization_pct], ...] indexed by core — into the full per_core_parsed
 * objects this API has always served. cpu_id derives from the index; iowait is
 * always 0 (os.cpus() exposes none). Full fidelity, ~4x smaller storage.
 * Plain JSON.parse, NOT yieldable-json: yj's incremental parser rejects
 * exponent-notation numbers and this payload is a few KB.
 * @param {string} raw - Stored per_core_data JSON
 * @returns {Array|null} Parsed per-core objects, or null on parse failure
 */
export const expandPerCoreData = raw => {
  try {
    return JSON.parse(raw).map((core, i) => ({
      cpu_id: `cpu${i}`,
      user_pct: core[0],
      system_pct: core[1],
      idle_pct: core[2],
      iowait_pct: 0,
      utilization_pct: core[3],
    }));
  } catch {
    return null;
  }
};
