/**
 * @fileoverview Hosts.yml template renderer (TRUE-Jinja2 contract, D-ledger dialect ruling)
 * @description Renders a provisioner package's templates/Hosts.template.yml with nunjucks —
 * the Go agent renders the same templates with gonja. Shared contract: undefined variables
 * render as EMPTY STRING; includes resolve inside the package's templates/ dir only.
 * Context assembly mirrors the Go agent's provisioner.BuildContext precedence exactly.
 */

import fs from 'fs';
import path from 'path';
import nunjucks from 'nunjucks';
import yaml from 'js-yaml';

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

const configurationFields = metadata => {
  const fields = [];
  const configuration = metadata?.configuration;
  if (!configuration || typeof configuration !== 'object') {
    return fields;
  }
  for (const group of ['basicFields', 'advancedFields']) {
    if (Array.isArray(configuration[group])) {
      for (const field of configuration[group]) {
        if (field && typeof field === 'object') {
          fields.push(field);
        }
      }
    }
  }
  return fields;
};

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

export const buildTemplateContext = ({
  version,
  settings = {},
  networks = [],
  roles = [],
  properties = {},
  advanced_properties = {},
}) => {
  const ctx = {
    settings,
    networks,
    roles: roles.map(role => ({
      name: role.name,
      enabled: Boolean(role.enabled),
      files: role.files || {},
    })),
  };

  for (const [key, value] of Object.entries(settings)) {
    ctx[sanitizeVar(key)] = value;
  }

  for (const role of roles) {
    const upper = sanitizeVar(role.name);
    ctx[upper.toLowerCase()] = Boolean(role.enabled);
    ctx[upper] = Boolean(role.enabled);
    roleFileVars(ctx, upper, role.files || {});
  }

  for (const field of configurationFields(version?.metadata)) {
    const name = typeof field.name === 'string' ? field.name : '';
    if (name && !(name in ctx)) {
      ctx[name] = field.defaultValue;
    }
  }

  for (const [key, value] of Object.entries(properties)) {
    ctx[key] = value;
  }
  for (const [key, value] of Object.entries(advanced_properties)) {
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

export const parseHostsDocument = rendered => {
  const parsed = yaml.load(rendered);
  const host = parsed?.hosts?.[0];
  if (!host || typeof host !== 'object') {
    throw new Error('rendered document carries no hosts[] entry');
  }
  return host;
};

export const findLegacyMarkers = rendered => {
  const found = String(rendered).match(LEGACY_MARKER_PATTERN);
  return found ? [...new Set(found)].slice(0, 5) : [];
};

const INFRA_KEYS = ['settings', 'networks', 'disks', 'zones', 'cloud_init'];

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
