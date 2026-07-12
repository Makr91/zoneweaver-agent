/**
 * @fileoverview Snapshot rotation service — Snapshoter.sh's cron replaced in-agent
 * @description Every zone is snapshotted on the standing schedule under the agent-level
 * default policy; a per-zone policy (configuration.snapshots, set at create or via PUT)
 * OVERRIDES the default — including disabling (type none). Retention types:
 *   none     — scheduled snapshots off for that zone
 *   simple   — auto-<ts> snapshots on the simple/age cadence, keep the newest N
 *   age      — auto-<ts> snapshots, delete those older than max_age_days
 *   rotation — Snapshoter.sh semantics: hourly (:00, hours 1-23), daily (00:00 Sun-Fri),
 *              weekly (00:00 Sat), each tier keeping its own count
 * Deletion is always scrub/resilver-guarded. Snapshots cover the zone root dataset
 * recursively plus out-of-tree media. quiesce: true adds qga fsfreeze around each
 * snapshot when the guest agent answers.
 */

import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';
import Zones from '../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';

const DEFAULT_TIERS = {
  hourly: { keep: 24 },
  daily: { keep: 8 },
  weekly: { keep: 5 },
};

const serviceConfig = () => {
  const raw = config.get('snapshots') || {};
  return {
    enabled: raw.enabled === true,
    interval_minutes: Number(raw.interval_minutes) || 60,
    default_policy: raw.default_policy || { type: 'none' },
  };
};

const effectivePolicy = (zone, defaults) => {
  let zoneConfig = zone.configuration || {};
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch {
      zoneConfig = {};
    }
  }
  const override = zoneConfig.snapshots;
  if (override && typeof override === 'object' && override.type) {
    return override;
  }
  return defaults;
};

/**
 * The rotation tiers due at a given minute — Snapshoter.sh's cron trio
 * verbatim: hourly at :00 of hours 1-23, daily at 00:00 Sun-Fri, weekly at
 * 00:00 Saturday (the tiers never double-fire at midnight).
 */
export const dueRotationTiers = now => {
  if (now.getMinutes() !== 0) {
    return [];
  }
  if (now.getHours() !== 0) {
    return ['hourly'];
  }
  return now.getDay() === 6 ? ['weekly'] : ['daily'];
};

const queueSnapshot = async (zoneName, metadata) => {
  const existing = await Tasks.findOne({
    where: { zone_name: zoneName, operation: 'snapshot_take', status: ['pending', 'running'] },
  });
  if (existing) {
    return;
  }
  await Tasks.create({
    zone_name: zoneName,
    operation: 'snapshot_take',
    priority: TaskPriority.BACKGROUND,
    created_by: 'snapshot_rotation',
    status: 'pending',
    metadata: JSON.stringify(metadata),
  });
};

const runSequentially = (items, fn) =>
  items.reduce((promise, item) => promise.then(() => fn(item)), Promise.resolve());

const runZonePolicy = async (zone, policy, tiers) => {
  const quiesce = policy.quiesce === true;
  switch (policy.type) {
    case 'rotation': {
      const configuredTiers = policy.tiers || DEFAULT_TIERS;
      await runSequentially(tiers, tier =>
        queueSnapshot(zone.name, {
          prefix: tier,
          retention: Number(configuredTiers[tier]?.keep ?? DEFAULT_TIERS[tier].keep),
          quiesce,
        })
      );
      return;
    }
    case 'simple':
      await queueSnapshot(zone.name, {
        prefix: 'auto',
        retention: Number(policy.keep) || 24,
        quiesce,
      });
      return;
    case 'age':
      await queueSnapshot(zone.name, {
        prefix: 'auto',
        retention: 0,
        max_age_days: Number(policy.max_age_days) || 14,
        quiesce,
      });
      break;

    default:
  }
};

let running = false;

const tick = async fireSimple => {
  if (running) {
    return;
  }
  running = true;
  try {
    const { default_policy } = serviceConfig();
    const now = new Date();
    const tiers = dueRotationTiers(now);
    const zones = await Zones.findAll();
    await runSequentially(zones, zone => {
      const policy = effectivePolicy(zone, default_policy);
      if (!policy || policy.type === 'none') {
        return Promise.resolve();
      }
      if (policy.type === 'rotation' && tiers.length === 0) {
        return Promise.resolve();
      }
      if (policy.type !== 'rotation' && !fireSimple) {
        return Promise.resolve();
      }
      return runZonePolicy(zone, policy, tiers);
    });
  } catch (error) {
    log.monitoring.error('Snapshot rotation tick failed', { error: error.message });
  } finally {
    running = false;
  }
};

let timer = null;
let lastSimpleFire = 0;

export const startSnapshotRotation = () => {
  const settings = serviceConfig();
  if (!settings.enabled || timer) {
    return;
  }
  log.monitoring.info('Snapshot rotation service started', {
    default_type: settings.default_policy.type,
    interval_minutes: settings.interval_minutes,
  });
  timer = setInterval(() => {
    const now = Date.now();
    const simpleDue = now - lastSimpleFire >= settings.interval_minutes * 60000;
    if (simpleDue) {
      lastSimpleFire = now;
    }
    tick(simpleDue);
  }, 60000);
};

export const stopSnapshotRotation = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
