/**
 * @fileoverview NTP and Chrony Parsers for Time Synchronization
 * @description Parse NTP peer status and Chrony sources with performance optimizations
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

/**
 * Parse NTP peer status from ntpq -p output
 * @param {string} ntpqOutput - Raw output from ntpq -p command
 * @returns {Array<Object>} Array of NTP peer objects
 */
export const parseNtpPeers = ntpqOutput => {
  const lines = ntpqOutput.split('\n');
  const peers = [];

  // Skip header lines and process peer data
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    // Parse peer line - format: remote refid st t when poll reach delay offset jitter
    const parts = line.split(/\s+/);
    if (parts.length >= 10) {
      const [remote] = parts;
      const peer = {
        indicator: remote.charAt(0), // *, +, -, x, ., space
        remote: remote.substring(1),
        refid: parts[1],
        stratum: parseInt(parts[2]) || 16,
        type: parts[3],
        when: parts[4],
        poll: parseInt(parts[5]) || 0,
        reach: parts[6],
        delay: parseFloat(parts[7]) || 0,
        offset: parseFloat(parts[8]) || 0,
        jitter: parseFloat(parts[9]) || 0,
      };

      // Determine peer status
      switch (peer.indicator) {
        case '*':
          peer.status = 'selected_primary';
          peer.description = 'Selected as primary time source';
          break;
        case '+':
          peer.status = 'selected_backup';
          peer.description = 'Selected as backup time source';
          break;
        case '-':
          peer.status = 'rejected';
          peer.description = 'Rejected by clustering algorithm';
          break;
        case 'x':
          peer.status = 'falseticker';
          peer.description = 'Rejected as false ticker';
          break;
        case '.':
          peer.status = 'excess';
          peer.description = 'Excess peer (not used)';
          break;
        case ' ':
        default:
          peer.status = 'candidate';
          peer.description = 'Candidate for selection';
          break;
      }

      // Calculate reachability percentage
      if (peer.reach !== '0') {
        const reachValue = parseInt(peer.reach, 8) || 0;
        peer.reachability_percent = Math.round((reachValue / 255) * 100);
      } else {
        peer.reachability_percent = 0;
      }

      peers.push(peer);
    }
  }

  return peers;
};

/**
 * Parse timing data from Chrony's "Last sample" field
 * @param {string} lastSample - Raw last sample string like "+928us[ +928us] +/-   19ms"
 * @returns {object} Object with delay, offset, jitter values (in milliseconds to match NTP format)
 */
export const parseChronySampleTiming = lastSample => {
  const timing = {
    delay: null, // Chrony doesn't provide delay equivalent
    offset: 0,
    jitter: 0,
  };

  if (!lastSample) {
    return timing;
  }

  // Parse offset from first value: "+928us[ +928us] +/-   19ms"
  const offsetMatch = lastSample.match(/(?<offset>[+-]?\d+(?:\.\d+)?)(?:us|ms|ns|s)/);
  if (offsetMatch) {
    let offsetValue = parseFloat(offsetMatch.groups.offset);
    // Convert to milliseconds to match NTP format
    if (lastSample.includes('us')) {
      offsetValue = offsetValue / 1000; // µs to ms
    } else if (lastSample.includes('ns')) {
      offsetValue = offsetValue / 1000000; // ns to ms
    } else if (
      lastSample.includes('s') &&
      !lastSample.includes('us') &&
      !lastSample.includes('ms')
    ) {
      offsetValue = offsetValue * 1000; // s to ms
    }
    // If 'ms', keep as-is
    timing.offset = offsetValue;
  }

  // Parse jitter from "+/-" value: "+928us[ +928us] +/-   19ms"
  const jitterMatch = lastSample.match(/\+\/- +(?<jitter>\d+(?:\.\d+)?)(?:us|ms|ns|s)/);
  if (jitterMatch) {
    let jitterValue = parseFloat(jitterMatch.groups.jitter);
    // Convert to milliseconds to match NTP format
    if (jitterMatch[0].includes('us')) {
      jitterValue = jitterValue / 1000; // µs to ms
    } else if (jitterMatch[0].includes('ns')) {
      jitterValue = jitterValue / 1000000; // ns to ms
    } else if (
      jitterMatch[0].includes('s') &&
      !jitterMatch[0].includes('us') &&
      !jitterMatch[0].includes('ms')
    ) {
      jitterValue = jitterValue * 1000; // s to ms
    }
    // If 'ms', keep as-is
    timing.jitter = jitterValue;
  }

  return timing;
};

/**
 * Parse Chrony sources from chronyc sources output
 * @param {string} chronycOutput - Raw output from chronyc sources command
 * @returns {Array<Object>} Array of chrony source objects
 */
export const parseChronySources = chronycOutput => {
  const lines = chronycOutput.split('\n');
  const sources = [];

  // Skip header lines and process source data
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    // Parse source line - format: MS Name/IP address Stratum Poll Reach LastRx Last sample
    const parts = line.split(/\s+/);
    if (parts.length >= 8) {
      const [msField] = parts;
      const lastSample = parts.slice(6).join(' ');
      const timing = parseChronySampleTiming(lastSample);

      const source = {
        mode_indicator: msField.charAt(0), // M field: ^, =, #, ?
        state_indicator: msField.charAt(1), // S field: *, +, -, x, ?, ~
        indicator: msField.charAt(1), // Add indicator field for frontend compatibility
        remote: parts[1], // Use 'remote' to match NTP peer structure
        stratum: parseInt(parts[2]) || 16,
        poll: parseInt(parts[3]) || 0,
        reach: parseInt(parts[4]) || 0,
        last_rx: parts[5],
        last_sample: lastSample,
        // Add timing fields to match NTP peer structure
        delay: timing.delay,
        offset: timing.offset,
        jitter: timing.jitter,
      };

      // Interpret mode indicator
      switch (source.mode_indicator) {
        case '^':
          source.mode = 'server';
          break;
        case '=':
          source.mode = 'peer';
          break;
        case '#':
          source.mode = 'local_reference';
          break;
        default:
          source.mode = 'unknown';
          break;
      }

      // Interpret state indicator
      switch (source.state_indicator) {
        case '*':
          source.status = 'selected_primary';
          source.description = 'Selected as primary time source';
          break;
        case '+':
          source.status = 'selected_backup';
          source.description = 'Selected as backup time source';
          break;
        case '-':
          source.status = 'rejected';
          source.description = 'Rejected by selection algorithm';
          break;
        case 'x':
          source.status = 'falseticker';
          source.description = 'Rejected as false ticker';
          break;
        case '?':
          source.status = 'unreachable';
          source.description = 'Connectivity lost';
          break;
        case '~':
          source.status = 'high_variance';
          source.description = 'Variable time source';
          break;
        default:
          source.status = 'candidate';
          source.description = 'Candidate for selection';
          break;
      }

      // Calculate reachability percentage (chrony uses octal like NTP)
      source.reachability_percent = Math.round((parseInt(source.reach, 8) / 255) * 100);

      sources.push(source);
    }
  }

  return sources;
};
