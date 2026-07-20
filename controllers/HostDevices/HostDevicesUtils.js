/**
 * Determine if a device is capable of PCI passthrough
 * @param {Object} device - PCI device object
 * @returns {boolean} True if device is PPT-capable
 */
export const isPPTCapable = device => {
  if (
    device.assigned_to_zones &&
    Array.isArray(device.assigned_to_zones) &&
    device.assigned_to_zones.length > 0
  ) {
    return false;
  }

  if (device.vendor_id === '8086') {
    return device.device_category === 'network';
  }

  if (device.vendor_id === '1022') {
    return (
      device.device_category === 'display' ||
      device.device_category === 'network' ||
      device.device_category === 'storage'
    );
  }

  return true;
};
