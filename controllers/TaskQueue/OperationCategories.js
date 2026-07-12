/**
 * @fileoverview Static operation category mappings for task queue conflict detection
 */

/**
 * Operation categories for conflict detection
 * Operations in the same category cannot run simultaneously
 */
export const OPERATION_CATEGORIES = {
  // Package management operations
  pkg_install: 'package_management',
  pkg_uninstall: 'package_management',
  pkg_update: 'package_management',
  pkg_refresh: 'package_management',
  beadm_create: 'package_management',
  beadm_delete: 'package_management',
  beadm_activate: 'package_management',
  beadm_mount: 'package_management',
  beadm_unmount: 'package_management',
  repository_add: 'package_management',
  repository_remove: 'package_management',
  repository_modify: 'package_management',
  repository_enable: 'package_management',
  repository_disable: 'package_management',

  // Network datalink operations
  create_vnic: 'network_datalink',
  delete_vnic: 'network_datalink',
  set_vnic_properties: 'network_datalink',
  create_aggregate: 'network_datalink',
  delete_aggregate: 'network_datalink',
  modify_aggregate_links: 'network_datalink',
  create_etherstub: 'network_datalink',
  delete_etherstub: 'network_datalink',
  create_vlan: 'network_datalink',
  delete_vlan: 'network_datalink',
  create_bridge: 'network_datalink',
  delete_bridge: 'network_datalink',
  modify_bridge_links: 'network_datalink',

  // Network NAT/forwarding operations
  create_nat_rule: 'network_nat',
  delete_nat_rule: 'network_nat',
  configure_forwarding: 'network_nat',

  // Network DHCP operations
  dhcp_update_config: 'network_dhcp',
  dhcp_add_host: 'network_dhcp',
  dhcp_remove_host: 'network_dhcp',
  dhcp_service_control: 'network_dhcp',

  // Network IP operations
  create_ip_address: 'network_ip',
  delete_ip_address: 'network_ip',
  enable_ip_address: 'network_ip',
  disable_ip_address: 'network_ip',

  // System operations
  set_hostname: 'system_config',
  update_time_sync_config: 'system_config',
  force_time_sync: 'system_config',
  set_timezone: 'system_config',

  // System host operations (exclusive - only one system host operation at a time)
  system_host_restart: 'system_host_management',
  system_host_reboot: 'system_host_management',
  system_host_reboot_fast: 'system_host_management',
  system_host_shutdown: 'system_host_management',
  system_host_poweroff: 'system_host_management',
  system_host_halt: 'system_host_management',
  system_host_runlevel_change: 'system_host_management',

  // User management operations
  user_create: 'user_management',
  user_modify: 'user_management',
  user_delete: 'user_management',
  user_set_password: 'user_management',
  user_lock: 'user_management',
  user_unlock: 'user_management',
  group_create: 'user_management',
  group_modify: 'user_management',
  group_delete: 'user_management',
  role_create: 'user_management',
  role_modify: 'user_management',
  role_delete: 'user_management',

  // ZFS dataset operations
  zfs_create_dataset: 'zfs_dataset',
  zfs_destroy_dataset: 'zfs_dataset',
  zfs_set_properties: 'zfs_dataset',
  zfs_clone_dataset: 'zfs_dataset',
  zfs_promote_dataset: 'zfs_dataset',
  zfs_rename_dataset: 'zfs_dataset',

  // ZFS snapshot operations
  zfs_create_snapshot: 'zfs_snapshot',
  zfs_destroy_snapshot: 'zfs_snapshot',
  zfs_rollback_snapshot: 'zfs_snapshot',
  zfs_hold_snapshot: 'zfs_snapshot',
  zfs_release_snapshot: 'zfs_snapshot',

  // ZFS pool operations
  zpool_create: 'zfs_pool',
  zpool_destroy: 'zfs_pool',
  zpool_set_properties: 'zfs_pool',
  zpool_add_vdev: 'zfs_pool',
  zpool_remove_vdev: 'zfs_pool',
  zpool_replace_device: 'zfs_pool',
  zpool_online_device: 'zfs_pool',
  zpool_offline_device: 'zfs_pool',
  zpool_scrub: 'zfs_pool',
  zpool_stop_scrub: 'zfs_pool',
  zpool_export: 'zfs_pool',
  zpool_import: 'zfs_pool',
  zpool_upgrade: 'zfs_pool',

  // Template operations
  template_download: 'template',
  template_upload: 'template',
  template_delete: 'template',
  template_export: 'template',
  template_move: 'template',

  // Provisioner registry operations (one import writes into the shared registry at a time)
  provisioner_import: 'provisioner_registry',

  // Zone lifecycle operations have NO category: per-zone exclusivity (the
  // task processor's busy-zone pick, the Go queue's per-machine rule) already
  // serializes work on one zone while different zones run in parallel — a
  // global lifecycle lock would serialize the whole fleet on one provision.
};
