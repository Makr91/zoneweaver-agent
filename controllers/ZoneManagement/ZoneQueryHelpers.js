import { effectiveRemoveOnCompletion } from '../../lib/ProvisioningNetwork.js';

/**
 * The zonecfg net-resource keys that are NOT brand properties — everything
 * else on a net resource is a bhyve backend prop (promiscphys, vqsize, …).
 */
const NET_RESOURCE_KEYS = new Set([
  'physical',
  'global-nic',
  'global_nic',
  'vlan-id',
  'vlan_id',
  'mac-addr',
  'mac_addr',
  'allowed-address',
  'allowed_address',
  'address',
  'defrouter',
  'over',
]);

/**
 * Extract the brand props set on one zadm `net` resource, robust to how zadm
 * renders them (not host-verified, so handle both shapes it plausibly emits):
 *   - flat scalar keys on the net object (promiscphys: "on", vqsize: "1024"),
 *   - and/or a `property`/`properties` array of {name, value} (the raw zonecfg
 *     `add property (name=…,value=…)` shape).
 * Only SCALAR values become props — a nested object/array is never leaked as if
 * it were a property value, so an unexpected rendering yields an empty/partial
 * props map rather than garbage.
 * @param {Object} net - One net resource from the zadm view
 * @returns {Object} Brand props by name
 */
const extractNetProps = net => {
  const props = {};
  const isScalar = value =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

  for (const [key, value] of Object.entries(net)) {
    if (key === 'property' || key === 'properties') {
      const entries = Array.isArray(value) ? value : [value];
      for (const prop of entries) {
        if (prop && typeof prop === 'object' && prop.name !== undefined && isScalar(prop.value)) {
          props[prop.name] = prop.value;
        }
      }
      continue;
    }
    if (!NET_RESOURCE_KEYS.has(key) && key !== 'netif' && isScalar(value)) {
      props[key] = value;
    }
  }
  return props;
};

/**
 * Build knob_current.nics — each NIC's effective netif and its CURRENTLY SET
 * brand props (the zonecfg net-resource properties bhyve's network backend
 * consumes). An unset prop is ABSENT here; what it runs with instead is
 * knob_defaults['nics.props.*'] on GET /machines/defaults, and which props
 * apply to a given backend is nic_props_by_netif there.
 *
 * These are NOT dladm link properties — MAC/IP spoofing lives in the dladm
 * `protection` prop (GET/PUT /network/vnics/{vnic}/properties).
 * @param {Object} configuration - Live zone configuration (zadm view)
 * @returns {Array<{physical: string, netif: string|undefined, props: Object}>}
 */
export const buildNicKnobCurrent = configuration => {
  const nets = Array.isArray(configuration?.net) ? configuration.net : [];
  const docNetworks = Array.isArray(configuration?.networks) ? configuration.networks : [];
  return nets
    .map((net, index) => {
      if (!net) {
        return null;
      }
      const entry = { physical: net.physical, props: extractNetProps(net) };
      const netif = net.netif || configuration?.netif;
      if (netif) {
        entry.netif = netif;
      }
      if (docNetworks[index]?.provisional === true) {
        entry.provisional = true;
        entry.remove_on_completion = effectiveRemoveOnCompletion(docNetworks[index]);
      }
      return entry;
    })
    .filter(Boolean);
};

/**
 * Parse the zone's vcpus attr into structured CPU topology (the
 * structured-JSON ruling — the UI never regex-parses raw attr strings).
 * bhyve(7) grammar: [cpus=]numcpus[,sockets=s][,cores=c][,threads=t];
 * unspecified topology parameters run as 1. A plain count (no topology
 * tokens) answers null.
 * @param {string|number|undefined} vcpus - The zadm view's vcpus value
 * @returns {{sockets: number, cores: number, threads: number}|null}
 */
export const parseCpuTopology = vcpus => {
  if (typeof vcpus !== 'string' || !vcpus.includes('=')) {
    return null;
  }
  const read = key => {
    const match = new RegExp(`(?:^|,)${key}=(\\d+)`, 'u').exec(vcpus);
    return match ? Number(match[1]) : null;
  };
  const sockets = read('sockets');
  const cores = read('cores');
  const threads = read('threads');
  if (sockets === null && cores === null && threads === null) {
    return null;
  }
  return { sockets: sockets ?? 1, cores: cores ?? 1, threads: threads ?? 1 };
};
