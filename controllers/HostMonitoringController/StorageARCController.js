/**
 * @fileoverview Storage ARC Controller for Host Monitoring
 * @description ZFS ARC (Adaptive Replacement Cache) time-series endpoint
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import ARCStats from '../../models/ARCStatsModel.js';
import { buildStorageWhereClause, ARC_STATS_ATTRIBUTES } from './utils/QueryHelpers.js';
import {
  buildSamplingMetadata,
  createEmptyResponse,
  addQueryTiming,
  calculateTimeSpan,
  sampleByTime,
} from './utils/SamplingHelpers.js';

/**
 * @swagger
 * /monitoring/storage/arc:
 *   get:
 *     summary: Get ZFS ARC statistics
 *     description: Returns ZFS Adaptive Replacement Cache performance metrics
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *     responses:
 *       200:
 *         description: ARC statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 arc:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ARCStats'
 *                 latest:
 *                   $ref: '#/components/schemas/ARCStats'
 *                 totalCount:
 *                   type: integer
 *                 returnedCount:
 *                   type: integer
 *                   description: Number of records in this response
 *                 sampling:
 *                   type: object
 *                   description: Time-series sampling metadata applied to the result set
 *                   properties:
 *                     applied:
 *                       type: boolean
 *                     strategy:
 *                       type: string
 *                     samplesRequested:
 *                       type: integer
 *                     samplesReturned:
 *                       type: integer
 *                 metadata:
 *                   type: object
 *                   description: Present on the historical (since) path
 *                   properties:
 *                     timeSpan:
 *                       type: object
 *                       properties:
 *                         start:
 *                           type: string
 *                           format: date-time
 *                         end:
 *                           type: string
 *                           format: date-time
 *                         durationMinutes:
 *                           type: integer
 *                 queryTime:
 *                   type: string
 *                   description: Server-side query duration (e.g. "12ms")
 *       500:
 *         description: Failed to get ARC statistics
 */
export const getARCStats = async (req, res) => {
  const startTime = Date.now();

  try {
    const { limit = 100, since } = req.query;
    const requestedLimit = parseInt(limit);

    if (!since) {
      const latestRecord = await ARCStats.findOne({
        attributes: ARC_STATS_ATTRIBUTES,
        order: [['scan_timestamp', 'DESC']],
      });

      const results = latestRecord ? [latestRecord] : [];

      return res.json(
        addQueryTiming(
          {
            arc: results,
            totalCount: results.length,
            returnedCount: results.length,
            latest: latestRecord,
            sampling: buildSamplingMetadata({
              applied: true,
              strategy: 'latest-system-wide',
            }),
          },
          startTime
        )
      );
    }

    const whereClause = buildStorageWhereClause({ since });

    const allData = await ARCStats.findAll({
      attributes: ARC_STATS_ATTRIBUTES,
      where: whereClause,
      order: [['scan_timestamp', 'ASC']],
    });

    if (allData.length === 0) {
      return res.json(createEmptyResponse(startTime, 'javascript-time-sampling'));
    }

    const sampledResults = sampleByTime(allData, requestedLimit);
    const timeSpan = calculateTimeSpan(sampledResults);
    const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;

    return res.json(
      addQueryTiming(
        {
          arc: sampledResults,
          totalCount: sampledResults.length,
          returnedCount: sampledResults.length,
          latest,
          sampling: buildSamplingMetadata({
            applied: true,
            strategy: 'javascript-time-sampling',
            samplesRequested: requestedLimit,
            samplesReturned: sampledResults.length,
          }),
          metadata: {
            timeSpan,
          },
        },
        startTime
      )
    );
  } catch (error) {
    return res.status(500).json(
      addQueryTiming(
        {
          error: 'Failed to get ARC statistics',
          details: error.message,
        },
        startTime
      )
    );
  }
};
