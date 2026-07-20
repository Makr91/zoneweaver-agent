/**
 * @fileoverview Sampling Helper Utilities for Host Monitoring
 * @description Performance-optimized sampling logic for time-series data
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Get latest record per entity using JavaScript deduplication (performance optimized)
 * @param {Array} records - Array of database records
 * @param {string} entityField - Field to deduplicate by (e.g., 'link', 'device_name', 'pool')
 * @returns {Array} Deduplicated array with latest record per entity
 */
export const getLatestPerEntity = (records, entityField) => {
  if (!records || records.length === 0) {
    return [];
  }

  const latestPerEntity = {};
  const entityOrder = [];

  records.forEach(record => {
    const entityKey = record[entityField];
    if (!latestPerEntity[entityKey]) {
      latestPerEntity[entityKey] = record;
      entityOrder.push(entityKey);
    }
  });

  // Sort entity names and return corresponding records
  return entityOrder.sort().map(entityKey => latestPerEntity[entityKey]);
};

/**
 * Group records by entity and apply time-based sampling
 * @param {Array} records - Array of database records
 * @param {string} entityField - Field to group by
 * @param {number} samplesPerEntity - Target samples per entity
 * @returns {Array} Time-sampled records
 */
export const sampleByEntityAndTime = (records, entityField, samplesPerEntity) => {
  if (!records || records.length === 0) {
    return [];
  }

  // Group data by entity
  const entityGroups = {};
  records.forEach(row => {
    const entityKey = row[entityField];
    if (!entityGroups[entityKey]) {
      entityGroups[entityKey] = [];
    }
    entityGroups[entityKey].push(row);
  });

  // Sample evenly from each entity group
  const sampledResults = [];
  const entityNames = Object.keys(entityGroups);

  entityNames.forEach(entityName => {
    const entityData = entityGroups[entityName];
    const totalRecords = entityData.length;

    if (totalRecords === 0) {
      return;
    }

    // Calculate sampling interval
    const interval = Math.max(1, Math.floor(totalRecords / samplesPerEntity));

    // Sample evenly across the data
    for (let i = 0; i < Math.min(samplesPerEntity, totalRecords); i++) {
      const index = Math.min(i * interval, totalRecords - 1);
      sampledResults.push(entityData[index]);
    }
  });

  return sampledResults;
};

/**
 * Apply time-based sampling to a single array of records
 * @param {Array} records - Array of database records sorted by timestamp
 * @param {number} targetSamples - Target number of samples
 * @returns {Array} Time-sampled records
 */
export const sampleByTime = (records, targetSamples) => {
  if (!records || records.length === 0) {
    return [];
  }

  if (records.length <= targetSamples) {
    return records;
  }

  const totalRecords = records.length;
  const interval = Math.max(1, Math.floor(totalRecords / targetSamples));
  const sampledResults = [];

  for (let i = 0; i < Math.min(targetSamples, totalRecords); i++) {
    const index = Math.min(i * interval, totalRecords - 1);
    sampledResults.push(records[index]);
  }

  return sampledResults;
};

/**
 * Calculate time span metadata for sampled results
 * @param {Array} sampledResults - Array of sampled records
 * @returns {Object|null} Time span metadata or null if insufficient data
 */
export const calculateTimeSpan = sampledResults => {
  if (!sampledResults || sampledResults.length < 2) {
    return null;
  }

  const timestamps = sampledResults.map(row => new Date(row.scan_timestamp)).sort();
  const [firstRecord] = timestamps;
  const lastRecord = timestamps[timestamps.length - 1];

  return {
    start: firstRecord.toISOString(),
    end: lastRecord.toISOString(),
    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60)),
  };
};

/**
 * Sort records by entity and timestamp
 * @param {Array} records - Array of records to sort
 * @param {string} entityField - Field to sort by first
 * @returns {Array} Sorted records
 */
export const sortByEntityAndTime = (records, entityField) =>
  records.sort((a, b) => {
    if (a[entityField] !== b[entityField]) {
      return a[entityField].localeCompare(b[entityField]);
    }
    return new Date(a.scan_timestamp) - new Date(b.scan_timestamp);
  });

/**
 * Build sampling metadata object
 * @param {Object} options - Sampling options
 * @returns {Object} Sampling metadata
 */
export const buildSamplingMetadata = (options = {}) => {
  const {
    applied = false,
    strategy = 'simple',
    entityCount = 0,
    samplesPerEntity = 0,
    requestedSamplesPerEntity = 0,
    samplesRequested = 0,
    samplesReturned = 0,
  } = options;

  const metadata = {
    applied,
    strategy,
  };

  if (entityCount > 0) {
    metadata.entityCount = entityCount;
    metadata.samplesPerEntity = samplesPerEntity;
    if (requestedSamplesPerEntity > 0) {
      metadata.requestedSamplesPerEntity = requestedSamplesPerEntity;
    }
  }

  if (samplesRequested > 0) {
    metadata.samplesRequested = samplesRequested;
  }
  if (samplesReturned > 0) {
    metadata.samplesReturned = samplesReturned;
  }

  return metadata;
};

/**
 * Create empty response for no data scenarios
 * @param {number} startTime - Query start time
 * @param {string} strategy - Sampling strategy used
 * @returns {Object} Standard empty response
 */
export const createEmptyResponse = (startTime, strategy = 'no-data') => ({
  totalCount: 0,
  returnedCount: 0,
  queryTime: Date.now() - startTime,
  sampling: {
    applied: true,
    strategy,
    entityCount: 0,
  },
});

/**
 * Add query timing to response — numeric MILLISECONDS (converged
 * structured-JSON wire 2026-07-20; the UI formats).
 * @param {Object} response - Response object to modify
 * @param {number} startTime - Query start time
 * @returns {Object} Response with timing added
 */
export const addQueryTiming = (response, startTime) => ({
  ...response,
  queryTime: Date.now() - startTime,
});
