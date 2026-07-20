import { log } from '../../lib/Logger.js';

export const calculateBandwidthUtilization = (bytes, speedMbps, timePeriod, hostname) => {
  if (!bytes || !speedMbps || !timePeriod || speedMbps === 0) {
    return null;
  }

  const bytesNum = parseInt(bytes) || 0;

  if (isNaN(bytesNum) || isNaN(speedMbps) || isNaN(timePeriod)) {
    log.monitoring.debug('Invalid inputs in bandwidth utilization calculation', {
      bytes,
      speedMbps,
      timePeriod,
      hostname,
    });
    return null;
  }

  const bitsTransferred = bytesNum * 8;
  const maxBits = speedMbps * 1000000 * timePeriod;

  if (maxBits === 0) {
    return null;
  }

  const utilization = (bitsTransferred / maxBits) * 100;

  if (isNaN(utilization)) {
    log.monitoring.warn('NaN result in bandwidth utilization calculation', {
      bytes,
      speedMbps,
      timePeriod,
      hostname,
    });
    return null;
  }

  return Math.round(utilization * 100) / 100;
};

export const calculateInstantaneousBandwidth = (currentStats, previousStats, hostname) => {
  if (!previousStats) {
    return {
      rx_bps: null,
      tx_bps: null,
      rx_mbps: null,
      tx_mbps: null,
      time_delta: null,
    };
  }

  const currentTime = new Date(currentStats.scan_timestamp).getTime();
  const previousTime = new Date(previousStats.scan_timestamp).getTime();

  if (isNaN(currentTime) || isNaN(previousTime)) {
    log.monitoring.debug('Invalid timestamps in bandwidth calculation', {
      current_time: currentTime,
      previous_time: previousTime,
      hostname,
    });
    return {
      rx_bps: null,
      tx_bps: null,
      rx_mbps: null,
      tx_mbps: null,
      time_delta: null,
    };
  }

  const timeDelta = (currentTime - previousTime) / 1000;

  if (timeDelta <= 0) {
    return {
      rx_bps: null,
      tx_bps: null,
      rx_mbps: null,
      tx_mbps: null,
      time_delta: timeDelta,
    };
  }

  const currentRxBytes = parseInt(currentStats.rbytes) || 0;
  const previousRxBytes = parseInt(previousStats.rbytes) || 0;
  const currentTxBytes = parseInt(currentStats.obytes) || 0;
  const previousTxBytes = parseInt(previousStats.obytes) || 0;

  const rxBytes = Math.max(0, currentRxBytes - previousRxBytes);
  const txBytes = Math.max(0, currentTxBytes - previousTxBytes);

  const rxBps = rxBytes / timeDelta;
  const txBps = txBytes / timeDelta;

  const safeRxBps = isNaN(rxBps) ? null : Math.round(Math.max(0, rxBps));
  const safeTxBps = isNaN(txBps) ? null : Math.round(Math.max(0, txBps));
  const safeRxMbps =
    safeRxBps !== null ? Math.round(((safeRxBps * 8) / 1000000) * 100) / 100 : null;
  const safeTxMbps =
    safeTxBps !== null ? Math.round(((safeTxBps * 8) / 1000000) * 100) / 100 : null;

  return {
    rx_bps: safeRxBps,
    tx_bps: safeTxBps,
    rx_mbps: safeRxMbps,
    tx_mbps: safeTxMbps,
    time_delta: timeDelta,
  };
};

export const calculateDeltaValues = (currentStat, previousStat) => {
  const deltaValues = {
    ipackets_delta: null,
    rbytes_delta: null,
    ierrors_delta: null,
    opackets_delta: null,
    obytes_delta: null,
    oerrors_delta: null,
  };

  if (previousStat) {
    const currentIPackets = parseInt(currentStat.ipackets) || 0;
    const previousIPackets = parseInt(previousStat.ipackets) || 0;
    deltaValues.ipackets_delta = Math.max(0, currentIPackets - previousIPackets);

    const currentRBytes = parseInt(currentStat.rbytes) || 0;
    const previousRBytes = parseInt(previousStat.rbytes) || 0;
    deltaValues.rbytes_delta = Math.max(0, currentRBytes - previousRBytes);

    const currentIErrors = parseInt(currentStat.ierrors) || 0;
    const previousIErrors = parseInt(previousStat.ierrors) || 0;
    deltaValues.ierrors_delta = Math.max(0, currentIErrors - previousIErrors);

    const currentOPackets = parseInt(currentStat.opackets) || 0;
    const previousOPackets = parseInt(previousStat.opackets) || 0;
    deltaValues.opackets_delta = Math.max(0, currentOPackets - previousOPackets);

    const currentOBytes = parseInt(currentStat.obytes) || 0;
    const previousOBytes = parseInt(previousStat.obytes) || 0;
    deltaValues.obytes_delta = Math.max(0, currentOBytes - previousOBytes);

    const currentOErrors = parseInt(currentStat.oerrors) || 0;
    const previousOErrors = parseInt(previousStat.oerrors) || 0;
    deltaValues.oerrors_delta = Math.max(0, currentOErrors - previousOErrors);
  }

  return deltaValues;
};

export const createUsageRecord = (currentStat, previousStat, interfaceConfig, hostname) => {
  const deltaValues = calculateDeltaValues(currentStat, previousStat);
  const bandwidth = calculateInstantaneousBandwidth(currentStat, previousStat, hostname);

  let rxUtilization = null;
  let txUtilization = null;

  if (interfaceConfig && interfaceConfig.speed && bandwidth.time_delta && previousStat) {
    const { speed } = interfaceConfig;
    rxUtilization = calculateBandwidthUtilization(
      deltaValues.rbytes_delta,
      speed,
      bandwidth.time_delta,
      hostname
    );
    txUtilization = calculateBandwidthUtilization(
      deltaValues.obytes_delta,
      speed,
      bandwidth.time_delta,
      hostname
    );
  }

  const safeValue = value => {
    if (value === null || value === undefined) {
      return null;
    }
    if (isNaN(value)) {
      log.monitoring.debug('NaN value detected in usage record', {
        interface: currentStat.link,
        value,
        hostname,
      });
      return null;
    }
    return value;
  };

  return {
    host: hostname,
    link: currentStat.link,

    ipackets: currentStat.ipackets || null,
    rbytes: currentStat.rbytes || null,
    ierrors: currentStat.ierrors || null,
    opackets: currentStat.opackets || null,
    obytes: currentStat.obytes || null,
    oerrors: currentStat.oerrors || null,

    ipackets_delta: safeValue(deltaValues.ipackets_delta),
    rbytes_delta: safeValue(deltaValues.rbytes_delta),
    ierrors_delta: safeValue(deltaValues.ierrors_delta),
    opackets_delta: safeValue(deltaValues.opackets_delta),
    obytes_delta: safeValue(deltaValues.obytes_delta),
    oerrors_delta: safeValue(deltaValues.oerrors_delta),

    rx_bps: safeValue(bandwidth.rx_bps),
    tx_bps: safeValue(bandwidth.tx_bps),
    rx_mbps: safeValue(bandwidth.rx_mbps),
    tx_mbps: safeValue(bandwidth.tx_mbps),

    rx_utilization_pct: safeValue(rxUtilization),
    tx_utilization_pct: safeValue(txUtilization),

    interface_speed_mbps:
      interfaceConfig && interfaceConfig.speed ? safeValue(interfaceConfig.speed) : null,
    interface_class: interfaceConfig ? interfaceConfig.class : null,

    time_delta_seconds: safeValue(bandwidth.time_delta),
    scan_timestamp: new Date(),
  };
};
