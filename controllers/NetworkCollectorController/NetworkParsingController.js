/**
 * @fileoverview Network Parsing Controller
 * @description Handles parsing of network command outputs (dladm, ipadm, netstat)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import os from 'os';

/**
 * Network Parsing Controller Class
 * @description Contains all parsing methods for network commands
 */
export class NetworkParsingController {
  constructor() {
    this.hostname = os.hostname();
  }

  /**
   * Parse duplex information from speed field
   * @param {string} speedField - Speed field from command output
   * @returns {string|null} Duplex setting or null
   */
  parseDuplexFromSpeed(speedField) {
    if (speedField.includes('-h')) {
      return 'half';
    }
    if (speedField.includes('-f')) {
      return 'full';
    }
    return null;
  }

  /**
   * Parse dladm show-vnic output (parseable format)
   * @param {string} output - Command output from dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE
   * @returns {Array} Parsed interface data
   */
  parseVnicParseable(output) {
    const lines = output.trim().split('\n');
    const interfaces = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Split by colon, but handle escaped colons in MAC addresses
      const parts = trimmed.split(':');
      if (parts.length >= 7) {
        // Handle escaped MAC address format (f2\:2\:0\:1\:0\:1 becomes f2:2:0:1:0:1)
        const macStart = 3; // MAC address starts at index 3
        let macEnd = macStart;

        // Find where the MAC address ends (look for 'fixed' or 'random')
        for (let i = macStart; i < parts.length; i++) {
          if (parts[i] === 'fixed' || parts[i] === 'random') {
            macEnd = i;
            break;
          }
        }

        // Reconstruct MAC address
        const macAddress = parts.slice(macStart, macEnd).join(':').replace(/\\/g, '');

        interfaces.push({
          host: this.hostname,
          link: parts[0],
          class: 'vnic',
          over: parts[1],
          speed: parseInt(parts[2]) || null,
          macaddress: macAddress,
          macaddrtype: parts[macEnd], // 'fixed' or 'random'
          vid: parseInt(parts[macEnd + 1]) || null,
          zone: parts[macEnd + 2] !== '--' ? parts[macEnd + 2] : null,
          scan_timestamp: new Date(),
        });
      }
    }

    return interfaces;
  }

  /**
   * Parse dladm show-vnic output (legacy table format)
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseVnicOutput(output) {
    const lines = output.trim().split('\n');
    const interfaces = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        interfaces.push({
          host: this.hostname,
          link: parts[0],
          class: 'vnic',
          over: parts[1],
          speed: parseInt(parts[2]) || null,
          macaddress: parts[3],
          macaddrtype: parts[4],
          vid: parseInt(parts[5]) || null,
          zone: parts[6] || null,
          scan_timestamp: new Date(),
        });
      }
    }

    return interfaces;
  }

  /**
   * Parse dladm show-ether output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseEtherOutput(output) {
    const lines = output.trim().split('\n');
    const interfaces = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 5) {
        interfaces.push({
          host: this.hostname,
          link: parts[0],
          ptype: parts[1],
          state: parts[2],
          auto: parts[3],
          speed: parts[4].includes('G') ? parseInt(parts[4]) * 1000 : parseInt(parts[4]) || null,
          duplex: this.parseDuplexFromSpeed(parts[4]),
          pause: parts[5] || null,
          scan_timestamp: new Date(),
        });
      }
    }

    return interfaces;
  }

  /**
   * Parse dladm show-phys output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parsePhysOutput(output) {
    const lines = output.trim().split('\n');
    const interfaces = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        interfaces.push({
          host: this.hostname,
          link: parts[0],
          class: 'phys',
          media: parts[1],
          state: parts[2],
          speed: parseInt(parts[3]) || null,
          duplex: parts[4],
          device: parts[5],
          scan_timestamp: new Date(),
        });
      }
    }

    return interfaces;
  }

  /**
   * Parse dladm show-link output
   * @param {string} output - Command output
   * @returns {Array} Parsed interface data
   */
  parseLinkOutput(output) {
    const lines = output.trim().split('\n');
    const interfaces = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Skip header lines - check for common header keywords
      if (
        trimmed.includes('LINK') &&
        (trimmed.includes('CLASS') || trimmed.includes('MTU') || trimmed.includes('STATE'))
      ) {
        continue;
      }

      // Skip separator lines
      if (trimmed.includes('---') || trimmed.includes('===')) {
        continue;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 5) {
        // Additional validation - skip if first part looks like a header
        if (parts[0] === 'LINK' || parts[0].includes('LINK')) {
          continue;
        }

        interfaces.push({
          host: this.hostname,
          link: parts[0],
          class: parts[1],
          mtu: parseInt(parts[2]) || null,
          state: parts[3],
          bridge: parts[4] !== '--' ? parts[4] : null,
          over: parts[5] !== '--' ? parts[5] : null,
          scan_timestamp: new Date(),
        });
      }
    }

    return interfaces;
  }

  /**
   * Parse dladm show-link -s -p output (parseable statistics)
   * @param {string} output - Command output from parseable format
   * @returns {Array} Parsed statistics data
   */
  parseStatsOutput(output) {
    const lines = output.trim().split('\n');
    const stats = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Skip any line that looks like a header (contains non-numeric data in expected numeric fields)
      if (this.isHeaderLine(trimmed)) {
        continue;
      }

      const parts = trimmed.split(':');
      if (parts.length >= 7) {
        // Validate that numeric fields are actually numeric
        const [link, ipackets, rbytes, ierrors, opackets, obytes, oerrors] = parts;

        // Skip if any expected numeric field contains non-numeric data
        if (
          !this.isValidNumericField(ipackets) ||
          !this.isValidNumericField(rbytes) ||
          !this.isValidNumericField(ierrors) ||
          !this.isValidNumericField(opackets) ||
          !this.isValidNumericField(obytes) ||
          !this.isValidNumericField(oerrors)
        ) {
          continue;
        }

        // Skip if link name contains header keywords
        if (this.isHeaderKeyword(link)) {
          continue;
        }

        stats.push({
          host: this.hostname,
          link,
          ipackets,
          rbytes,
          ierrors,
          opackets,
          obytes,
          oerrors,
          scan_timestamp: new Date(),
        });
      }
    }

    return stats;
  }

  /**
   * Parse dladm show-usage output
   * @param {string} output - Command output
   * @returns {Array} Parsed usage data
   */
  parseUsageOutput(output) {
    const lines = output.trim().split('\n');
    const usage = [];

    let headerFound = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      // Skip header line - look for the line with column headers
      if (
        trimmed.includes('LINK') &&
        trimmed.includes('DURATION') &&
        trimmed.includes('BANDWIDTH')
      ) {
        headerFound = true;
        continue;
      }

      // Skip lines until we find the header
      if (!headerFound) {
        continue;
      }

      // Skip separator lines
      if (trimmed.includes('---')) {
        continue;
      }

      // Parse data lines - use more careful parsing to handle long interface names
      const parts = trimmed.split(/\s+/);

      // Need at least 7 parts for valid data
      if (parts.length >= 7) {
        const [linkName, durationStr, ipackets, rbytes, opackets, obytes] = parts;

        // Skip header data that might have been parsed as a row
        if (
          linkName === 'LINK' ||
          linkName.includes('DURATION') ||
          linkName.includes('BANDWIDTH')
        ) {
          continue;
        }

        // Extract bandwidth string and parse numeric value
        const bandwidthStr = parts.slice(6).join(' ');
        const bandwidthMatch = bandwidthStr.match(/(?<speed>[0-9.]+)\s*Mbps/);
        const bandwidthMbps = bandwidthMatch ? parseFloat(bandwidthMatch.groups.speed) : null;

        usage.push({
          host: this.hostname,
          link: linkName,
          duration: parseInt(durationStr) || null,
          ipackets,
          rbytes,
          opackets,
          obytes,
          bandwidth: bandwidthStr,
          bandwidth_mbps: bandwidthMbps,
          scan_timestamp: new Date(),
        });
      }
    }

    return usage;
  }

  /**
   * Parse ipadm show-addr output
   * @param {string} output - Command output
   * @returns {Array} Parsed IP address data
   */
  parseIPAddrOutput(output) {
    const lines = output.trim().split('\n');
    const addresses = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const [addrobj, type, state, addr] = parts;
        const [interfaceName] = addrobj.split('/');
        const ipVersion = addrobj.includes('/v6') ? 'v6' : 'v4';

        // Parse IP and prefix
        let ipAddress = addr;
        let prefixLength = null;

        if (addr.includes('/')) {
          const [ip, prefix] = addr.split('/');
          ipAddress = ip;
          prefixLength = parseInt(prefix) || null;
        }

        addresses.push({
          host: this.hostname,
          addrobj,
          interface: interfaceName,
          type,
          state,
          addr,
          ip_address: ipAddress,
          prefix_length: prefixLength,
          ip_version: ipVersion,
          scan_timestamp: new Date(),
        });
      }
    }

    return addresses;
  }

  /**
   * Parse netstat -rn output
   * @param {string} output - Command output
   * @returns {Array} Parsed routing table data
   */
  parseRoutingOutput(output) {
    const lines = output.trim().split('\n');
    const routes = [];

    let currentIPVersion = null;
    let inDataSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect IP version sections
      if (trimmed.includes('Routing Table: IPv4')) {
        currentIPVersion = 'v4';
        inDataSection = false;
        continue;
      } else if (trimmed.includes('Routing Table: IPv6')) {
        currentIPVersion = 'v6';
        inDataSection = false;
        continue;
      }

      // Skip header lines
      if (trimmed.includes('Destination') || trimmed.includes('---') || !trimmed) {
        if (trimmed.includes('Destination')) {
          inDataSection = true;
        }
        continue;
      }

      if (!inDataSection || !currentIPVersion) {
        continue;
      }

      const parts = trimmed.split(/\s+/);

      if (currentIPVersion === 'v4' && parts.length >= 6) {
        const [destination, gateway, flags, refStr, use, interfaceName] = parts;
        const ref = parseInt(refStr) || null;

        routes.push({
          host: this.hostname,
          destination,
          gateway,
          flags,
          ref,
          use,
          interface: interfaceName,
          ip_version: currentIPVersion,
          is_default: destination === 'default',
          scan_timestamp: new Date(),
        });
      } else if (currentIPVersion === 'v6' && parts.length >= 6) {
        const [destinationMask, gateway, flags, refStr, use, interfaceName] = parts;
        const ref = parseInt(refStr) || null;

        routes.push({
          host: this.hostname,
          destination: destinationMask,
          destination_mask: destinationMask,
          gateway,
          flags,
          ref,
          use,
          interface: interfaceName,
          ip_version: currentIPVersion,
          is_default: destinationMask === 'default' || destinationMask === '::/0',
          scan_timestamp: new Date(),
        });
      }
    }

    return routes;
  }

  /**
   * Parse dladm show-aggr output
   * @param {string} output - Command output
   * @returns {Array} Parsed aggregate data
   */
  parseAggregateOutput(output) {
    const lines = output.trim().split('\n');
    const aggregates = [];

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        aggregates.push({
          host: this.hostname,
          link: parts[0],
          class: 'aggr',
          policy: parts[1],
          address_policy: parts[2],
          lacp_activity: parts[3],
          lacp_timer: parts[4],
          flags: parts[5],
          scan_timestamp: new Date(),
        });
      }
    }

    return aggregates;
  }

  /**
   * Check if a line appears to be a header line
   * @param {string} line - Line to check
   * @returns {boolean} True if line appears to be a header
   */
  isHeaderLine(line) {
    const upperLine = line.toUpperCase();
    const headerKeywords = [
      'LINK',
      'IPACKETS',
      'RBYTES',
      'IERRORS',
      'OPACKETS',
      'OBYTES',
      'OERRORS',
    ];
    return headerKeywords.some(keyword => upperLine.includes(keyword));
  }

  /**
   * Check if a field contains valid numeric data
   * @param {string} field - Field to validate
   * @returns {boolean} True if field is valid numeric
   */
  isValidNumericField(field) {
    if (!field || field === '') {
      return false;
    }
    // Check if it's a number (including 0)
    return /^\d+$/.test(field);
  }

  /**
   * Check if a string contains header keywords
   * @param {string} str - String to check
   * @returns {boolean} True if string contains header keywords
   */
  isHeaderKeyword(str) {
    if (!str) {
      return false;
    }
    const upperStr = str.toUpperCase();
    const keywords = ['LINK', 'IPACKETS', 'RBYTES', 'IERRORS', 'OPACKETS', 'OBYTES', 'OERRORS'];
    return keywords.includes(upperStr);
  }
}

export default NetworkParsingController;
