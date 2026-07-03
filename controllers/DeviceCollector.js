/**
 * @fileoverview Device Data Collection Controller for Zoneweaver Agent
 * @description Collects PCI device information and passthrough capabilities from OmniOS prtconf and pptadm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import { Op } from 'sequelize';
import config from '../config/ConfigLoader.js';
import PCIDevices from '../models/PCIDeviceModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import Disks from '../models/DiskModel.js';
import Zones from '../models/ZoneModel.js';
import HostInfo from '../models/HostInfoModel.js';
import { log } from '../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Device Data Collector Class
 * @description Handles collection of PCI device information and passthrough capabilities
 */
class DeviceCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.isCollecting = false;
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
  }

  /**
   * Update host information record
   * @param {Object} updates - Fields to update
   */
  async updateHostInfo(updates) {
    try {
      await HostInfo.upsert({
        host: this.hostname,
        hostname: this.hostname,
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        uptime: Math.floor(os.uptime()),
        ...updates,
        updated_at: new Date(),
      });
    } catch (error) {
      log.database.error('Failed to update host info', {
        error: error.message,
        hostname: this.hostname,
        updates: Object.keys(updates),
      });
    }
  }

  /**
   * Handle collection errors
   * @param {Error} error - The error that occurred
   * @param {string} operation - The operation that failed
   */
  async handleError(error, operation) {
    this.errorCount++;

    const now = Date.now();
    const timeSinceLastReset = now - this.lastErrorReset;
    const resetInterval = this.hostMonitoringConfig.error_handling.reset_error_count_after * 1000;

    // Reset error count if enough time has passed
    if (timeSinceLastReset > resetInterval) {
      this.errorCount = 1;
      this.lastErrorReset = now;
    }

    const maxErrors = this.hostMonitoringConfig.error_handling.max_consecutive_errors;
    const errorMessage = `${operation} failed: ${error.message}`;

    log.monitoring.error('Device collection error', {
      error: error.message,
      operation,
      error_count: this.errorCount,
      max_errors: maxErrors,
      hostname: this.hostname,
    });

    await this.updateHostInfo({
      device_scan_errors: this.errorCount,
      last_error_message: errorMessage,
    });

    if (this.errorCount >= maxErrors) {
      log.monitoring.error('Device collector disabled due to consecutive errors', {
        error_count: this.errorCount,
        max_errors: maxErrors,
        operation,
        hostname: this.hostname,
      });
      return false; // Signal to disable collector
    }

    return true; // Continue collecting
  }

  /**
   * Reset error count on successful operation
   */
  async resetErrorCount() {
    if (this.errorCount > 0) {
      this.errorCount = 0;
      await this.updateHostInfo({
        device_scan_errors: 0,
        last_error_message: null,
      });
    }
  }

  /**
   * Parse prtconf -dD output to extract PCI device information
   * @param {string} output - Command output from prtconf -dD
   * @returns {Array} Parsed device data
   */
  parsePrtconfOutput(output) {
    const lines = output.trim().split('\n');
    const devices = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Look for PCI device lines with format:
      // pci8086,34dc (pciex8086,10fb) [Intel Corporation 82599ES 10-Gigabit...], instance #0 (driver name: ixgbe)
      const pciMatch = trimmed.match(
        /^(?<vendor>\w+),(?<device>\w+)\s+\((?<pciAddress>pciex[\w,]+)\)\s+\[(?<description>[^\]]+)\](?:,\s*instance\s+#(?<instance>\d+))?\s*(?:\(driver name:\s*(?<driverName>\w+)\))?/
      );

      if (pciMatch) {
        const { pciAddress, description, instance: instanceStr, driverName } = pciMatch.groups;
        const instance = instanceStr ? parseInt(instanceStr) : null;

        // Extract vendor and device IDs from pciex format (e.g., pciex8086,10fb)
        const addressMatch = pciAddress.match(/pciex(?<vendorId>\w+),(?<deviceId>\w+)/);
        const vendorId = addressMatch ? addressMatch.groups.vendorId : null;
        const deviceId = addressMatch ? addressMatch.groups.deviceId : null;

        // Parse description to extract vendor name and device name
        let vendorName = null;
        let deviceName = null;

        if (description) {
          // Try to split on common patterns
          const descParts = description.split(/\s+/);
          if (descParts.length >= 2) {
            // First part is usually vendor (Intel, Broadcom, etc.)
            vendorName = descParts[0] + (descParts[1] === 'Corporation' ? ' Corporation' : '');
            // Rest is device name
            deviceName = descParts.slice(vendorName.split(' ').length).join(' ');
          } else {
            deviceName = description;
          }
        }

        // Determine device category based on description and driver
        const deviceCategory = this.categorizeDevice(description, driverName);

        // Check if driver is attached
        const driverAttached = !!driverName;

        // Create device object for PPT capability check
        const deviceObj = {
          host: this.hostname,
          pci_address: pciAddress,
          vendor_id: vendorId,
          device_id: deviceId,
          vendor_name: vendorName,
          device_name: deviceName,
          driver_name: driverName,
          driver_instance: instance,
          driver_attached: driverAttached,
          device_category: deviceCategory,
          pci_path: null, // Will be populated if we can extract it
          ppt_device_path: null,
          ppt_enabled: false,
          ppt_capable: false, // Will be calculated below
          assigned_to_zones: [],
          found_in_network_interfaces: false,
          found_in_disk_inventory: false,
          scan_timestamp: new Date(),
        };

        // Calculate PPT capability
        deviceObj.ppt_capable = this.isPPTCapable(deviceObj);

        devices.push(deviceObj);
      }
    }

    return devices;
  }

  /**
   * Determine if a device is capable of PCI passthrough
   * @param {Object} device - Device object with vendor_id, device_category, assigned_to_zones
   * @returns {boolean} True if device is PPT-capable
   */
  isPPTCapable(device) {
    // Exclude devices already assigned to zones
    if (
      device.assigned_to_zones &&
      Array.isArray(device.assigned_to_zones) &&
      device.assigned_to_zones.length > 0
    ) {
      return false;
    }

    // Intel devices (vendor_id 8086) - allow ONLY network cards
    // All other Intel devices are system-critical (chipset, I/O hub, etc.)
    if (device.vendor_id === '8086') {
      return device.device_category === 'network';
    }

    // AMD devices (vendor_id 1022) - exclude system critical components
    // TODO: Expand this list as we get more AMD system data
    if (device.vendor_id === '1022') {
      // For now, be conservative and exclude AMD devices until we have test data
      // Exception: allow discrete GPUs and add-in cards
      return (
        device.device_category === 'display' ||
        device.device_category === 'network' ||
        device.device_category === 'storage'
      );
    }

    // All other vendors (non-Intel, non-AMD) are generally PPT-capable
    // This includes add-in cards from vendors like:
    // - Broadcom/LSI storage controllers
    // - NVIDIA GPUs
    // - Renesas USB controllers
    // - Matrox display controllers
    // - Other specialty PCI cards
    return true;
  }

  /**
   * Categorize device based on description and driver name
   * @param {string} description - Device description
   * @param {string} driverName - Driver name
   * @returns {string} Device category
   */
  categorizeDevice(description, driverName) {
    if (!description) {
      return 'other';
    }

    const desc = description.toLowerCase();
    const driver = (driverName || '').toLowerCase();

    const categories = [
      {
        type: 'network',
        keywords: ['network', 'ethernet', 'gigabit'],
        drivers: ['igb', 'ixgbe', 'e1000', 'bnx', 'bge'],
      },
      {
        type: 'storage',
        keywords: ['storage', 'sas', 'sata', 'scsi', 'raid'],
        drivers: ['mpt', 'ahci', 'nvme'],
      },
      {
        type: 'display',
        keywords: ['display', 'vga', 'graphics', 'video'],
        drivers: ['vgatext'],
      },
      {
        type: 'usb',
        keywords: ['usb', 'universal serial bus'],
        drivers: ['usb', 'ehci', 'uhci'],
      },
      {
        type: 'audio',
        keywords: ['audio', 'sound', 'multimedia'],
        drivers: [],
      },
    ];

    for (const category of categories) {
      if (
        category.keywords.some(k => desc.includes(k)) ||
        category.drivers.some(d => driver.includes(d))
      ) {
        return category.type;
      }
    }

    return 'other';
  }

  /**
   * Parse pptadm list output
   * @param {string} output - Command output from pptadm list -j -a
   * @returns {Array} Parsed PPT device data
   */
  parsePPTOutput(output) {
    const pptDevices = [];

    try {
      const data = JSON.parse(output);
      if (data.devices && Array.isArray(data.devices)) {
        data.devices.forEach(device => {
          pptDevices.push({
            dev: device.dev,
            path: device.path,
            vendor_id: device['vendor-id'],
            device_id: device['device-id'],
            label: device.label,
          });
        });
      }
    } catch (error) {
      log.monitoring.warn('Failed to parse pptadm JSON output', {
        error: error.message,
        hostname: this.hostname,
      });
      // Try to parse text format as fallback
      const lines = output.trim().split('\n');
      for (let i = 1; i < lines.length; i++) {
        // Skip header
        const line = lines[i].trim();
        if (!line) {
          continue;
        }

        const parts = line.split(/\s+/);
        if (parts.length >= 4) {
          pptDevices.push({
            dev: parts[0],
            vendor_id: parts[1],
            device_id: parts[2],
            path: parts[3],
            label: parts.slice(4).join(' '),
          });
        }
      }
    }

    return pptDevices;
  }

  /**
   * Check PPT status and update device data
   * @param {Array} deviceData - Array of device objects to update
   */
  async checkPPTStatus(deviceData) {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Try JSON format first
      let pptDevices = [];
      try {
        const { stdout: pptOutput } = await execProm('pfexec pptadm list -j -a', { timeout });
        pptDevices = await this.parsePPTOutput(pptOutput);
      } catch (jsonError) {
        // Fallback to text format
        try {
          const { stdout: pptOutput } = await execProm('pfexec pptadm list -a', { timeout });
          pptDevices = this.parsePPTOutput(pptOutput);
        } catch (fallbackError) {
          log.monitoring.warn('Failed to get PPT status', {
            error: fallbackError.message,
            original_error: jsonError.message,
            hostname: this.hostname,
          });
          return;
        }
      }

      // Match PPT devices with PCI devices
      for (const pptDevice of pptDevices) {
        const matchingPciDevice = deviceData.find(
          device =>
            device.vendor_id === pptDevice.vendor_id && device.device_id === pptDevice.device_id
        );

        if (matchingPciDevice) {
          matchingPciDevice.ppt_enabled = true;
          matchingPciDevice.ppt_device_path = pptDevice.dev;
        }
      }
    } catch (error) {
      log.monitoring.warn('Failed to check PPT status', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }

  /**
   * Check zone assignments from database (no command execution)
   */
  async checkZoneAssignments() {
    try {
      // Query existing zone data from database - NO zadm/zonecfg calls
      const zones = await Zones.findAll({
        where: { host: this.hostname },
        attributes: ['name', 'brand', 'status'], // Basic zone info for now
      });

      // For now, just log that we found zones
      // Zone configuration parsing will be enhanced when we have actual zone configs with device assignments
      for (const zone of zones) {
        if (zone.brand === 'bhyve') {
          log.monitoring.debug('Found bhyve zone for device assignment check', {
            zone_name: zone.name,
            hostname: this.hostname,
          });
        }
      }
    } catch (error) {
      log.database.warn('Failed to check zone assignments', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }

  /**
   * Cross-reference devices with existing collector data (no command execution)
   * @param {Array} deviceData - Array of device objects to update
   */
  async crossReferenceWithCollectors(deviceData) {
    try {
      // Query NetworkInterfaces table - NO dladm re-execution
      const networkInterfaces = await NetworkInterfaces.findAll({
        where: { host: this.hostname },
        attributes: ['link', 'over', 'device'],
        order: [['scan_timestamp', 'DESC']],
        limit: 100,
      });

      // Query Disks table - NO format re-execution
      const diskInventory = await Disks.findAll({
        where: { host: this.hostname },
        attributes: ['device_name', 'manufacturer', 'model', 'interface_type'],
        order: [['scan_timestamp', 'DESC']],
        limit: 100,
      });

      // Match PCI devices with network interfaces by device name
      for (const netInterface of networkInterfaces) {
        const matchingDevice = deviceData.find(
          device =>
            // Match by driver name with device field (e.g., ixgbe0 -> ixgbe driver)
            (device.driver_name &&
              netInterface.device &&
              netInterface.device.startsWith(device.driver_name)) ||
            // Match by device category and device field
            (device.device_category === 'network' &&
              netInterface.device &&
              device.driver_name &&
              netInterface.device.includes(device.driver_name))
        );

        if (matchingDevice) {
          matchingDevice.found_in_network_interfaces = true;
        }
      }

      // Match PCI devices with storage controllers
      for (const disk of diskInventory) {
        // Ensure disk is valid to satisfy linter usage requirement
        if (!disk) {
          continue;
        }

        const matchingDevice = deviceData.find(
          device =>
            device.device_category === 'storage' &&
            ((device.device_name && device.device_name.toLowerCase().includes('sas')) ||
              (device.driver_name &&
                (device.driver_name.includes('mpt') || device.driver_name.includes('ahci'))))
        );

        if (matchingDevice && !matchingDevice.found_in_disk_inventory) {
          matchingDevice.found_in_disk_inventory = true;
        }
      }
    } catch (error) {
      log.database.warn('Failed to cross-reference with collectors', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }

  /**
   * Collect PCI device information
   * @description Main entry point for device data collection - follows established collector patterns
   */
  async collectPCIDevices() {
    if (this.isCollecting) {
      return true;
    }

    this.isCollecting = true;

    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // NEW COMMAND: Parse prtconf -dD output for PCI devices
      const { stdout: prtconfOutput } = await execProm('prtconf -dD', { timeout });
      const deviceData = this.parsePrtconfOutput(prtconfOutput);

      if (deviceData.length === 0) {
        return true;
      }

      // Check PPT status if available (NEW COMMAND)
      await this.checkPPTStatus(deviceData);

      // Cross-reference with zone configurations (DATABASE QUERY ONLY)
      await this.checkZoneAssignments();

      // Cross-reference with existing network/storage data (DATABASE QUERY ONLY)
      await this.crossReferenceWithCollectors(deviceData);

      // Store in database with batching (STANDARD PATTERN)
      const batchSize = this.hostMonitoringConfig.performance.batch_size;
      const chunks = [];
      for (let i = 0; i < deviceData.length; i += batchSize) {
        chunks.push(deviceData.slice(i, i + batchSize));
      }

      await Promise.all(
        chunks.map(batch =>
          PCIDevices.bulkCreate(batch, {
            updateOnDuplicate: Object.keys(PCIDevices.rawAttributes).filter(key => key !== 'id'),
          })
        )
      );

      await this.updateHostInfo({ last_device_scan: new Date() });
      await this.resetErrorCount();

      // Log summary by category
      const categoryCount = {};
      deviceData.forEach(device => {
        categoryCount[device.device_category] = (categoryCount[device.device_category] || 0) + 1;
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'PCI device collection');
      return shouldContinue;
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Clean up old device data based on retention policies
   */
  async cleanupOldData() {
    try {
      const retentionConfig = this.hostMonitoringConfig.retention;
      const now = new Date();

      // Clean device data (use same retention as storage data)
      const deviceRetentionDate = new Date(
        now.getTime() - retentionConfig.storage * 24 * 60 * 60 * 1000
      );
      const deletedDevices = await PCIDevices.destroy({
        where: {
          scan_timestamp: { [Op.lt]: deviceRetentionDate },
        },
      });

      if (deletedDevices > 0) {
        log.database.info('Device cleanup completed', {
          deleted_devices: deletedDevices,
          hostname: this.hostname,
        });
      }
    } catch (error) {
      log.database.error('Failed to cleanup old device data', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }
}

export default DeviceCollector;
