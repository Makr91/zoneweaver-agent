/**
 * @fileoverview Reconciliation Service for Zoneweaver Agent
 * @description Periodically scans the host system and reconciles the database with the actual state of the system.
 * @author Mark Gilbert

 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import Zones from '../models/ZoneModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import { execSync } from 'child_process';
import os from 'os';
import { log } from '../lib/Logger.js';

class ReconciliationService {
  constructor() {
    this.reconciliationConfig = config.get('reconciliation') || {
      enabled: true,
      interval: 3600,
      log_level: 'info',
    };
    this.isReconciling = false;
  }

  async reconcile() {
    if (this.isReconciling) {
      return;
    }

    this.isReconciling = true;

    try {
      const startTime = Date.now();

      // Reconcile zones
      const zoneResults = await this.reconcileZones();

      // Reconcile network interfaces
      const networkResults = await this.reconcileNetworkInterfaces();

      const duration = Date.now() - startTime;

      // Only log if something was reconciled or took significant time
      if (zoneResults.orphaned > 0 || networkResults.total > 0 || duration > 5000) {
        log.monitoring.info('Reconciliation complete', {
          duration_ms: duration,
          zones_orphaned: zoneResults.orphaned,
          network_orphaned: networkResults.total,
        });
      }
    } catch (error) {
      log.monitoring.error('Error during reconciliation', {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isReconciling = false;
    }
  }

  async reconcileZones() {
    try {
      const systemZones = execSync('zoneadm list -c').toString().split('\n').filter(Boolean);
      const dbZones = await Zones.findAll({ where: { host: os.hostname() } });

      const zonesToDelete = dbZones.filter(dbZone => !systemZones.includes(dbZone.name));
      const orphaned = zonesToDelete.length;
      const orphanedZones = zonesToDelete.map(z => z.name);

      // Find orphaned zones
      await Promise.all(zonesToDelete.map(dbZone => dbZone.destroy()));

      if (orphaned > 0) {
        log.monitoring.warn('Orphaned zones removed from database', {
          count: orphaned,
          zones: orphanedZones,
        });
      }

      return { orphaned, zones: orphanedZones };
    } catch (error) {
      log.monitoring.error('Error reconciling zones', {
        error: error.message,
        stack: error.stack,
      });
      return { orphaned: 0, zones: [] };
    }
  }

  async reconcileNetworkInterfaces() {
    const results = {
      vnic: await this.reconcileResourceType('vnic', 'dladm show-vnic -p -o link'),
      aggr: await this.reconcileResourceType('aggr', 'dladm show-aggr -p -o link'),
      bridge: await this.reconcileResourceType('bridge', 'dladm show-bridge -p -o bridge'),
      etherstub: await this.reconcileResourceType('etherstub', 'dladm show-etherstub -p'),
      vlan: await this.reconcileResourceType('vlan', 'dladm show-vlan -p -o link'),
    };

    const total = Object.values(results).reduce((sum, count) => sum + count, 0);
    return { total, details: results };
  }

  async reconcileResourceType(resourceClass, command) {
    try {
      const systemResources = execSync(command)
        .toString()
        .split('\n')
        .filter(Boolean)
        .map(line => line.split(':')[0]);
      const dbResources = await NetworkInterfaces.findAll({
        where: { host: os.hostname(), class: resourceClass },
      });

      const resourcesToDelete = dbResources.filter(
        dbResource => !systemResources.includes(dbResource.link)
      );
      const orphaned = resourcesToDelete.length;
      const orphanedResources = resourcesToDelete.map(r => r.link);

      await Promise.all(resourcesToDelete.map(dbResource => dbResource.destroy()));

      if (orphaned > 0) {
        log.monitoring.warn(`Orphaned ${resourceClass} resources removed`, {
          class: resourceClass,
          count: orphaned,
          resources: orphanedResources,
        });
      }

      return orphaned;
    } catch (error) {
      log.monitoring.error(`Error reconciling ${resourceClass} resources`, {
        class: resourceClass,
        error: error.message,
        stack: error.stack,
      });
      return 0;
    }
  }

  start() {
    if (this.reconciliationConfig.enabled) {
      log.monitoring.info('Starting reconciliation service', {
        interval_seconds: this.reconciliationConfig.interval,
      });
      this.reconcile(); // Run on startup
      setInterval(() => {
        this.reconcile();
      }, this.reconciliationConfig.interval * 1000);
    }
  }
}

export default new ReconciliationService();
