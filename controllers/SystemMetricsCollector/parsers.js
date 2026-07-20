import os from 'os';
import { log } from '../../lib/Logger.js';

/**
 * Parse vmstat output for CPU and memory statistics
 * @param {string} output - vmstat command output
 * @returns {Object} Parsed statistics
 */
export const parseVmstatOutput = (output, hostname) => {
  const lines = output.trim().split('\n');
  const stats = {
    cpu: {},
    memory: {},
    processes: {},
  };

  try {
    // Find the data line (usually the last line)
    const dataLine = lines[lines.length - 1];
    const values = dataLine.trim().split(/\s+/);

    if (values.length >= 22) {
      // OmniOS vmstat format (approximate):
      // kthr      memory            page            disk          faults      cpu
      // r b   swap  free  re  mf pi po fr de sr s0 s1 s2 s3   in   sy   cs us sy id

      // Process statistics
      stats.processes.running = parseInt(values[0]) || 0;
      stats.processes.blocked = parseInt(values[1]) || 0;

      // Memory statistics (in KB typically)
      stats.memory.swap_kb = parseInt(values[2]) || 0;
      stats.memory.free_kb = parseInt(values[3]) || 0;

      // Page statistics
      stats.memory.page_reclaims = parseInt(values[4]) || 0;
      stats.memory.minor_faults = parseInt(values[5]) || 0;
      stats.memory.page_in = parseInt(values[6]) || 0;
      stats.memory.page_out = parseInt(values[7]) || 0;

      // System statistics
      stats.cpu.interrupts = parseInt(values[values.length - 6]) || 0;
      stats.cpu.system_calls = parseInt(values[values.length - 5]) || 0;
      stats.cpu.context_switches = parseInt(values[values.length - 4]) || 0;

      // CPU percentages
      stats.cpu.user_pct = parseFloat(values[values.length - 3]) || 0;
      stats.cpu.system_pct = parseFloat(values[values.length - 2]) || 0;
      stats.cpu.idle_pct = parseFloat(values[values.length - 1]) || 0;
    }
  } catch (error) {
    log.monitoring.warn('Failed to parse vmstat output', {
      error: error.message,
      hostname,
    });
  }

  return stats;
};

/**
 * Map kstat memory key to stats field
 * @param {string} key - Kstat key
 * @param {string} value - Kstat value
 * @param {Object} stats - Stats object to update
 */
export const mapKstatMemoryKey = (key, value, stats) => {
  const intValue = parseInt(value) || 0;

  if (key.endsWith(':physmem')) {
    stats.physmem_pages = intValue;
  } else if (key.endsWith(':freemem')) {
    stats.freemem_pages = intValue;
  } else if (key.endsWith(':availrmem')) {
    stats.availrmem_pages = intValue;
  } else if (key.endsWith(':pagestotal')) {
    stats.pagestotal_pages = intValue;
  } else if (key.endsWith(':pagesfree')) {
    stats.pagesfree_pages = intValue;
  } else if (key.endsWith(':pageslocked')) {
    stats.pageslocked_pages = intValue;
  } else if (key.endsWith(':lotsfree')) {
    stats.lotsfree_pages = intValue;
  } else if (key.endsWith(':desfree')) {
    stats.desfree_pages = intValue;
  } else if (key.endsWith(':minfree')) {
    stats.minfree_pages = intValue;
  } else if (key.endsWith(':pp_kernel')) {
    stats.pp_kernel_pages = intValue;
  } else if (key.endsWith(':nalloc')) {
    stats.page_allocs = intValue;
  } else if (key.endsWith(':nfree')) {
    stats.page_frees = intValue;
  } else if (key.endsWith(':nscan')) {
    stats.page_scans = intValue;
  }
};

/**
 * Parse kstat memory information
 * @param {string} output - kstat command output
 * @returns {Object} Memory statistics
 */
export const parseKstatMemory = output => {
  const stats = {};
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    // Handle kstat format: unix:0:system_pages:physmem     50313829
    // Split on whitespace, expecting key and value
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const [key] = parts;
      const value = parts[parts.length - 1]; // Take last part as value
      mapKstatMemoryKey(key, value, stats);
    }
  }

  // Set default page size (standard for most systems)
  stats.page_size_bytes = 4096;

  return stats;
};

/**
 * Parse swap -s output for swap statistics
 * @param {string} output - swap -s command output
 * @returns {Object} Swap statistics
 */
export const parseSwapOutput = (output, hostname) => {
  const stats = {};

  try {
    // Example: total: 8388608k bytes allocated + 0k reserved = 8388608k used, 16777216k available
    const match = output.match(
      /total:\s+(?<allocated>\d+)k.*?=\s+(?<used>\d+)k\s+used,\s+(?<available>\d+)k\s+available/
    );
    if (match) {
      const { allocated, used, available } = match.groups;
      stats.swap_allocated_kb = parseInt(allocated) || 0;
      stats.swap_used_kb = parseInt(used) || 0;
      stats.swap_available_kb = parseInt(available) || 0;
      stats.swap_total_kb = stats.swap_used_kb + stats.swap_available_kb;
    }
  } catch (error) {
    log.monitoring.warn('Failed to parse swap output', {
      error: error.message,
      hostname,
    });
  }

  return stats;
};

/**
 * Get load averages
 * @returns {Object} Load average statistics
 */
export const getLoadAverages = () => {
  const loadavg = os.loadavg();
  return {
    load_avg_1min: loadavg[0] || 0,
    load_avg_5min: loadavg[1] || 0,
    load_avg_15min: loadavg[2] || 0,
  };
};

/**
 * Parse swap -l output for detailed swap area information
 * @param {string} output - swap -l command output
 * @returns {Array} Array of swap area objects
 */
export const parseSwapListOutput = output => {
  const swapAreas = [];
  const lines = output.trim().split('\n');

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') {
      continue;
    }

    // Parse swap -l output format:
    // swapfile             dev    swaplo   blocks     free
    // /dev/zvol/dsk/rpool/swap 265,1         8 88080376 88080376
    const parts = line.split(/\s+/);

    if (parts.length >= 5) {
      const [swapfilePath, deviceInfo, swapLoRaw, blocksRaw, freeBlocksRaw] = parts;
      const swaplo = parseInt(swapLoRaw) || 0;
      const blocks = parseInt(blocksRaw) || 0;
      const freeBlocks = parseInt(freeBlocksRaw) || 0;

      // Calculate sizes in bytes (512-byte blocks)
      const sizeBytes = blocks * 512;
      const freeBytes = freeBlocks * 512;
      const usedBytes = sizeBytes - freeBytes;
      const utilizationPct = sizeBytes > 0 ? (usedBytes / sizeBytes) * 100 : 0;

      // Clean SwapAreaModel fields ONLY — there is no is_active/pool_assignment
      // column: presence in the table = active, pool derives from the zvol path
      swapAreas.push({
        swapfile: swapfilePath,
        dev: deviceInfo,
        swaplo,
        blocks,
        free: freeBlocks,
        size_bytes: sizeBytes,
        free_bytes: freeBytes,
        used_bytes: usedBytes,
        utilization_pct: utilizationPct,
        scan_timestamp: new Date(),
      });
    }
  }

  return swapAreas;
};

/**
 * Parse `zonestat -p -r summary` output into per-zone CPU figures.
 * Row shape (verified host-1162):
 * interval:summary:<zone>:<cpus-used>:<pct-of-host>%:-:-:<physK>:<pct>%:...
 * Bracketed pseudo-rows ([resource]/[total]/[system]) are skipped. The
 * memory columns are deliberately IGNORED — zonestat memory is not
 * meaningful for bhyve zones (guest RAM is not host-attributed); memory
 * rides the memory_cap kstats instead.
 * @param {string} output - zonestat parseable output
 * @returns {Object} zone name → {cpu_used, cpu_pct}
 */
export const parseZonestatSummary = output => {
  const zones = {};
  for (const line of output.split('\n')) {
    const parts = line.trim().split(':');
    if (parts[0] !== 'interval' || parts[1] !== 'summary') {
      continue;
    }
    const [, , name] = parts;
    if (!name || name.startsWith('[')) {
      continue;
    }
    zones[name] = {
      cpu_used: parseFloat(parts[3]) || 0,
      cpu_pct: parseFloat(parts[4]) || 0,
    };
  }
  return zones;
};

/**
 * Parse `kstat -p -m <module>` output into per-zone stat maps. Rows group
 * by module:instance; the group's own `zonename` stat is the canonical key
 * (the kstat NAME field truncates long zone names, the stat does not).
 * @param {string} output - kstat parseable output
 * @returns {Object} zone name → {stat: value, zonename: string}
 */
export const parseZoneKstats = output => {
  const groups = {};
  for (const line of output.split('\n')) {
    const match = line.match(
      /^(?<module>[^:]+):(?<instance>\d+):(?<name>\S+):(?<stat>\S+)\s+(?<value>.*)$/
    );
    if (!match) {
      continue;
    }
    const { instance, stat, value } = match.groups;
    groups[instance] = groups[instance] || {};
    groups[instance][stat] = value.trim();
  }
  const zones = {};
  for (const group of Object.values(groups)) {
    if (group.zonename) {
      zones[group.zonename] = group;
    }
  }
  return zones;
};
