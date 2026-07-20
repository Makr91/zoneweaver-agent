import {
  validateZoneName,
  consoleportRangeError,
  vcpusCountError,
} from '../../lib/ZoneValidation.js';
import {
  normalizeDisks,
  validateDisksWire,
  validateDiskImages,
  cloneStrategyError,
  getRootPool,
  templateLandingPool,
} from '../../lib/DiskSpec.js';
import { prepareNetworkSections } from './ZoneCreationHelpers.js';

/**
 * Required-params + pre-flight checks for the single-host create body —
 * runs POST-render, so template-defaulted consoleport/vcpus values refuse
 * honestly instead of poisoning the zone.
 * @param {Object} body - Request body (post-render)
 * @returns {{status: number, payload: Object}|null} Refusal or null
 */
export const validateCreateBody = body => {
  const { settings, zones } = body;
  if (!settings?.hostname || !settings?.domain || !zones?.brand) {
    return {
      status: 400,
      payload: {
        error:
          'Missing required parameters: settings.hostname, settings.domain, and zones.brand are required',
      },
    };
  }
  const preflightProblem =
    consoleportRangeError(settings.consoleport) || vcpusCountError(settings.vcpus);
  if (preflightProblem) {
    return { status: 400, payload: { error: preflightProblem } };
  }
  if (!validateZoneName(`${settings.hostname}.${settings.domain}`)) {
    return { status: 400, payload: { error: 'Invalid zone name' } };
  }
  return null;
};

/**
 * Enrich the typed boot entry with the resolved template dataset (the wire's
 * type stays the declaration, template_dataset the resolution).
 * @param {Object} body - Create body (mutated)
 * @param {Object} boxResolution - resolveBoxToTemplate result
 */
export const enrichBootTemplate = (body, boxResolution) => {
  if (boxResolution.success && boxResolution.template_dataset) {
    body.disks.boot.template_dataset = boxResolution.template_dataset;
  }
};

/**
 * The one impossible firmware pairing: settings.firmware_type BIOS with a
 * pure-UEFI boot ROM (no _CSM) cannot legacy boot — warned, never refused
 * (the explicit bootrom is honored).
 * @param {Object} body - Create body
 * @returns {{resource: string, message: string}|null} Warning entry or null
 */
export const firmwareConflictWarning = body => {
  const bootrom = body.zones?.bootrom;
  const firmware = String(body.settings?.firmware_type || '').toUpperCase();
  if (!bootrom || firmware !== 'BIOS' || bootrom.includes('CSM')) {
    return null;
  }
  return {
    resource: 'firmware',
    message: `settings.firmware_type BIOS but zones.bootrom ${bootrom} cannot legacy boot — CSM-capable ROMs carry the _CSM suffix`,
  };
};

/**
 * The boot entry's clone-strategy refusal — template pool from the resolved
 * dataset when local, the deterministic landing pool when the box still
 * downloads.
 * @param {Object} body - Create body (post box-resolution)
 * @returns {Promise<string|null>} Refusal string or null
 */
export const bootStrategyProblem = async body => {
  const boot = body.disks?.boot;
  if (boot?.type !== 'template') {
    return null;
  }
  const targetPool = boot.pool || (await getRootPool());
  const templatePool = boot.template_dataset
    ? boot.template_dataset.split('/')[0]
    : templateLandingPool();
  return cloneStrategyError(boot, templatePool, targetPool);
};

/**
 * The create wire's disk preparation, shared by the single- and multi-host
 * paths: the network sections (packaged transport + dns declare + nic
 * derivation), the typed-disk normalize, the frozen wire refusals, and the
 * host-truth image checks. First error answers; warnings ride through.
 * @param {Object} body - Create body (mutated)
 * @returns {Promise<{error?: string, warnings: Array}>}
 */
export const prepareAndValidateDisks = async body => {
  prepareNetworkSections(body);
  normalizeDisks(body);
  const diskValidation = validateDisksWire(body);
  if (diskValidation.errors.length > 0) {
    return { error: diskValidation.errors[0], warnings: [] };
  }
  const imageErrors = await validateDiskImages(body.disks);
  if (imageErrors.length > 0) {
    return { error: imageErrors[0], warnings: [] };
  }
  return { warnings: diskValidation.warnings };
};
