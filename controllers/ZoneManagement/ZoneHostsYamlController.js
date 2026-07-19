/**
 * @fileoverview Hosts.yml document editor endpoints (frozen cross-agent contract 2026-07-19)
 * @description The stored machine document exposed as editable YAML — the
 * emergency hatch between "create without start" and provision, and for any
 * later hand edit. GET serializes the document sections; PUT parses the YAML
 * and REPLACES them verbatim (key order preserved, comments not stored). The
 * YAML door bypasses NO gate: unparseable YAML and impossible section shapes
 * refuse 400, the converged document pre-flights (settings.consoleport,
 * settings.vcpus, the typed-disk wire) refuse with the frozen strings, and
 * everything merely semantic answers non-blocking string warnings.
 */

import yaml from 'js-yaml';
import Zones from '../../models/ZoneModel.js';
import Recipes from '../../models/RecipeModel.js';
import { log } from '../../lib/Logger.js';
import {
  validateZoneName,
  consoleportRangeError,
  vcpusCountError,
} from '../../lib/ZoneValidation.js';
import { parseConfiguration } from '../../lib/ZoneConfigUtils.js';
import { validateDisksWire } from '../../lib/DiskSpec.js';

/**
 * The user document sections — the whole YAML surface, both directions.
 * Discovery refresh preserves ONLY named document sections on the stored
 * configuration, so any other top-level key would silently vanish at the
 * next tick: unknown top-level keys refuse instead.
 */
const EDITABLE_SECTIONS = ['settings', 'zones', 'networks', 'disks', 'provisioner', 'metadata'];

/** Agent bookkeeping — never in the YAML view, always survives a PUT. */
const RESERVED_SECTIONS = [
  'provisioner_ref',
  'provisioner_state',
  'pending_changes',
  'guest_info',
  'snapshots',
];

const MAP_SECTIONS = ['settings', 'zones', 'disks', 'provisioner', 'metadata'];

const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse the submitted YAML. A parse failure answers the contract's 400 shape
 * — {error, line, column} with NUMERIC 1-based line/column when the parser
 * marks the spot (the UI editor jumps there).
 * @param {string} text - Raw YAML
 * @returns {{document?: *, refusal?: {error: string, line?: number, column?: number}}}
 */
const parseDocumentYaml = text => {
  try {
    return { document: yaml.load(text) };
  } catch (error) {
    const refusal = { error: error.reason || error.message };
    if (typeof error.mark?.line === 'number') {
      refusal.line = error.mark.line + 1;
      refusal.column = error.mark.column + 1;
    }
    return { refusal };
  }
};

/**
 * The impossible-shape refusals: root must be a map, only document sections
 * at top level (bookkeeping names refused as agent-managed), map sections
 * must be maps, networks must be a list.
 * @param {*} document - Parsed YAML value
 * @returns {string|null} Refusal string or null
 */
const documentShapeError = document => {
  if (!isMap(document)) {
    return 'document root must be a YAML map';
  }
  for (const key of Object.keys(document)) {
    if (RESERVED_SECTIONS.includes(key)) {
      return `${key} is agent-managed and cannot be edited via hosts-yml`;
    }
    if (!EDITABLE_SECTIONS.includes(key)) {
      return `top-level key ${key} is not a machine document section (allowed: ${EDITABLE_SECTIONS.join(', ')})`;
    }
  }
  for (const section of MAP_SECTIONS) {
    if (document[section] !== undefined && !isMap(document[section])) {
      return `${section} must be a map`;
    }
  }
  if (document.networks !== undefined && !Array.isArray(document.networks)) {
    return 'networks must be a list';
  }
  return null;
};

/**
 * Non-blocking semantic advisories (string array per the frozen contract):
 * what provisioning would refuse or ignore later, told NOW. The edit sticks
 * regardless — the hatch stays a hatch.
 * @param {Object} document - The stored document
 * @param {Array<{message: string}>} diskWarnings - validateDisksWire warnings
 * @returns {Promise<string[]>} Advisory strings
 */
const collectDocumentWarnings = async (document, diskWarnings) => {
  const warnings = diskWarnings.map(entry => entry.message);
  if (!document.settings) {
    warnings.push('settings section is missing — provisioning will refuse');
  }
  if (!document.provisioner) {
    warnings.push('provisioner section is missing — the provision endpoint will refuse');
  }
  const networks = Array.isArray(document.networks) ? document.networks : [];
  const hasTransport =
    networks.some(net => net?.address) ||
    networks.some(net => net?.provisional === true && net?.dhcp4 === true);
  if (!hasTransport) {
    warnings.push(
      'networks[] has no addressed entry and no provisional DHCP entry — provisioning will refuse (set is_control: true on an addressed entry, or attach the provisioning network)'
    );
  }
  const recipeId = document.provisioner?.recipe_id;
  if (recipeId) {
    const recipe = await Recipes.findByPk(recipeId);
    if (!recipe) {
      warnings.push(`provisioner.recipe_id ${recipeId} does not exist — zone setup will refuse`);
    }
  }
  return warnings;
};

/**
 * Replace the document sections on the stored configuration VERBATIM —
 * sections absent from the YAML are removed (the YAML IS the document);
 * bookkeeping and zadm-derived state survive untouched. Clone-and-mark
 * (the Sequelize JSON-column change-detection rule).
 * @param {import('../../models/ZoneModel.js').default} zone - Zone record
 * @param {Object} document - Parsed document
 * @returns {Promise<void>}
 */
const applyDocumentSections = async (zone, document) => {
  const zoneConfig = structuredClone(parseConfiguration(zone));
  for (const section of EDITABLE_SECTIONS) {
    if (document[section] === undefined) {
      delete zoneConfig[section];
    } else {
      zoneConfig[section] = document[section];
    }
  }
  zone.set('configuration', zoneConfig);
  zone.changed('configuration', true);
  await zone.save();
};

/**
 * @swagger
 * /machines/{machineName}/hosts-yml:
 *   get:
 *     summary: Get the machine document as editable YAML
 *     description: |
 *       Serializes the stored machine document (the Hosts.yml sections —
 *       settings, zones, networks, disks, provisioner, metadata) as YAML text:
 *       exactly what the provisioner receives at render time. Agent bookkeeping
 *       (provisioner_ref, provisioner_state, pending_changes, guest_info,
 *       snapshots) and zadm-derived state are not part of the YAML surface.
 *       Key order follows the stored document; the render is data-only, so
 *       comments never exist here.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     responses:
 *       200:
 *         description: The document as YAML
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 machine_name:
 *                   type: string
 *                   example: "web-server-01"
 *                 yaml:
 *                   type: string
 *                   example: "settings:\n  hostname: web-server-01\n"
 *       400:
 *         description: Invalid machine name
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to render the document
 */
export const getZoneHostsYaml = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }
    const zoneConfig = parseConfiguration(zone);
    const document = {};
    for (const section of EDITABLE_SECTIONS) {
      if (zoneConfig[section] !== undefined) {
        document[section] = zoneConfig[section];
      }
    }
    return res.json({
      machine_name: zoneName,
      yaml: yaml.dump(document, { lineWidth: -1, noRefs: true, sortKeys: false }),
    });
  } catch (error) {
    log.api.error('Failed to render machine document YAML', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to render machine document YAML' });
  }
};

/**
 * @swagger
 * /machines/{machineName}/hosts-yml:
 *   put:
 *     summary: Replace the machine document from YAML
 *     description: |
 *       Parses the submitted YAML and replaces the stored machine document
 *       VERBATIM — no normalizing, no stripping, key order preserved
 *       (comments are not stored: the document is data). A section absent
 *       from the YAML is REMOVED from the document. Refusals (nothing
 *       stored): unparseable YAML (400 with numeric line/column), a
 *       non-document top-level key or agent-managed section name, an
 *       impossible section shape, and the converged document pre-flights
 *       (settings.consoleport 1025-65535, settings.vcpus whole >= 1, the
 *       typed-disk wire's frozen strings). Everything merely semantic
 *       answers 200 with non-blocking warnings — the edit sticks.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [yaml]
 *             properties:
 *               yaml:
 *                 type: string
 *                 description: The complete document as YAML
 *                 example: "settings:\n  hostname: web-server-01\n  domain: example.com\n"
 *     responses:
 *       200:
 *         description: Document stored — warnings are non-blocking advisories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["provisioner section is missing — the provision endpoint will refuse"]
 *       400:
 *         description: Refused, nothing stored — parse errors carry numeric line/column
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "bad indentation of a mapping entry"
 *                 line:
 *                   type: integer
 *                   example: 12
 *                 column:
 *                   type: integer
 *                   example: 3
 *       404:
 *         description: Machine not found
 *       500:
 *         description: Failed to store the document
 */
export const updateZoneHostsYaml = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;
    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }
    if (typeof req.body?.yaml !== 'string' || req.body.yaml.trim() === '') {
      return res.status(400).json({ error: 'yaml must be a non-empty string' });
    }
    const { document, refusal } = parseDocumentYaml(req.body.yaml);
    if (refusal) {
      return res.status(400).json(refusal);
    }
    const shapeProblem = documentShapeError(document);
    if (shapeProblem) {
      return res.status(400).json({ error: shapeProblem });
    }
    const diskCheck = validateDisksWire(document);
    const preflightProblem =
      consoleportRangeError(document.settings?.consoleport) ||
      vcpusCountError(document.settings?.vcpus) ||
      diskCheck.errors[0];
    if (preflightProblem) {
      return res.status(400).json({ error: preflightProblem });
    }
    await applyDocumentSections(zone, document);
    const warnings = await collectDocumentWarnings(document, diskCheck.warnings);
    log.api.info('Machine document replaced via hosts-yml', {
      zone_name: zoneName,
      sections: Object.keys(document),
      user: req.entity.name,
    });
    return res.json({ warnings });
  } catch (error) {
    log.api.error('Failed to store machine document from YAML', {
      zone_name: req.params.machineName,
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to store machine document from YAML' });
  }
};
