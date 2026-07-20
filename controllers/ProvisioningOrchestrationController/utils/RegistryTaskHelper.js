import Zones from '../../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../../models/TaskModel.js';
import { parseConfiguration } from '../../../lib/ZoneConfigUtils.js';

export const provisionerReferences = async (name, version = '') => {
  const zones = await Zones.findAll();
  const references = [];
  for (const zone of zones) {
    const ref = parseConfiguration(zone).provisioner_ref;
    if (!ref || ref.name !== name) {
      continue;
    }
    if (version && ref.version !== version) {
      continue;
    }
    references.push(zone.name);
  }
  return references;
};

/**
 * Queue one system-scoped registry task (import/export/catalog-install/
 * refresh all share this exact row shape).
 * @param {Object} req - Request (created_by rides req.entity.name)
 * @param {string} operation - Task operation
 * @param {Object} metadata - Task metadata
 * @returns {Promise<Object>} Created task
 */
export const queueRegistryTask = (req, operation, metadata) =>
  Tasks.create({
    zone_name: 'system',
    operation,
    priority: TaskPriority.MEDIUM,
    created_by: req.entity.name,
    status: 'pending',
    metadata: JSON.stringify(metadata),
  });
