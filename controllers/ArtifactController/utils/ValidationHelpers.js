/**
 * @fileoverview Validation Helper Functions for Artifact Management
 * @description Utilities for validating storage locations and other artifact-related data
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ArtifactStorageLocation from '../../../models/ArtifactStorageLocationModel.js';
import { log } from '../../../lib/Logger.js';

/**
 * Get and validate storage location by ID
 * @param {string} storageLocationId - Storage location ID to validate
 * @param {string} requestId - Request ID for logging
 * @returns {Promise<Object>} The validated storage location object
 * @throws {Error} If storage location is invalid or disabled
 */
export const getAndValidateStorageLocation = async (storageLocationId, requestId) => {
  if (!storageLocationId) {
    log.artifact.error('UPLOAD DEBUG: Storage location ID not in task metadata', { requestId });
    throw new Error('Storage location not found in task metadata');
  }

  const storageLocation = await ArtifactStorageLocation.findByPk(storageLocationId);
  if (!storageLocation) {
    log.artifact.error('UPLOAD DEBUG: Storage location not found in DB', {
      requestId,
      storageLocationId,
    });
    throw new Error('Storage location not found');
  }

  if (!storageLocation.enabled) {
    log.artifact.error('UPLOAD DEBUG: Storage location is disabled', {
      requestId,
      storageLocationId,
    });
    throw new Error('Storage location is disabled');
  }

  return storageLocation;
};
