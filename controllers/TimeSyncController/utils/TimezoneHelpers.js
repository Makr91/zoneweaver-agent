/**
 * @fileoverview Timezone Helper Utilities for Time Synchronization
 * @description Timezone management and validation functions
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';

/**
 * Get current timezone from /etc/default/init
 * @returns {{success: boolean, timezone?: string, error?: string}}
 */
export const getCurrentTimezone = () => {
  try {
    if (!fs.existsSync('/etc/default/init')) {
      return { success: false, error: 'Timezone configuration file not found' };
    }

    const content = fs.readFileSync('/etc/default/init', 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('TZ=')) {
        const timezone = trimmed.substring(3).replace(/['"]/g, '');
        return { success: true, timezone };
      }
    }

    return { success: false, error: 'TZ variable not found in /etc/default/init' };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Get available timezones from the system using Promise.all() for performance
 * @returns {Promise<{success: boolean, timezones?: Array, error?: string}>}
 */
export const getAvailableTimezones = async () => {
  try {
    const zoneinfoPath = '/usr/share/lib/zoneinfo';
    if (!fs.existsSync(zoneinfoPath)) {
      return { success: false, error: 'Timezone database not found' };
    }

    // Read continent directories
    const continents = fs
      .readdirSync(zoneinfoPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name);

    // Use Promise.all() for parallel directory processing (performance optimization)
    const continentPromises = continents.map(continent => {
      const continentPath = path.join(zoneinfoPath, continent);
      const timezones = [];

      try {
        const cities = fs.readdirSync(continentPath, { withFileTypes: true });
        for (const city of cities) {
          if (city.isFile()) {
            timezones.push(`${continent}/${city.name}`);
          } else if (city.isDirectory()) {
            // Handle nested directories (like America/Argentina)
            try {
              const subcities = fs.readdirSync(path.join(continentPath, city.name));
              for (const subcity of subcities) {
                timezones.push(`${continent}/${city.name}/${subcity}`);
              }
            } catch {
              // Skip directories we can't read
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }

      return timezones;
    });

    const continentResults = await Promise.all(continentPromises);
    const allTimezones = continentResults.flat().sort();

    return { success: true, timezones: allTimezones };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Validate timezone exists on the system
 * @param {string} timezone - Timezone to validate
 * @returns {boolean} True if timezone exists
 */
export const validateTimezone = timezone => {
  try {
    const zonePath = `/usr/share/lib/zoneinfo/${timezone}`;
    return fs.existsSync(zonePath);
  } catch {
    return false;
  }
};
