import { exec } from 'child_process';
import util from 'util';

const execProm = util.promisify(exec);

export const findPossibleFullInterfaceNames = (linkName, allInterfaces) => {
  if (allInterfaces.some(iface => iface.link === linkName)) {
    return [linkName];
  }

  const matches = allInterfaces
    .filter(iface => iface.link.startsWith(linkName))
    .map(iface => iface.link);

  return matches.length > 0 ? matches : [linkName];
};

export const correlateUsageWithInterfaces = (usageData, allInterfaces) => {
  const correlatedData = [];
  const usageGrouped = new Map();

  usageData.forEach(usage => {
    if (!usageGrouped.has(usage.link)) {
      usageGrouped.set(usage.link, []);
    }
    usageGrouped.get(usage.link).push(usage);
  });

  usageGrouped.forEach((usageEntries, linkName) => {
    const possibleMatches = findPossibleFullInterfaceNames(linkName, allInterfaces);

    if (possibleMatches.length === 1) {
      usageEntries.forEach(usage => {
        correlatedData.push({
          ...usage,
          full_interface_name: possibleMatches[0],
          is_truncated: possibleMatches[0] !== linkName,
          match_confidence: 'high',
        });
      });
    } else if (possibleMatches.length > 1) {
      usageEntries.forEach((usage, index) => {
        if (index < possibleMatches.length) {
          correlatedData.push({
            ...usage,
            full_interface_name: possibleMatches[index],
            is_truncated: true,
            match_confidence: 'medium',
            truncation_note: `One of ${possibleMatches.length} possible matches: ${possibleMatches.join(', ')}`,
          });
        } else {
          correlatedData.push({
            ...usage,
            full_interface_name: possibleMatches[0],
            is_truncated: true,
            match_confidence: 'low',
            truncation_note: `Extra entry - may represent aggregated data for: ${possibleMatches.join(', ')}`,
          });
        }
      });
    } else {
      usageEntries.forEach(usage => {
        correlatedData.push({
          ...usage,
          full_interface_name: linkName,
          is_truncated: false,
          match_confidence: 'unknown',
        });
      });
    }
  });

  return correlatedData;
};

export const collectSingleInterfaceUsage = async (interfaceName, acctFile, timeout, parser) => {
  try {
    let stdout;
    try {
      const { stdout: resultStdout } = await execProm(
        `pfexec dladm show-usage -f ${acctFile} ${interfaceName}`,
        {
          timeout,
        }
      );
      stdout = resultStdout;
    } catch (summaryError) {
      if (
        summaryError.message.includes('no records') ||
        summaryError.message.includes('not found')
      ) {
        return null;
      }

      try {
        const { stdout: detailedStdout } = await execProm(
          `pfexec dladm show-usage -a -f ${acctFile} ${interfaceName}`,
          { timeout }
        );
        stdout = detailedStdout;
      } catch (detailedError) {
        if (
          detailedError.message.includes('no records') ||
          detailedError.message.includes('not found')
        ) {
          return null;
        }
        throw detailedError;
      }
    }

    if (!stdout || !stdout.trim()) {
      return null;
    }

    const usageData = parser.parseUsageOutput(stdout);

    if (usageData.length > 0) {
      const [usage] = usageData;
      usage.link = interfaceName;
      return usage;
    }

    return null;
  } catch (error) {
    if (
      error.message.includes('no records') ||
      error.message.includes('not found') ||
      error.message.includes('invalid link')
    ) {
      return null;
    }
    throw error;
  }
};
