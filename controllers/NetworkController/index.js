/**
 * @fileoverview Network Controller exports
 */

import { getHostname, getIPAddresses } from './NetworkQueryController.js';
import { setHostname } from './NetworkModificationController.js';
import {
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
} from './NetworkIPAddressController.js';

export { getHostname, getIPAddresses };
export { setHostname, createIPAddress, deleteIPAddress, enableIPAddress, disableIPAddress };

export default {
  getHostname,
  getIPAddresses,
  setHostname,
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
};
