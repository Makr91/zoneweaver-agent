import { readdir, readFile } from 'fs/promises';
import config from '../config/ConfigLoader.js';
import { isGuestAgentEnabled } from '../lib/QemuGuestAgent.js';

/**
 * @fileoverview Machine create-time defaults + guest OS type vocabulary
 * (shared wire with the Go agent's /machines/defaults + /machines/ostypes).
 * The defaults document states what a create spec that OMITS each field
 * actually gets — two classes, both listed: values this agent applies itself
 * (the create path's fallbacks) and values that fall through to the bhyve
 * brand's own defaults because no attr is written. Static by construction
 * (the vocabulary source is bhyve(7)/zoneadm(8)) — EXCEPT zones.bootrom,
 * which enumerates the host's firmware images live.
 */

/** The zadm bool vocabulary (Validator::bool) — every boolean knob takes any of these. */
const BOOL_VALUES = ['true', 'false', 'on', 'off', 'yes', 'no', '1', '0'];

/**
 * knob_values: every closed-vocabulary knob's allowed values (the UI's
 * dropdown feed), keyed like the wire. Presence MEANS dropdown; free-form and
 * numeric knobs are absent. Values pass to zonecfg/the brand unvalidated —
 * unknown values stay legal (the brand answers).
 */
const KNOB_VALUES = {
  'zones.brand': ['bhyve', 'lx', 'lipkg', 'ipkg', 'sparse', 'pkgsrc', 'kvm', 'illumos'],
  'zones.vmtype': ['template', 'development', 'production', 'firewall', 'other'],
  // hostbridge additionally accepts custom vendor=N,device=N strings
  // (zadm Validator::hostbridge) — free text stays legal past the dropdown.
  'zones.hostbridge': ['i440fx', 'q35', 'amd', 'netapp', 'none'],
  // diskif/netif statics mirror zadm's Schema/Bhyve.pm elemOf lists (upstream
  // master) — the live host-schema read below overrides them when available.
  'zones.diskif': ['virtio', 'virtio-blk', 'nvme', 'ahci', 'ahci-hd', 'ahci-cd', 'ide'],
  'zones.netif': ['virtio', 'virtio-net-viona', 'virtio-net', 'e1000'],
  'zones.vnc': ['off', 'on', 'wait'],
  'zones.vga': ['off', 'on', 'io'],
  'zones.acpi': ['on', 'off'],
  'zones.xhci': ['on', 'off'],
  'zones.cpu_configuration': ['simple', 'complex'],
  'settings.os_type': ['generic', 'windows', 'openbsd'],
  'settings.sync_method': ['rsync', 'scp'],
  'networks.type': ['internal', 'external'],
  'nics.nic_type': ['external', 'internal', 'carp', 'management', 'host'],
  'disks.boot.source.type': ['template', 'scratch'],
  'disks.boot.source.clone_strategy': ['clone', 'copy'],
  // NIC brand-props (the zonecfg net-resource properties consumed by bhyve's
  // network backends — NOT dladm link properties; MAC/IP spoofing is the dladm
  // `protection` prop, see GET /network/vnics/{vnic}/properties).
  'nics.props.promiscphys': BOOL_VALUES,
  'nics.props.promiscsap': BOOL_VALUES,
  'nics.props.promiscmulti': BOOL_VALUES,
  'nics.props.promiscrxonly': BOOL_VALUES,
  'nics.props.backend': ['dlpi'],
  'nics.props.netif': ['virtio', 'virtio-net-viona', 'virtio-net', 'e1000'],
  // Ring sizes are powers of two; bhyve(8) bounds them at [2, 32768] and zadm's
  // schema at [4, 32768] — serve the intersection zadm will accept.
  'nics.props.vqsize': [
    '4',
    '8',
    '16',
    '32',
    '64',
    '128',
    '256',
    '512',
    '1024',
    '2048',
    '4096',
    '8192',
    '16384',
    '32768',
  ],
};

/**
 * NIC brand-prop DEFAULTS — what an UNSET net property actually runs with.
 * VERBATIM from bhyve(8) "Other Network Backend Settings" and the viona
 * backend options (Mark's man-page paste is the source of truth here; do NOT
 * infer these — three of the four promisc flags default ON, which is the
 * opposite of the obvious guess).
 */
const NIC_PROP_DEFAULTS = {
  'nics.props.promiscphys': 'false',
  'nics.props.promiscsap': 'true',
  'nics.props.promiscmulti': 'true',
  'nics.props.promiscrxonly': 'true',
  // viona ring sizes: vqsize sets BOTH rings; the per-ring defaults differ
  // (TX 256, RX 1024), so there is no single honest "vqsize default" — the
  // per-ring truth is served instead.
  'nics.props.txvqsize': '256',
  'nics.props.rxvqsize': '1024',
  'nics.props.qpair': '8',
  'nics.props.speed': '1000',
};

/**
 * Which brand-props each network backend actually consumes (bhyve(8)): the
 * accelerated viona backend takes the ring/queue knobs, the legacy virtio and
 * e1000 backends take the promiscuous-mode knobs. A prop set against the wrong
 * backend is simply ignored by bhyve — the UI should only offer what applies.
 */
const NIC_PROPS_BY_NETIF = {
  'virtio-net-viona': ['feature_mask', 'vqsize', 'txvqsize', 'rxvqsize', 'qpair', 'speed'],
  virtio: ['promiscphys', 'promiscsap', 'promiscmulti', 'promiscrxonly', 'backend', 'mtu'],
  'virtio-net': ['promiscphys', 'promiscsap', 'promiscmulti', 'promiscrxonly', 'backend', 'mtu'],
  e1000: ['promiscphys', 'promiscsap', 'promiscmulti', 'promiscrxonly', 'backend'],
};

/**
 * The bootrom vocabulary — the zone attr takes a firmware image name from
 * /usr/share/bhyve/firmware (sans .fd extension) verbatim, so the dropdown
 * feed enumerates that directory LIVE; the static list is the fallback for
 * hosts where it is unreadable (non-OmniOS dev boxes).
 */
const FIRMWARE_DIR = '/usr/share/bhyve/firmware';

const STATIC_BOOTROMS = [
  'BHYVE_RELEASE_CSM',
  'BHYVE_RELEASE',
  'BHYVE',
  'BHYVE_CSM',
  'BHYVE_DEBUG',
  'BHYVE_DEBUG_CSM',
];

const enumerateBootroms = async () => {
  try {
    const entries = await readdir(FIRMWARE_DIR);
    // BHYVE_VARS.fd is the UEFI variable template, not a bootrom — zadm's
    // bootrom validator excludes it the same way.
    const names = entries
      .filter(name => name.endsWith('.fd'))
      .map(name => name.slice(0, -'.fd'.length))
      .filter(name => name !== 'BHYVE_VARS')
      .sort();
    return names.length > 0 ? names : STATIC_BOOTROMS;
  } catch {
    return STATIC_BOOTROMS;
  }
};

/**
 * The host's own zadm brand schema is the source of truth for enum-knob
 * vocabularies (Mark's ruling: read the source, never a curated copy).
 * Candidates probed in order; on a hit, each knob's elemOf(qw(...)) list is
 * extracted from the Perl source. Misses (non-OmniOS dev hosts, zadm moved)
 * fall back to the statics above.
 */
const ZADM_BHYVE_SCHEMA_CANDIDATES = [
  // The OmniOS extra-repo package's real path (confirmed on host-1162).
  '/opt/ooce/zadm/lib/Zadm/Schema/Bhyve.pm',
  '/usr/share/zadm/lib/Zadm/Schema/Bhyve.pm',
  '/usr/lib/zadm/Zadm/Schema/Bhyve.pm',
];

const ZADM_ELEMOF_PATTERNS = {
  'zones.diskif': /\bdiskif\s*=>\s*\{[^{}]*?elemOf\(qw\((?<values>[^)]+)\)\)/s,
  'zones.netif': /\bnetif\s*=>\s*\{[^{}]*?elemOf\(qw\((?<values>[^)]+)\)\)/s,
};

const readZadmSchemaVocab = async () => {
  const reads = await Promise.allSettled(
    ZADM_BHYVE_SCHEMA_CANDIDATES.map(candidate => readFile(candidate, 'utf8'))
  );
  const source = reads.find(read => read.status === 'fulfilled')?.value;
  if (!source) {
    return {};
  }
  const vocab = {};
  for (const [knob, pattern] of Object.entries(ZADM_ELEMOF_PATTERNS)) {
    const match = source.match(pattern);
    if (match) {
      vocab[knob] = match.groups.values.trim().split(/\s+/);
    }
  }
  return vocab;
};

/**
 * knob_defaults: what an UNSET attr effectively runs with (Mark's ruling: the
 * UI must always show the operating value, never "(unchanged)"). Source of
 * truth is the BRAND BOOT PROGRAM's own defaults dict — NOT zadm's schema,
 * whose defaults apply only when zadm materializes a config (they disagree on
 * bootrom/diskif/netif: schema says BHYVE/nvme/virtio, the boot program runs
 * BHYVE_RELEASE_CSM/virtio-blk/virtio-net-viona). Parsed live below; these
 * statics mirror /usr/lib/brand/bhyve/boot on host-1162 and serve as the
 * off-platform fallback. vnc/cloud_init are simply off-when-absent (the boot
 * program adds their devices only when the attr enables them). bootorder's
 * default is bhyve(7)'s documented path0,bootdisk,cdrom0
 * (https://man.omnios.org/man7/bhyve). memreserve alone has no fixed
 * default and stays absent.
 */
const KNOB_DEFAULTS = {
  'zones.acpi': 'on',
  'zones.bootorder': 'path0,bootdisk,cdrom0',
  'zones.bootrom': 'BHYVE_RELEASE_CSM',
  'zones.cloud_init': 'off',
  'zones.diskif': 'virtio-blk',
  'zones.hostbridge': 'i440fx',
  'zones.netif': 'virtio-net-viona',
  'zones.rng': 'off',
  'zones.uefivars': 'on',
  'zones.vnc': 'off',
  'zones.xhci': 'on',
  // The remove-on-completion ABSENT-flag default (Mark's per-agent ruling,
  // converged 2026-07-18): zoneweaver REMOVES the provisioning transport
  // after the whole-walk stamp (datacenter model); the Go agent keeps
  // (home/dev). The UI prefills its toggle from this key.
  'transport.remove_on_completion': true,
};

const BRAND_BOOT_PATH = '/usr/lib/brand/bhyve/boot';

/** Keys in the boot program's defaults dict, mapped to wire knob keys. */
const BRAND_DEFAULT_KEYS = {
  'zones.acpi': 'acpi',
  'zones.bootorder': 'bootorder',
  'zones.bootrom': 'bootrom',
  'zones.diskif': 'diskif',
  'zones.hostbridge': 'hostbridge',
  'zones.netif': 'netif',
  'zones.rng': 'rng',
  'zones.uefivars': 'uefivars',
  'zones.xhci': 'xhci',
};

const readBrandBootDefaults = async () => {
  let source;
  try {
    source = await readFile(BRAND_BOOT_PATH, 'utf8');
  } catch {
    return {};
  }
  const defaults = {};
  for (const [knob, bootKey] of Object.entries(BRAND_DEFAULT_KEYS)) {
    // Defaults-dict entries are quoted scalar pairs ('diskif': 'virtio-blk');
    // the same keys reappear later as alias sub-dicts ('diskif': { ... }),
    // which the quoted-value form cannot match.
    const match = source.match(new RegExp(`'${bootKey}':\\s*'(?<value>[^']*)'`));
    if (match) {
      defaults[knob] = match.groups.value;
    }
  }
  return defaults;
};

/**
 * The bhyve guest-type vocabulary (`type` attr per bhyve(7)) — the wizard's
 * settings.os_type dropdown feed. Curated by construction: bhyve's list is a
 * brand contract, not a live enumeration.
 */
const BHYVE_OS_TYPES = [
  { id: 'generic', description: 'Generic guest (default)' },
  {
    id: 'windows',
    description:
      'Microsoft Windows — pair with hostbridge=q35 when wiring the guest-agent virtio-console',
  },
  { id: 'openbsd', description: 'OpenBSD — UEFI boot; set vga=off' },
];

/**
 * @swagger
 * /machines/defaults:
 *   get:
 *     summary: Get machine create-time defaults
 *     description: |
 *       What a create spec that OMITS each field actually gets, plus
 *       knob_values — the allowed-value vocabulary for every
 *       closed-vocabulary knob (a knob present there is a dropdown; absent is
 *       free-form or numeric). The `config` section carries the LIVE
 *       agent-config values that shape creates (name/dataset prefixing, the
 *       guest-agent master gate). Same wire as the Go agent.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Defaults document
 */
export const getMachineDefaults = async (req, res) => {
  void req;
  const zonesConfig = config.getZones() || {};
  const [bootroms, zadmVocab, brandDefaults] = await Promise.all([
    enumerateBootroms(),
    readZadmSchemaVocab(),
    readBrandBootDefaults(),
  ]);
  return res.json({
    settings: {
      box_version: 'latest',
      box_arch: 'amd64',
      sync_method: 'rsync',
      boot_priority: 95,
      os_type: 'generic',
      consolehost: '0.0.0.0',
      vagrant_user: 'root',
      vagrant_ssh_insert_key: false,
    },
    zones: {
      vmtype: 'production',
      autostart: false,
      guest_agent: false,
      cpu_configuration: 'simple',
    },
    disks: {
      boot: {
        pool: 'rpool',
        dataset: 'zones',
        volume_name: 'boot',
        size: '48G',
        sparse: true,
        clone_strategy: 'clone',
      },
      sparse: true,
    },
    nics: {
      nic_type: 'external',
    },
    config: {
      prefix_zone_names: zonesConfig.prefix_zone_names !== false,
      prefix_datasets: zonesConfig.prefix_datasets !== false,
      server_id_start: zonesConfig.server_id_start || 1,
      guest_agent_enabled: isGuestAgentEnabled(),
    },
    knob_values: { ...KNOB_VALUES, ...zadmVocab, 'zones.bootrom': bootroms },
    knob_defaults: { ...KNOB_DEFAULTS, ...brandDefaults, ...NIC_PROP_DEFAULTS },
    nic_props_by_netif: NIC_PROPS_BY_NETIF,
    notes: {
      settings:
        "hostname + domain are REQUIRED (they form the FQDN). vcpus/memory omitted fall through to the bhyve brand defaults (1 vCPU, 256M) — set them explicitly for real guests. box_version/box_arch/sync_method are this agent's fallbacks. boot_priority is the orchestration default when the attr is unset (1-100, 95 = infrastructure); os_type absent writes no type attr — the brand runs generic; consolehost is the VNC web-console bind when unset; vagrant_user is the SSH credentials default when the document names none (Hosts.rb's own root default); vagrant_ssh_insert_key absent means NO post-provision key rotation. NO static default exists for: consoleport (absent = the dynamic web-console pool, config vnc.web_port_range_start/end, 8000-8100), setup_wait (absent = the HOST config's provisioning.ssh.timeout_seconds; the document's setup_wait wins when larger), and provider_type/show_console/debug_build/post_provision (driver vocabulary — nothing on this agent reads them; they ride the document verbatim).",
      zones:
        'brand is REQUIRED (no default). Attr knobs omitted at create write NO attr — the zone runs on the brand defaults listed in knob_defaults. guest_agent (boolean, default false) opts the machine into the QEMU guest-agent virtio-console channel — per-machine, under the guest_agent.enabled master gate (the Proxmox model, shared with the Go agent).',
      disks:
        'Omit disks entirely for diskless zones (PXE/netboot). Boot volume defaults: rpool/zones, name boot, 48G, sparse, thin ZFS clone from the template. Dataset paths gain the NNNN-- server_id prefix when config.prefix_datasets is on.',
      config:
        'Live agent-config values: zone names gain the NNNN-- prefix when prefix_zone_names is on (settings.server_id then required); guest_agent_enabled is the master gate for the per-machine zones.guest_agent toggle.',
      knob_values:
        "Value vocabularies for enum knobs, keyed like the wire (flat dotted keys). A knob present here is a dropdown; a knob absent is free-form or numeric. Values pass to zonecfg unvalidated — unknown values stay legal (the brand answers). LIVE-sourced: zones.bootrom enumerates /usr/share/bhyve/firmware (BHYVE_VARS excluded); zones.diskif + zones.netif parse the host's own zadm Schema/Bhyve.pm. hostbridge additionally accepts vendor=N,device=N. bootorder/bootnext take comma-separated device tokens — UEFI: shell, path[N], bootdisk, disk[N], cdrom[N], net[N][=pxe|http]; CSM: bootdisk, cdrom; plus the DEPRECATED legacy aliases cd and dc (each character one device: c=cdrom, d=disk) — per bhyve(7), https://man.omnios.org/man7/bhyve.",
      knob_defaults:
        'The value an UNSET attr effectively runs with, flat dotted keys — parsed LIVE from the brand boot program (/usr/lib/brand/bhyve/boot defaults dict; statics as off-platform fallback). NOT zadm schema defaults, which differ on bootrom/diskif/netif and apply only to zadm-materialized configs. zones.bootorder absent runs bhyve(7)’s documented default path0,bootdisk,cdrom0. memreserve alone has no fixed default and is absent. The nics.props.* entries come from bhyve(8) and are NOT guessable: promiscphys defaults FALSE, but promiscsap/promiscmulti/promiscrxonly all default TRUE.',
      nic_props_by_netif:
        "Which brand-props each network backend actually consumes (bhyve(8)). The accelerated viona backend takes the ring/queue knobs (feature_mask, vqsize, txvqsize, rxvqsize, qpair, speed); the legacy virtio and e1000 backends take the promiscuous-mode knobs. Offer only the props that apply to a NIC's effective netif — bhyve ignores the rest. NOTE: `mtu` and `backend` are legal zonecfg net properties (zadm's schema accepts them and the brand passes them through verbatim), but bhyve(8) does NOT document them as network-backend options — only the four promisc flags are listed. So no default is served for them, and they may be no-ops; label them as undocumented rather than showing an invented default. MAC/IP spoofing is NOT among these: it is the dladm `protection` LINK property (GET/PUT /network/vnics/{vnic}/properties). WARN before enabling promiscphys — it is known to break host→VM traffic on this platform (illumos-omnios#1039, open).",
    },
  });
};

/**
 * @swagger
 * /machines/ostypes:
 *   get:
 *     summary: List guest OS types
 *     description: |
 *       The bhyve guest-type vocabulary (the `type` zone attribute) — the
 *       wizard's settings.os_type dropdown feed. Same answer shape as the Go
 *       agent's live VirtualBox enumeration.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Guest OS types
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ostypes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       description:
 *                         type: string
 *                 total:
 *                   type: integer
 */
export const getMachineOSTypes = (req, res) => {
  void req;
  return res.json({ ostypes: BHYVE_OS_TYPES, total: BHYVE_OS_TYPES.length });
};
