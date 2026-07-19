import { verifyApiKey } from '../middleware/VerifyApiKey.js';
import {
  getHostname,
  setHostname,
  getIPAddresses as getManageableIPAddresses,
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
} from '../controllers/NetworkController/index.js';
import {
  getVNICs,
  getVNICDetails,
  createVNIC,
  deleteVNIC,
  getVNICStats,
  getVNICProperties,
  setVNICProperties,
} from '../controllers/VnicController/index.js';
import {
  getAggregates,
  getAggregateDetails,
  createAggregate,
  deleteAggregate,
  modifyAggregateLinks,
  getAggregateStats,
} from '../controllers/AggregateController.js';
import {
  getEtherstubs,
  getEtherstubDetails,
  createEtherstub,
  deleteEtherstub,
} from '../controllers/EtherstubController.js';
import { getVlans, getVlanDetails, createVlan, deleteVlan } from '../controllers/VlanController.js';
import {
  getBridges,
  getBridgeDetails,
  createBridge,
  deleteBridge,
  modifyBridgeLinks,
} from '../controllers/BridgeController/index.js';
import {
  getNatRules,
  createNatRule,
  deleteNatRule,
  getNatStatus,
  getForwardingStatus,
  configureForwarding,
} from '../controllers/NatController.js';
import {
  getDhcpConfig,
  updateDhcpConfig,
  getDhcpHosts,
  addDhcpHost,
  removeDhcpHost,
  getDhcpStatus,
  controlDhcpService,
} from '../controllers/DhcpController.js';
import { getIpSuggestions } from '../controllers/IpSuggestionsController.js';

/**
 * @fileoverview Network management routes — hostname, IP addresses, VNICs,
 * aggregates, etherstubs, VLANs, bridges, NAT/forwarding, DHCP.
 */

/**
 * Register the network management route set on the shared router.
 * @param {import('express').Router} router - Application router
 */
export const registerNetworkRoutes = router => {
  // Network Management Routes - Hostname
  router.get('/network/hostname', verifyApiKey, getHostname); // Get current hostname
  router.put('/network/hostname', verifyApiKey, setHostname); // Set hostname

  // Free-IP suggestions (converged static-IP picker feed, Go's exact wire)
  router.get('/network/ip-suggestions', verifyApiKey, getIpSuggestions);

  // Network Management Routes - IP Addresses
  router.get('/network/addresses', verifyApiKey, getManageableIPAddresses); // List IP addresses
  router.post('/network/addresses', verifyApiKey, createIPAddress); // Create IP address
  router.delete('/network/addresses/*splat', verifyApiKey, deleteIPAddress); // Delete IP address (captures full addrobj with slashes)
  router.put('/network/addresses/*splat/enable', verifyApiKey, enableIPAddress); // Enable IP address
  router.put('/network/addresses/*splat/disable', verifyApiKey, disableIPAddress); // Disable IP address

  // VNIC Management Routes
  router.get('/network/vnics', verifyApiKey, getVNICs); // List VNICs
  router.get('/network/vnics/:vnic', verifyApiKey, getVNICDetails); // Get VNIC details
  router.post('/network/vnics', verifyApiKey, createVNIC); // Create VNIC
  router.delete('/network/vnics/:vnic', verifyApiKey, deleteVNIC); // Delete VNIC
  router.get('/network/vnics/:vnic/stats', verifyApiKey, getVNICStats); // Get VNIC statistics
  router.get('/network/vnics/:vnic/properties', verifyApiKey, getVNICProperties); // Get VNIC properties
  router.put('/network/vnics/:vnic/properties', verifyApiKey, setVNICProperties); // Set VNIC properties

  // Link Aggregation Management Routes
  router.get('/network/aggregates', verifyApiKey, getAggregates); // List aggregates
  router.get('/network/aggregates/:aggregate', verifyApiKey, getAggregateDetails); // Get aggregate details
  router.post('/network/aggregates', verifyApiKey, createAggregate); // Create aggregate
  router.delete('/network/aggregates/:aggregate', verifyApiKey, deleteAggregate); // Delete aggregate
  router.put('/network/aggregates/:aggregate/links', verifyApiKey, modifyAggregateLinks); // Modify aggregate links
  router.get('/network/aggregates/:aggregate/stats', verifyApiKey, getAggregateStats); // Get aggregate statistics

  // Etherstub Management Routes
  router.get('/network/etherstubs', verifyApiKey, getEtherstubs); // List etherstubs
  router.get('/network/etherstubs/:etherstub', verifyApiKey, getEtherstubDetails); // Get etherstub details
  router.post('/network/etherstubs', verifyApiKey, createEtherstub); // Create etherstub
  router.delete('/network/etherstubs/:etherstub', verifyApiKey, deleteEtherstub); // Delete etherstub

  // VLAN Management Routes
  router.get('/network/vlans', verifyApiKey, getVlans); // List VLANs
  router.get('/network/vlans/:vlan', verifyApiKey, getVlanDetails); // Get VLAN details
  router.post('/network/vlans', verifyApiKey, createVlan); // Create VLAN
  router.delete('/network/vlans/:vlan', verifyApiKey, deleteVlan); // Delete VLAN

  // Bridge Management Routes
  router.get('/network/bridges', verifyApiKey, getBridges); // List bridges
  router.get('/network/bridges/:bridge', verifyApiKey, getBridgeDetails); // Get bridge details
  router.post('/network/bridges', verifyApiKey, createBridge); // Create bridge
  router.delete('/network/bridges/:bridge', verifyApiKey, deleteBridge); // Delete bridge
  router.put('/network/bridges/:bridge/links', verifyApiKey, modifyBridgeLinks); // Modify bridge links

  // NAT and IP Forwarding Routes
  router.get('/network/nat/rules', verifyApiKey, getNatRules); // List NAT rules
  router.post('/network/nat/rules', verifyApiKey, createNatRule); // Create NAT rule
  router.delete('/network/nat/rules/:ruleId', verifyApiKey, deleteNatRule); // Delete NAT rule
  router.get('/network/nat/status', verifyApiKey, getNatStatus); // Get ipfilter service status
  router.get('/network/forwarding', verifyApiKey, getForwardingStatus); // Get IP forwarding status
  router.put('/network/forwarding', verifyApiKey, configureForwarding); // Configure IP forwarding

  // DHCP Server Management Routes
  router.get('/network/dhcp/config', verifyApiKey, getDhcpConfig); // Get DHCP configuration
  router.put('/network/dhcp/config', verifyApiKey, updateDhcpConfig); // Update DHCP configuration
  router.get('/network/dhcp/hosts', verifyApiKey, getDhcpHosts); // List DHCP static hosts
  router.post('/network/dhcp/hosts', verifyApiKey, addDhcpHost); // Add DHCP host entry
  router.delete('/network/dhcp/hosts/:hostname', verifyApiKey, removeDhcpHost); // Remove DHCP host entry
  router.get('/network/dhcp/status', verifyApiKey, getDhcpStatus); // Get DHCP service status
  router.put('/network/dhcp/status', verifyApiKey, controlDhcpService); // Control DHCP service
};
