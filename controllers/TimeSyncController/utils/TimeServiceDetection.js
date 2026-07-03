/**
 * @fileoverview Time Service Detection Utilities
 * @description Service detection and status checking using ServiceManager
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { getServices, getServiceDetails } from '../../../lib/ServiceManager.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Detect available time synchronization service using ServiceManager
 * @returns {Promise<{service: string, status: string, available: boolean, details?: object}>}
 */
export const detectTimeService = async () => {
  try {
    // Use ServiceManager to check for time sync services
    const timeServices = await getServices({ pattern: 'network/ntp*' });

    // Check for NTP first
    const ntpService = timeServices.find(svc => svc.fmri.includes('network/ntp:default'));
    if (ntpService) {
      const ntpDetails = await getServiceDetails(ntpService.fmri);
      return {
        service: 'ntp',
        status: ntpService.state === 'online' ? 'available' : 'disabled',
        available: true,
        details: ntpDetails,
      };
    }

    // Check for Chrony
    const chronyServices = await getServices({ pattern: 'network/chrony*' });
    const chronyService = chronyServices.find(svc => svc.fmri.includes('network/chrony:default'));
    if (chronyService) {
      const chronyDetails = await getServiceDetails(chronyService.fmri);
      return {
        service: 'chrony',
        status: chronyService.state === 'online' ? 'available' : 'disabled',
        available: true,
        details: chronyDetails,
      };
    }

    // Check for NTPsec
    const ntpsecServices = await getServices({ pattern: 'network/ntpsec*' });
    const ntpsecService = ntpsecServices.find(svc => svc.fmri.includes('network/ntpsec:default'));
    if (ntpsecService) {
      const ntpsecDetails = await getServiceDetails(ntpsecService.fmri);
      return {
        service: 'ntpsec',
        status: ntpsecService.state === 'online' ? 'available' : 'disabled',
        available: true,
        details: ntpsecDetails,
      };
    }

    return {
      service: 'none',
      status: 'unavailable',
      available: false,
      details: { note: 'No time synchronization service found (NTP, Chrony, or NTPsec)' },
    };
  } catch (error) {
    log.api.error('Error detecting time service', {
      error: error.message,
      stack: error.stack,
    });
    return {
      service: 'none',
      status: 'error',
      available: false,
      details: { error: error.message },
    };
  }
};

/**
 * Detect available time sync packages and services using ServiceManager and parallel operations
 * @returns {Promise<{current: object, available: object}>}
 */
export const detectAvailableTimeSyncSystems = async () => {
  const systems = {
    ntp: {
      package_name: 'service/network/ntp',
      service_name: 'svc:/network/ntp:default',
      config_file: '/etc/inet/ntp.conf',
      installed: false,
      enabled: false,
      active: false,
      can_switch_to: false,
    },
    chrony: {
      package_name: 'service/network/chrony',
      service_name: 'svc:/network/chrony:default',
      config_file: '/etc/inet/chrony.conf',
      installed: false,
      enabled: false,
      active: false,
      can_switch_to: false,
    },
    ntpsec: {
      package_name: 'service/network/ntpsec',
      service_name: 'svc:/network/ntpsec:default',
      config_file: '/etc/ntpsec/ntp.conf',
      installed: false,
      enabled: false,
      active: false,
      can_switch_to: false,
    },
  };

  try {
    // Get current service status
    const currentService = await detectTimeService();

    // Use Promise.all() for parallel package checking (performance optimization)
    const systemPromises = Object.entries(systems).map(async ([systemName, systemInfo]) => {
      // Check if package is installed
      const pkgResult = await executeCommand(`pkg list ${systemInfo.package_name} 2>/dev/null`);
      systemInfo.installed = pkgResult.success;

      if (systemInfo.installed) {
        // Use ServiceManager to check service status
        try {
          const services = await getServices({ pattern: `network/${systemName}` });
          const service = services.find(svc => svc.fmri.includes(`network/${systemName}:default`));

          if (service) {
            systemInfo.enabled = service.state !== 'disabled';
            systemInfo.active = service.state === 'online';
          }
        } catch {
          // Service not found or error
          systemInfo.enabled = false;
          systemInfo.active = false;
        }
      }

      // Determine if we can switch to this system
      systemInfo.can_switch_to =
        systemInfo.installed || (!systemInfo.installed && systemName !== currentService.service);

      return [systemName, systemInfo];
    });

    const systemResults = await Promise.all(systemPromises);

    // Rebuild systems object from results
    const finalSystems = {};
    for (const [systemName, systemInfo] of systemResults) {
      finalSystems[systemName] = systemInfo;
    }

    return {
      current: {
        service: currentService.service,
        status: currentService.status,
        available: currentService.available,
      },
      available: finalSystems,
      recommendations: {
        modern: 'chrony',
        traditional: 'ntp',
        secure: 'ntpsec',
        description:
          'Chrony is recommended for modern systems, NTP for compatibility, NTPsec for enhanced security',
      },
    };
  } catch (error) {
    log.api.error('Error detecting available time sync systems', {
      error: error.message,
      stack: error.stack,
    });

    return {
      current: {
        service: 'error',
        status: 'error',
        available: false,
      },
      available: systems,
      error: error.message,
    };
  }
};
