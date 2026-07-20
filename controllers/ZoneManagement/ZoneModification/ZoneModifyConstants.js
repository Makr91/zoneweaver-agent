export const CREDENTIAL_FIELDS = [
  'vagrant_user',
  'vagrant_user_pass',
  'vagrant_user_private_key_path',
];

/**
 * Agent-owned custom zonecfg attrs (the boot_priority pattern): the value
 * rides the zone config itself — it exports/migrates with the zone — and no
 * boot path consumes it, so writes apply SYNCHRONOUSLY through zonecfg's
 * offline store (never task/accrue). Readers look at the config fresh:
 * orchestration reads boot_priority at host power events, vnc/start reads
 * consoleport/consolehost when it spawns `zadm vnc`. null/'' removes the attr.
 */
export const ZONE_ATTR_FIELDS = ['boot_priority', 'consoleport', 'consolehost'];

export const STOPPED_STATUSES = ['configured', 'incomplete', 'installed', 'down', 'not_found'];
