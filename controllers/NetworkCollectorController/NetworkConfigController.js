/**
 * @fileoverview Network Configuration Controller
 * @description Handles network interface configuration collection from various dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import yj from 'yieldable-json';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkParsingController from './NetworkParsingController.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Network Configuration Controller Class
 * @description Handles collection of network interface configuration data
 */
export class NetworkConfigController {
  constructor(hostMonitoringConfig, hostManager) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostManager = hostManager;
    this.parser = new NetworkParsingController();
    this.isCollecting = false;
  }

  /**
   * Process aggregate detailed information
   * @param {Object} aggr - Aggregate configuration object
   * @param {number} timeout - Command timeout
   */
  async processAggregateDetails(aggr, timeout) {
    try {
      // Get extended information with port details
      const { stdout: extendedOutput } = await execProm(
        `pfexec dladm show-aggr ${aggr.link} -x -p -o link,port,speed,duplex,state,address,portstate`,
        { timeout }
      );

      let aggregateSpeed = null;
      let aggregateState = 'unknown';
      let aggregateAddress = null;
      const portList = [];
      const ports = [];

      if (extendedOutput.trim()) {
        const portLines = extendedOutput.split('\n').filter(line => line.trim());

        portLines.forEach(line => {
          const [_linkName, port, speed, duplex, portState, address, portStateInfo] =
            line.split(':');
          void _linkName;

          if (!port) {
            // This is the aggregate summary line
            aggregateSpeed = speed ? parseInt(speed.replace('Mb', '')) || null : null;
            aggregateState = portState || 'unknown';
            aggregateAddress = address ? address.replace(/\\/g, '') : null;
          } else {
            // This is a port line
            ports.push({
              port,
              speed: speed ? parseInt(speed.replace('Mb', '')) || null : null,
              duplex,
              state: portState,
              address: address ? address.replace(/\\/g, '') : null,
              port_state: portStateInfo,
            });
            portList.push(port);
          }
        });
      }

      // Get LACP information
      await this.processLacpInfo(aggr, timeout);

      // Update aggregate record with detailed information
      aggr.speed = aggregateSpeed;
      aggr.state = aggregateState;
      aggr.macaddress = aggregateAddress;
      aggr.over = portList.length > 0 ? portList.join(',') : null;

      // Store port details as JSON
      if (ports.length > 0) {
        aggr.ports_detail = await new Promise((resolve, reject) => {
          yj.stringifyAsync(ports, (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          });
        });
      }
    } catch (detailError) {
      log.monitoring.warn('Failed to get detailed info for aggregate', {
        aggregate: aggr.link,
        error: detailError.message,
      });
    }
  }

  /**
   * Process LACP information for aggregate
   * @param {Object} aggr - Aggregate configuration object
   * @param {number} timeout - Command timeout
   */
  async processLacpInfo(aggr, timeout) {
    try {
      const { stdout: lacpOutput } = await execProm(
        `pfexec dladm show-aggr ${aggr.link} -L -p -o link,port,aggregatable,sync,coll,dist,defaulted,expired`,
        { timeout }
      );

      const lacpInfo = [];
      if (lacpOutput.trim()) {
        const lacpLines = lacpOutput.split('\n').filter(line => line.trim());

        lacpLines.forEach(line => {
          const [_linkName, port, aggregatable, sync, coll, dist, defaulted, expired] =
            line.split(':');
          void _linkName;
          lacpInfo.push({
            port,
            aggregatable: aggregatable === 'yes',
            sync: sync === 'yes',
            collecting: coll === 'yes',
            distributing: dist === 'yes',
            defaulted: defaulted === 'yes',
            expired: expired === 'yes',
          });
        });
      }

      // Store detailed LACP info as JSON
      if (lacpInfo.length > 0) {
        aggr.lacp_detail = await new Promise((resolve, reject) => {
          yj.stringifyAsync(lacpInfo, (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          });
        });
      }
    } catch (lacpError) {
      log.monitoring.warn('Failed to get LACP info for aggregate', {
        aggregate: aggr.link,
        error: lacpError.message,
      });
    }
  }

  /**
   * Collect aggregate configuration
   * @description Gathers aggregate configuration from dladm show-aggr
   */
  async collectAggregateConfig() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get basic aggregate configuration
      const { stdout: aggrOutput } = await execProm('pfexec dladm show-aggr', { timeout });
      const aggrData = this.parser.parseAggregateOutput(aggrOutput);

      // Process all aggregates in parallel to avoid await-in-loop
      await Promise.all(aggrData.map(aggr => this.processAggregateDetails(aggr, timeout)));

      return aggrData;
    } catch (error) {
      log.monitoring.warn('Failed to collect aggregate data', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return [];
    }
  }

  /**
   * Collect all interface types and merge data
   * @param {number} timeout - Command timeout
   * @returns {Array} Collected interface data
   */
  async collectAllInterfaceTypes(timeout) {
    const allInterfaces = [];

    // Collect VNIC information using parseable format for better accuracy
    try {
      const { stdout: vnicOutput } = await execProm(
        'pfexec dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE',
        { timeout }
      );
      const vnicData = this.parser.parseVnicParseable(vnicOutput);
      allInterfaces.push(...vnicData);
    } catch (error) {
      log.monitoring.warn(
        'Failed to collect VNIC data with parseable format, trying legacy format',
        {
          error: error.message,
          hostname: this.parser.hostname,
        }
      );
      // Fallback to legacy format
      try {
        const { stdout: vnicOutput } = await execProm('pfexec dladm show-vnic', { timeout });
        const vnicData = this.parser.parseVnicOutput(vnicOutput);
        allInterfaces.push(...vnicData);
      } catch (fallbackError) {
        log.monitoring.warn('Failed to collect VNIC data with legacy format', {
          error: fallbackError.message,
          hostname: this.parser.hostname,
        });
      }
    }

    // Collect and merge Ethernet, Physical, and Link data in parallel
    const interfaceTypes = [
      { command: 'pfexec dladm show-ether', parser: 'parseEtherOutput', name: 'Ethernet' },
      { command: 'pfexec dladm show-phys', parser: 'parsePhysOutput', name: 'Physical interface' },
      { command: 'pfexec dladm show-link', parser: 'parseLinkOutput', name: 'Link' },
    ];

    const interfaceResults = await Promise.allSettled(
      interfaceTypes.map(async interfaceType => {
        try {
          const { stdout } = await execProm(interfaceType.command, { timeout });
          return {
            data: this.parser[interfaceType.parser](stdout),
            type: interfaceType.name,
          };
        } catch (error) {
          log.monitoring.warn(`Failed to collect ${interfaceType.name} data`, {
            error: error.message,
            hostname: this.parser.hostname,
          });
          return { data: [], type: interfaceType.name };
        }
      })
    );

    // Process results and merge with existing interfaces
    interfaceResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value.data.length > 0) {
        result.value.data.forEach(interfaceData => {
          const existing = allInterfaces.find(iface => iface.link === interfaceData.link);
          if (existing) {
            this.mergeInterfaceData(existing, interfaceData);
          } else {
            allInterfaces.push(interfaceData);
          }
        });
      }
    });

    return allInterfaces;
  }

  /**
   * Merge interface data while preserving aggregate-specific fields
   * @param {Object} existing - Existing interface data
   * @param {Object} newData - New interface data to merge
   */
  mergeInterfaceData(existing, newData) {
    Object.keys(newData).forEach(key => {
      // Skip aggregate-specific fields to prevent overwriting
      if (
        existing.class === 'aggr' &&
        [
          'policy',
          'address_policy',
          'lacp_activity',
          'lacp_timer',
          'flags',
          'ports_detail',
          'lacp_detail',
          'speed',
          'state',
          'macaddress',
        ].includes(key)
      ) {
        return;
      }

      // Only assign if the new value is not null/undefined and existing is null/undefined
      if (
        newData[key] !== null &&
        newData[key] !== undefined &&
        (existing[key] === null || existing[key] === undefined || existing[key] === '')
      ) {
        existing[key] = newData[key];
      }
    });
  }

  /**
   * Deduplicate and finalize interface data
   * @param {Array} allInterfaces - Array of interface data
   * @returns {Array} Deduplicated interface data
   */
  deduplicateInterfaces(allInterfaces) {
    const uniqueInterfaces = new Map();

    allInterfaces.forEach(iface => {
      const key = `${iface.host}:${iface.link}:${iface.class}`;
      if (!uniqueInterfaces.has(key)) {
        uniqueInterfaces.set(key, iface);
      } else {
        // If we have a duplicate, merge the data (keep non-null values)
        const existing = uniqueInterfaces.get(key);
        this.mergeInterfaceData(existing, iface);
      }
    });

    return Array.from(uniqueInterfaces.values());
  }

  /**
   * Store interfaces in database with batch processing. The scan REPLACES the
   * host's whole row set, so links destroyed since the last scan leave no
   * ghost rows behind (a non-empty scan is required — a failed dladd sweep
   * never wipes the table).
   * @param {Array} interfaces - Interface data to store
   */
  async storeInterfacesInDatabase(interfaces) {
    if (interfaces.length === 0) {
      return;
    }
    await NetworkInterfaces.destroy({
      where: {
        host: this.parser.hostname,
      },
    });

    // Store in database in batches (process batches in parallel for better performance)
    const batchSize = this.hostMonitoringConfig.performance.batch_size;
    const batches = [];
    for (let i = 0; i < interfaces.length; i += batchSize) {
      const batch = interfaces.slice(i, i + batchSize);
      batches.push(NetworkInterfaces.bulkCreate(batch));
    }
    await Promise.all(batches);
  }

  /**
   * Collect network interface configuration
   * @description Gathers interface configuration from various dladm commands
   */
  async collectNetworkConfig() {
    if (this.isCollecting) {
      return undefined;
    }

    this.isCollecting = true;

    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Collect all interface types
      const allInterfaces = await this.collectAllInterfaceTypes(timeout);

      // Collect Aggregate information
      try {
        const aggregateData = await this.collectAggregateConfig();

        if (aggregateData.length > 0) {
          // Remove any existing aggregate entries from allInterfaces to prevent duplicates
          const aggregateLinks = aggregateData.map(aggr => aggr.link);
          const filteredInterfaces = allInterfaces.filter(
            iface => !aggregateLinks.includes(iface.link) || iface.class !== 'aggr'
          );

          // Add comprehensive aggregate data
          filteredInterfaces.push(...aggregateData);
          allInterfaces.length = 0; // Clear array
          allInterfaces.push(...filteredInterfaces); // Repopulate
        }
      } catch (error) {
        log.monitoring.warn('Failed to collect Aggregate data', {
          error: error.message,
          hostname: this.parser.hostname,
        });
      }

      // Deduplicate interfaces
      const finalInterfaces = this.deduplicateInterfaces(allInterfaces);

      // Store in database
      await this.storeInterfacesInDatabase(finalInterfaces);

      await this.hostManager.updateHostInfo({ last_network_scan: new Date() });
      await this.hostManager.resetErrorCount();

      log.monitoring.debug('Network configuration collected', {
        interface_count: finalInterfaces.length,
        hostname: this.parser.hostname,
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.hostManager.handleError(error, 'Network config collection');
      if (!shouldContinue) {
        this.isCollecting = false;
        return false;
      }
      return false;
    } finally {
      this.isCollecting = false;
    }
  }
}

export default NetworkConfigController;
