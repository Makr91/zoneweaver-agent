import { executeCommand } from '../../lib/CommandManager.js';
import { mapZvolDatasetsToZones } from '../../lib/ZoneConfigUtils.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview ZFS dataset query controllers - list and details
 */

/**
 * @swagger
 * /storage/datasets:
 *   get:
 *     summary: List ZFS datasets
 *     description: Retrieves a list of ZFS datasets
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [filesystem, volume, snapshot, bookmark]
 *         description: Filter by dataset type
 *       - in: query
 *         name: recursive
 *         schema:
 *           type: boolean
 *           default: false
 *         description: List recursively
 *     responses:
 *       200:
 *         description: List of datasets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 datasets:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       used:
 *                         type: string
 *                       avail:
 *                         type: string
 *                       refer:
 *                         type: string
 *                       mountpoint:
 *                         type: string
 *                       in_use_by:
 *                         type: string
 *                         nullable: true
 *                         description: |
 *                           Volume rows only — the machine whose live config
 *                           references this zvol (bootdisk/diskN/device match),
 *                           null when unattached. The attachability feed for
 *                           the existing-disk picker.
 *                 total:
 *                   type: integer
 *       500:
 *         description: Failed to list datasets
 */
export const listDatasets = async (req, res) => {
  const { pool, type, recursive = false } = req.query;

  try {
    let command = 'pfexec zfs list -H -p -o name,type,used,avail,refer,mountpoint';

    if (recursive === 'true' || recursive === true) {
      command += ' -r';
    }

    if (type) {
      command += ` -t ${type}`;
    }

    if (pool) {
      command += ` ${pool}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list datasets',
        details: result.error,
      });
    }

    const datasets = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, datasetType, used, avail, refer, mountpoint] = line.split('\t');
        return {
          name,
          type: datasetType,
          used,
          avail,
          refer,
          mountpoint,
        };
      });

    // Attachability feed (disk-spec H7): volume rows carry in_use_by — the
    // machine whose live config references the zvol, else null. Best-effort:
    // an unavailable zone map never breaks the listing.
    if (datasets.some(dataset => dataset.type === 'volume')) {
      try {
        const zvolZones = await mapZvolDatasetsToZones();
        for (const dataset of datasets) {
          if (dataset.type === 'volume') {
            dataset.in_use_by = zvolZones.get(dataset.name) || null;
          }
        }
      } catch (mapError) {
        log.api.warn('zvol in-use mapping unavailable — volume rows carry no in_use_by', {
          error: mapError.message,
        });
      }
    }

    return res.json({
      datasets,
      total: datasets.length,
    });
  } catch (error) {
    log.api.error('Error listing datasets', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list datasets',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/dataset:
 *   get:
 *     summary: Get dataset details
 *     description: |
 *       Retrieves detailed properties of a ZFS dataset. The dataset name rides
 *       the `name` QUERY parameter, not the path — a dataset name has slashes
 *       (pool/child/zvol) and the aggregating server proxy decodes and re-splits
 *       path segments, so a path-carried name never reaches the agent whole.
 *     tags: [ZFS Datasets]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Dataset name (e.g. Array-0/zones/web/boot)
 *     responses:
 *       200:
 *         description: Dataset details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 properties:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       value:
 *                         type: string
 *                       source:
 *                         type: string
 *       404:
 *         description: Dataset not found
 *       500:
 *         description: Failed to get dataset details
 */
export const getDatasetDetails = async (req, res) => {
  const { name } = req.query;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required (query parameter ?name=)' });
    }

    // Flags MUST precede the property operand — `zfs get all -H -p <name>`
    // parses -H as a dataset name and fails (same class as the zpool-get 404).
    const result = await executeCommand(`pfexec zfs get -H -p all ${name}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Dataset not found',
        details: result.error,
      });
    }

    const properties = {};
    result.output.split('\n').forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const [, prop, value, source] = parts;
        properties[prop] = { value, source };
      }
    });

    return res.json({
      name,
      properties,
    });
  } catch (error) {
    log.api.error('Error getting dataset details', {
      error: error.message,
      stack: error.stack,
      dataset: name,
    });
    return res.status(500).json({
      error: 'Failed to get dataset details',
      details: error.message,
    });
  }
};
