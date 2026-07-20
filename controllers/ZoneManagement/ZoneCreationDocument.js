import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { getPackageVersion } from '../../lib/ProvisionerRegistry.js';
import { validateAnswers } from '../../lib/FieldDsl.js';
import {
  renderHostsTemplate,
  parseHostsDocuments,
  splitHostsDocument,
  findLegacyMarkers,
  buildShowIfRoleFlags,
  versionConfiguration,
} from '../../lib/HostsTemplateRenderer.js';

/**
 * Stamp one rendered host entry's provisioner sections and split infra —
 * shared by the single- and multi-host paths.
 * @param {Object} host - One rendered hosts[] entry
 * @param {Object} ref - The request's provisioner reference
 * @param {Object} pkg - Registry version entry
 * @returns {{infra: Object, provisioner: Object}}
 */
const splitAndStampHost = (host, ref, pkg) => {
  const { infra, provisioner } = splitHostsDocument(host);
  if (!provisioner.provisioner_name) {
    provisioner.provisioner_name = ref.name;
  }
  if (!provisioner.provisioner_version) {
    provisioner.provisioner_version = pkg.version;
  }
  return { infra, provisioner };
};

/**
 * Build a standalone create body for one host of a MULTI-HOST render (§5
 * hosts[]): each machine gets its own document; each machine's zonecfg nic
 * half derives from its OWN rendered networks[].
 * @param {Object} host - One rendered hosts[] entry
 * @param {Object} body - The original request body
 * @param {Object} ref - Provisioner reference
 * @param {Object} pkg - Registry version entry
 * @returns {Object} Per-machine create body
 */
const buildMultiHostBody = (host, body, ref, pkg) => {
  const { infra, provisioner } = splitAndStampHost(host, ref, pkg);
  const sub = {
    settings: infra.settings || {},
    networks: infra.networks || [],
    provisioner,
    provisioner_ref: { name: ref.name, version: pkg.version },
    force: body.force,
    start_after_create: body.start_after_create,
  };
  if (infra.disks) {
    sub.disks = infra.disks;
  }
  if (infra.zones) {
    sub.zones = { ...infra.zones, ...(body.zones || {}) };
  }
  if (infra.vbox) {
    sub.vbox = infra.vbox;
  }
  if (infra.utm) {
    sub.utm = infra.utm;
  }
  if (infra.cloud_init) {
    sub.cloud_init = infra.cloud_init;
  }
  return sub;
};

/**
 * Fold ONE rendered host's infra sections back into the request body — the
 * single-host path's document-wins merge (the rendered document REPLACES the
 * request where it speaks) with ONE exception: zones merges REQUEST-wins —
 * the wizard sends only user-touched keys, and an explicit user choice
 * always overrides the template's hardcoded default.
 * @param {Object} body - Request body (mutated in place)
 * @param {Object} host - The rendered hosts[0] entry
 * @param {Object} ref - Provisioner reference
 * @param {Object} pkg - Registry version entry
 * @param {Object} settings - The render-input settings (fallback)
 */
const applySingleHostDocument = (body, host, ref, pkg, settings) => {
  const { infra, provisioner } = splitAndStampHost(host, ref, pkg);
  body.settings = infra.settings || settings;
  if (infra.networks) {
    body.networks = infra.networks;
  }
  if (infra.disks) {
    body.disks = infra.disks;
  }
  if (infra.zones) {
    body.zones = { ...infra.zones, ...(body.zones || {}) };
  }
  if (infra.vbox) {
    body.vbox = infra.vbox;
  }
  if (infra.utm) {
    body.utm = infra.utm;
  }
  if (infra.cloud_init) {
    body.cloud_init = infra.cloud_init;
  }
  body.provisioner = provisioner;
  body.provisioner_ref = { name: ref.name, version: pkg.version };
};

const renderPackageDocument = body => {
  const ref = body.provisioner;
  if (!ref) {
    return {};
  }
  if (
    !ref.name ||
    !ref.version ||
    typeof ref.name !== 'string' ||
    typeof ref.version !== 'string'
  ) {
    return {
      error: 'provisioner needs both name and version — or neither: provisioning is optional',
    };
  }
  if (body.advanced_properties !== undefined) {
    return {
      error:
        'advanced_properties is removed — the field DSL takes ONE flat answers map in properties',
    };
  }
  const pkg = getPackageVersion(ref.name, ref.version);
  if (!pkg) {
    return { error: `provisioner ${ref.name}/${ref.version} is not in the registry` };
  }

  const { errors } = validateAnswers(
    versionConfiguration(pkg.metadata),
    body.properties || {},
    buildShowIfRoleFlags(body.roles || [])
  );
  if (Object.keys(errors).length > 0) {
    return { field_errors: errors };
  }

  const settings = { ...(body.settings || {}) };
  if (!settings.sync_method) {
    settings.sync_method = 'rsync';
  }
  if (!settings.default_network_interface) {
    settings.default_network_interface = config.get('provisioning.default_network_interface') || '';
  }
  const rendered = renderHostsTemplate({
    version: pkg,
    settings,
    networks: body.networks || [],
    roles: body.roles || [],
    properties: body.properties || {},
    disks: body.disks || {},
  });
  const markers = findLegacyMarkers(rendered);
  const hosts = parseHostsDocuments(rendered);

  if (hosts.length > 1) {
    return {
      markers,
      multi_hosts: hosts.map(host => buildMultiHostBody(host, body, ref, pkg)),
    };
  }

  applySingleHostDocument(body, hosts[0], ref, pkg, settings);
  return { markers };
};

/**
 * Render the package document (when a provisioner reference rides the body).
 * @param {Object} body - Request body (mutated in place for single-host)
 * @returns {{problem?: {status: number, payload: Object}, multiHosts?: Array}}
 */
export const preparePackageDocument = body => {
  if (!body.provisioner) {
    return {};
  }
  try {
    const result = renderPackageDocument(body);
    if (result.error) {
      return { problem: { status: 400, payload: { error: result.error } } };
    }
    if (result.field_errors) {
      return { problem: { status: 422, payload: result.field_errors } };
    }
    if (result.markers?.length > 0) {
      log.api.warn('Rendered document still contains ::TOKEN:: markers', {
        markers: result.markers,
      });
    }
    return { multiHosts: result.multi_hosts || null };
  } catch (renderError) {
    return {
      problem: {
        status: 400,
        payload: { error: `Template render failed: ${renderError.message}` },
      },
    };
  }
};
