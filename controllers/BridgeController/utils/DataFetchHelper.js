/**
 * @fileoverview Bridge data fetching helper
 */

import { executeCommand } from '../../../lib/CommandManager.js';
import { parseBridgeLinks, parseBridgeForwarding } from './ParsingHelpers.js';

/**
 * Fetch live bridge details from system
 * @param {string} bridge - Bridge name
 * @param {boolean|string} show_links - Show attached links
 * @param {boolean|string} show_forwarding - Show forwarding table
 * @returns {Promise<Object>} Bridge details or error object
 */
export const fetchLiveBridgeDetails = async (bridge, show_links, show_forwarding) => {
  // Get bridge details
  const bridgeResult = await executeCommand(
    `pfexec dladm show-bridge ${bridge} -p -o bridge,address,priority,bmaxage,bhellotime,bfwddelay,forceproto,tctime,tccount,tchange,desroot,rootcost,rootport`
  );

  if (!bridgeResult.success) {
    return {
      error: `Bridge ${bridge} not found`,
      details: bridgeResult.error,
    };
  }

  const [
    bridgeName,
    address,
    priority,
    bmaxage,
    bhellotime,
    bfwddelay,
    forceproto,
    tctime,
    tccount,
    tchange,
    desroot,
    rootcost,
    rootport,
  ] = bridgeResult.output.split(':');

  const bridgeDetails = {
    bridge: bridgeName,
    address,
    priority: parseInt(priority) || null,
    max_age: parseInt(bmaxage) || null,
    hello_time: parseInt(bhellotime) || null,
    forward_delay: parseInt(bfwddelay) || null,
    force_protocol: parseInt(forceproto) || null,
    tc_time: parseInt(tctime) || null,
    tc_count: parseInt(tccount) || null,
    topology_change: tchange === 'yes',
    designated_root: desroot,
    root_cost: parseInt(rootcost) || null,
    root_port: parseInt(rootport) || null,
    source: 'live',
  };

  // Get attached links if requested
  if (show_links === 'true' || show_links === true) {
    const linksResult = await executeCommand(
      `pfexec dladm show-bridge ${bridge} -l -p -o link,index,state,uptime,opercost,operp2p,operedge,desroot,descost,desbridge,desport,tcack`
    );

    if (linksResult.success && linksResult.output) {
      bridgeDetails.links = parseBridgeLinks(linksResult.output);
    }
  }

  // Get forwarding table if requested
  if (show_forwarding === 'true' || show_forwarding === true) {
    const fwdResult = await executeCommand(
      `pfexec dladm show-bridge ${bridge} -f -p -o dest,age,flags,output`
    );

    if (fwdResult.success && fwdResult.output) {
      bridgeDetails.forwarding_table = parseBridgeForwarding(fwdResult.output);
    }
  }

  return bridgeDetails;
};
