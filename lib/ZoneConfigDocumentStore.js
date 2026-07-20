import Zones from '../models/ZoneModel.js';
import { parseConfiguration } from './ZoneConfigUtils.js';

/**
 * Hosts.yml document sections owned by the database document store — the
 * agent's PUT/GET machine-document contract. zadm never authors these; when a
 * stale copy rides in zonecfg output, the database still wins.
 */
export const DOCUMENT_SECTIONS = [
  'settings',
  'zones',
  'vbox',
  'utm',
  'networks',
  'disks',
  'provisioner',
  'provisioner_ref',
  'provisioner_state',
  'pending_changes',
  'guest_info',
  'snapshots',
  'metadata',
];

export const saveConfiguration = async (zoneName, mutate) => {
  const zone = await Zones.findOne({ where: { name: zoneName } });
  if (!zone) {
    return null;
  }
  const zoneConfig = structuredClone(parseConfiguration(zone));
  const result = mutate(zoneConfig);
  zone.set('configuration', zoneConfig);
  zone.changed('configuration', true);
  await zone.save();
  return result;
};
