/**
 * @fileoverview Hosts.yml template renderer (TRUE-Jinja2 contract, D-ledger dialect ruling)
 * @description Renders a provisioner package's templates/Hosts.template.yml with nunjucks —
 * the Go agent renders the same templates with gonja. Shared contract: undefined variables
 * render as EMPTY STRING; includes resolve inside the package's templates/ dir only.
 * Context assembly mirrors the Go agent's provisioner.BuildContext precedence exactly
 * (provisioning-design §4): structured settings/networks/roles + UPPERCASE settings vars +
 * role-enable flags (both casings) + <ROLE>_INSTALLER_* file vars + manifest field defaults +
 * user answers by exact field name + SECRETS_* globals. Field visibility is the field DSL's
 * (§3.1): defaults merge BEFORE conditional evaluation; a hidden field's name is ABSENT.
 */

import fs from 'fs';
import path from 'path';
import nunjucks from 'nunjucks';
import yaml from 'js-yaml';
import { computeVisibility } from './FieldDsl.js';
import { buildSecretsTemplateVars } from './SecretsStore.js';
import { applyAnswerMigrations } from './ProvisionerRegistry.js';

const HOSTS_TEMPLATE_NAME = 'Hosts.template.yml';

const LEGACY_MARKER_PATTERN = /::[A-Za-z_][A-Za-z0-9_]*::/gu;

const PackageTemplateLoader = nunjucks.Loader.extend({
  init(root) {
    this.root = path.resolve(root);
  },
  getSource(name) {
    const resolved = path.resolve(this.root, name);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`template ${name} resolves outside the package's templates directory`);
    }
    return { src: fs.readFileSync(resolved, 'utf8'), path: resolved, noCache: true };
  },
});

const sanitizeVar = name =>
  String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '_');

/**
 * The manifest's field DSL (§3.1): metadata.configuration = {groups, fields}.
 * @param {Object} versionDoc - The version's provisioner.yml document
 * @returns {Object|undefined} The configuration block
 */
export const versionConfiguration = versionDoc => versionDoc?.metadata?.configuration;

const roleFileVars = (ctx, upper, files) => {
  const assign = (suffix, value) => {
    if (value) {
      ctx[`${upper}${suffix}`] = value;
    }
  };
  assign('_INSTALLER', files.installer);
  assign('_INSTALLER_HASH', files.installer_hash);
  assign('_INSTALLER_VERSION', files.installer_version);
  assign('_FIXPACK', files.fixpack);
  assign('_FIXPACK_HASH', files.fixpack_hash);
  assign('_FIXPACK_VERSION', files.fixpack_version);
  assign('_HOTFIX', files.hotfix);
  assign('_HOTFIX_HASH', files.hotfix_hash);
  assign('_HOTFIX_VERSION', files.hotfix_version);
};

/**
 * TEMPLATE-context role flags (both casings of the sanitized role name) —
 * the Jinja layer's existing verified behavior, UNCHANGED by the show_if
 * contract (the two layers are deliberately separate).
 * @param {Array} roles - Role selections ({name, enabled})
 * @returns {Object} Flag map
 */
export const buildRoleFlags = (roles = []) => {
  const flags = {};
  for (const role of roles) {
    if (!role || typeof role.name !== 'string') {
      continue;
    }
    const upper = sanitizeVar(role.name);
    const enabled = Boolean(role.enabled);
    flags[role.name] = enabled;
    flags[upper] = enabled;
    flags[upper.toLowerCase()] = enabled;
  }
  return flags;
};

/**
 * SHOW_IF role-flag operands — the ruled contract spelling, EXACTLY:
 * `<metadata.roles[].name>_enabled`, the manifest role name VERBATIM
 * (roles [{name: traveler}] → traveler_enabled). The create wire's roles[]
 * is seeded from metadata.roles, so the selection names ARE the manifest
 * names. No other spelling is a legal operand.
 * @param {Array} roles - Role selections ({name, enabled})
 * @returns {Object} Flag map keyed <name>_enabled
 */
export const buildShowIfRoleFlags = (roles = []) => {
  const flags = {};
  for (const role of roles) {
    if (role && typeof role.name === 'string') {
      flags[`${role.name}_enabled`] = Boolean(role.enabled);
    }
  }
  return flags;
};

export const buildTemplateContext = ({
  version,
  settings = {},
  networks = [],
  roles = [],
  properties = {},
  disks = {},
  answers_from_version = null,
}) => {
  const answers =
    answers_from_version && answers_from_version !== version?.version
      ? applyAnswerMigrations(version.root, answers_from_version, properties)
      : properties || {};
  // disks rides the context STRUCTURED-ONLY (like networks — no UPPERCASE
  // flattening): the disks half of Mark's defaults-never-locks ruling. Inert
  // until a template echoes it ({{ disks.boot.size | default("100G") }}).
  const ctx = {
    settings,
    networks,
    disks,
    roles: roles.map(role => ({
      name: role.name,
      enabled: Boolean(role.enabled),
      files: role.files || {},
    })),
  };

  for (const [key, value] of Object.entries(settings)) {
    ctx[sanitizeVar(key)] = value;
  }

  const roleFlags = buildRoleFlags(roles);
  for (const [flag, enabled] of Object.entries(roleFlags)) {
    ctx[flag] = enabled;
  }
  for (const role of roles) {
    if (role && typeof role.name === 'string') {
      roleFileVars(ctx, sanitizeVar(role.name), role.files || {});
    }
  }

  // Field DSL (§3.1): defaults merge BEFORE conditional evaluation; hidden
  // fields are ABSENT from the render context (their answers never collected).
  // show_if operands use the CONTRACT spelling <role name>_enabled — a
  // separate layer from the template flags above.
  const configuration = versionConfiguration(version?.metadata);
  const { visibleFields } = computeVisibility(configuration, answers, buildShowIfRoleFlags(roles));
  for (const field of visibleFields) {
    if (field.name in answers) {
      ctx[field.name] = answers[field.name];
    } else if (field.default !== undefined && !(field.name in ctx)) {
      ctx[field.name] = field.default;
    }
  }

  // SECRETS_* globals (§4) — the GLOBAL secrets store's template vars,
  // injected LAST (the Go agent's BuildContext order; D-C: plain by design).
  // The package's own secrets.yml/.secrets.yml stay a provision-RUNTIME
  // mechanism (extra_vars) — they never feed the render context.
  for (const [key, value] of Object.entries(buildSecretsTemplateVars())) {
    ctx[key] = value;
  }

  return ctx;
};

export const renderHostsTemplate = input => {
  const { version } = input;
  if (!version) {
    throw new Error('no provisioner version to render from');
  }
  const templatesDir = path.join(version.root, 'templates');
  if (!fs.existsSync(path.join(templatesDir, HOSTS_TEMPLATE_NAME))) {
    throw new Error(
      `package ${version.name || ''}/${version.version} has no templates/${HOSTS_TEMPLATE_NAME}`
    );
  }
  const env = new nunjucks.Environment(new PackageTemplateLoader(templatesDir), {
    autoescape: false,
    throwOnUndefined: false,
  });
  return env.render(HOSTS_TEMPLATE_NAME, buildTemplateContext(input));
};

/**
 * Parse EVERY hosts[] entry of a rendered document — multi-host `hosts[]`
 * is one document describing N coordinated machines (§5).
 * @param {string} rendered - Rendered template text
 * @returns {Array<Object>} The hosts entries (at least one)
 */
export const parseHostsDocuments = rendered => {
  const parsed = yaml.load(rendered);
  const hosts = Array.isArray(parsed?.hosts)
    ? parsed.hosts.filter(h => h && typeof h === 'object')
    : [];
  if (hosts.length === 0) {
    throw new Error('rendered document carries no hosts[] entry');
  }
  return hosts;
};

export const parseHostsDocument = rendered => parseHostsDocuments(rendered)[0];

export const findLegacyMarkers = rendered => {
  const found = String(rendered).match(LEGACY_MARKER_PATTERN);
  return found ? [...new Set(found)].slice(0, 5) : [];
};

const INFRA_KEYS = ['settings', 'networks', 'disks', 'zones', 'vbox', 'utm', 'cloud_init'];

export const splitHostsDocument = document => {
  const infra = {};
  const provisioner = {};
  for (const [key, value] of Object.entries(document)) {
    if (INFRA_KEYS.includes(key)) {
      infra[key] = value;
    } else {
      provisioner[key] = value;
    }
  }
  return { infra, provisioner };
};
