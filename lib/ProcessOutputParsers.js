/**
 * prstat size spellings ("4096K", "1.5M") → bytes (converged structured-JSON
 * wire 2026-07-20: numerics, no formatted twins). Null when unparseable.
 * @param {string} text - prstat size token
 * @returns {number|null} Bytes
 */
const sizeToBytes = text => {
  const match = String(text).match(/^(?<num>[\d.]+)(?<unit>[KMGTP]?)$/u);
  if (!match) {
    return null;
  }
  const units = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return Math.round(Number(match.groups.num) * units[match.groups.unit]);
};

/**
 * prstat/ps time spellings ("0:00:12", "12:34") → whole seconds (same
 * converged wire). Null when unparseable.
 * @param {string} text - Clock-style time token
 * @returns {number|null} Seconds
 */
const timeToSeconds = text => {
  const parts = String(text).split(':').map(Number);
  if (parts.length === 0 || parts.some(Number.isNaN)) {
    return null;
  }
  return parts.reduce((acc, part) => acc * 60 + part, 0);
};

/**
 * Parses the output of the `prstat` command into structured JSON format.
 * @param {string} prstatOutput - The raw output from the `prstat` command.
 * @returns {Array<Object>} An array of process objects.
 */
export const parsePrstatOutput = prstatOutput => {
  const lines = prstatOutput.split('\n');
  const processes = [];

  let dataStartIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('PID') && lines[i].includes('USERNAME')) {
      dataStartIndex = i + 1;
      break;
    }
  }

  if (dataStartIndex === -1) {
    return processes;
  }

  for (let i = dataStartIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('Total:') && !line.includes('load averages')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 13) {
        processes.push({
          pid: parseInt(parts[0]),
          username: parts[1],
          size: sizeToBytes(parts[2]),
          rss: sizeToBytes(parts[3]),
          state: parts[4],
          pri: parseInt(parts[5]),
          nice: parseInt(parts[6]),
          cpu_time: timeToSeconds(parts[7]),
          cpu_percent: parseFloat(parts[8]),
          command: parts.slice(12).join(' '),
        });
      }
    }
  }

  return processes;
};

/**
 * Parses the output of the basic `ps` command into structured JSON format.
 * @param {string} psOutput - The raw output from the `ps` command.
 * @returns {Array<Object>} An array of process objects.
 */
export const parseBasicPsOutput = psOutput => {
  const lines = psOutput.split('\n');
  const processes = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const parts = line.split(/\s+/);
      if (parts.length >= 9) {
        processes.push({
          username: parts[0],
          pid: parseInt(parts[1]),
          ppid: parseInt(parts[2]),
          uid: parseInt(parts[3]),
          gid: parseInt(parts[4]),
          sid: parseInt(parts[5]),
          zone: parts[6],
          tty: parts[7],
          command: parts.slice(8).join(' '),
        });
      }
    }
  }

  return processes;
};

/**
 * Parses the output of detailed `ps auxww` or extended ps command into structured JSON format.
 * @param {string} psOutput - The raw output from the detailed ps command.
 * @returns {Array<Object>} An array of process objects with CPU/memory stats.
 */
export const parseDetailedPsOutput = psOutput => {
  const lines = psOutput.split('\n');
  const processes = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      const parts = line.split(/\s+/);

      if (parts.length >= 11 && parts[0] !== 'USER') {
        if (line.includes('%CPU') || parts[2] === undefined) {
          continue;
        }

        if (parts.length >= 15) {
          processes.push({
            username: parts[0],
            pid: parseInt(parts[1]),
            ppid: parseInt(parts[2]),
            uid: parseInt(parts[3]),
            gid: parseInt(parts[4]),
            zone: parts[5],
            tty: parts[6],
            cpu_percent: parseFloat(parts[7]),
            memory_percent: parseFloat(parts[8]),
            vsz: parseInt(parts[9]),
            rss: parseInt(parts[10]),
            state: parts[11],
            elapsed_time: parts[12],
            cpu_time: parts[13],
            command: parts.slice(14).join(' '),
          });
        } else {
          const commandStart = 10;
          processes.push({
            username: parts[0],
            pid: parseInt(parts[1]),
            cpu_percent: parseFloat(parts[2]),
            memory_percent: parseFloat(parts[3]),
            vsz: parseInt(parts[4]),
            rss: parseInt(parts[5]),
            tty: parts[6],
            state: parts[7],
            start_time: parts[8],
            cpu_time: parts[9],
            command: parts.slice(commandStart).join(' '),
          });
        }
      }
    }
  }

  return processes;
};
