import express from 'express';
import { registerCoreRoutes } from './CoreRoutes.js';
import { registerMachineRoutes } from './MachineRoutes.js';
import { registerMonitoringRoutes } from './MonitoringRoutes.js';
import { registerNetworkRoutes } from './NetworkRoutes.js';
import { registerStorageRoutes } from './StorageRoutes.js';
import { registerSystemRoutes } from './SystemRoutes.js';
import { registerSystemAdminRoutes } from './SystemAdminRoutes.js';

/**
 * @fileoverview Application router — assembles the per-domain route modules.
 * Registration order within each module is significant (specific routes
 * before parameterized ones); the modules themselves cover disjoint path
 * prefixes, so their relative order is not.
 */

const router = express.Router();

// Agent API v1 resource noun (architecture O1): `machines` is the canonical resource
// noun — every machine-scoped route is registered at /machines/* only.
registerCoreRoutes(router); // provisioning, version, UI/docs shims, public, api-keys, ws-ticket, settings
registerMachineRoutes(router); // machines, tasks, VNC/terminal/zlogin/SSH consoles
registerMonitoringRoutes(router); // /monitoring/*, swap, PCI devices
registerNetworkRoutes(router); // /network/* (addresses, vnics, aggregates, etherstubs, vlans, bridges, nat, dhcp)
registerSystemRoutes(router); // services, packages/updates, boot-envs, repos, time, faults, logs, syslog, processes
registerStorageRoutes(router); // ZFS ARC/datasets/pools, templates, artifacts, filesystem
registerSystemAdminRoutes(router); // system accounts, host power/runlevel, hosts/dns, database

export default router;
