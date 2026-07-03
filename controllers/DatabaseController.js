/**
 * @fileoverview Database Management Controller
 * @description Endpoints for database maintenance operations (stats, vacuum, analyze, cleanup)
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { stat } from 'fs/promises';
import db from '../config/Database.js';
import config from '../config/ConfigLoader.js';
import CleanupService from './CleanupService.js';
import { log } from '../lib/Logger.js';
import {
  directSuccessResponse,
  errorResponse,
} from './SystemHostController/utils/ResponseHelpers.js';

/**
 * Get file size safely, returning 0 if file doesn't exist
 * @param {string} filePath - Path to file
 * @returns {Promise<number>} File size in bytes
 */
const getFileSizeOrZero = async filePath => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.size;
  } catch (error) {
    void error;
    return 0;
  }
};

/**
 * @swagger
 * /database/stats:
 *   get:
 *     summary: Get database statistics
 *     description: |
 *       Returns database file sizes (main DB, WAL, SHM), table row counts, and index statistics.
 *       Only available for SQLite databases.
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Database statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dialect:
 *                   type: string
 *                   example: "sqlite"
 *                 storage_path:
 *                   type: string
 *                 files:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: integer
 *                       description: Main database file size in bytes
 *                     wal:
 *                       type: integer
 *                       description: WAL file size in bytes
 *                     shm:
 *                       type: integer
 *                       description: SHM file size in bytes
 *                     total:
 *                       type: integer
 *                       description: Total size in bytes
 *                 tables:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       row_count:
 *                         type: integer
 *                 indexes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       table:
 *                         type: string
 *       500:
 *         description: Failed to retrieve database statistics
 */
export const getDatabaseStats = async (req, res) => {
  void req;
  try {
    const dbConfig = config.getDatabase();

    if (dbConfig.dialect !== 'sqlite') {
      return errorResponse(res, 400, 'Database stats only available for SQLite');
    }

    const storagePath = dbConfig.storage;
    const walPath = `${storagePath}-wal`;
    const shmPath = `${storagePath}-shm`;

    // Get file sizes in parallel
    const [dbSize, walSize, shmSize] = await Promise.all([
      getFileSizeOrZero(storagePath),
      getFileSizeOrZero(walPath),
      getFileSizeOrZero(shmPath),
    ]);

    // Get table list
    const [tables] = await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    // Get row counts for all tables in parallel
    const tableStats = await Promise.all(
      tables.map(async table => {
        const [[countResult]] = await db.query(`SELECT COUNT(*) as count FROM "${table.name}"`);
        return {
          name: table.name,
          row_count: countResult.count,
        };
      })
    );

    // Get indexes
    const [indexes] = await db.query(
      "SELECT name, tbl_name as 'table' FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name"
    );

    // Get page count and page size for internal stats
    const [[pageCount]] = await db.query('PRAGMA page_count');
    const [[pageSize]] = await db.query('PRAGMA page_size');
    const [[freelistCount]] = await db.query('PRAGMA freelist_count');

    return directSuccessResponse(res, 'Database statistics retrieved successfully', {
      dialect: dbConfig.dialect,
      storage_path: storagePath,
      files: {
        database: dbSize,
        wal: walSize,
        shm: shmSize,
        total: dbSize + walSize + shmSize,
      },
      internal: {
        page_size: pageSize.page_size,
        page_count: pageCount.page_count,
        freelist_count: freelistCount.freelist_count,
        freelist_bytes: freelistCount.freelist_count * pageSize.page_size,
      },
      tables: tableStats,
      total_tables: tableStats.length,
      total_rows: tableStats.reduce((sum, t) => sum + t.row_count, 0),
      indexes: indexes.map(idx => ({ name: idx.name, table: idx.table })),
      total_indexes: indexes.length,
    });
  } catch (error) {
    log.database.error('Error getting database stats', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to retrieve database statistics', error.message);
  }
};

/**
 * @swagger
 * /database/vacuum:
 *   post:
 *     summary: Run SQLite VACUUM
 *     description: |
 *       Reclaims disk space from deleted rows by rebuilding the database file.
 *       This operation may take a while for large databases and temporarily doubles disk usage.
 *       Only available for SQLite databases.
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: VACUUM completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 size_before:
 *                   type: integer
 *                 size_after:
 *                   type: integer
 *                 space_reclaimed:
 *                   type: integer
 *       500:
 *         description: Failed to run VACUUM
 */
export const vacuumDatabase = async (req, res) => {
  try {
    const dbConfig = config.getDatabase();

    if (dbConfig.dialect !== 'sqlite') {
      return errorResponse(res, 400, 'VACUUM only available for SQLite');
    }

    const storagePath = dbConfig.storage;
    const sizeBefore = await getFileSizeOrZero(storagePath);

    log.database.info('Starting database VACUUM', {
      triggered_by: req.entity.name,
      size_before: sizeBefore,
    });

    await db.query('VACUUM');

    const sizeAfter = await getFileSizeOrZero(storagePath);

    log.database.info('Database VACUUM completed', {
      triggered_by: req.entity.name,
      size_before: sizeBefore,
      size_after: sizeAfter,
      space_reclaimed: sizeBefore - sizeAfter,
    });

    return directSuccessResponse(res, 'Database VACUUM completed successfully', {
      size_before: sizeBefore,
      size_after: sizeAfter,
      space_reclaimed: sizeBefore - sizeAfter,
    });
  } catch (error) {
    log.database.error('Error running VACUUM', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to run VACUUM', error.message);
  }
};

/**
 * @swagger
 * /database/analyze:
 *   post:
 *     summary: Run SQLite ANALYZE
 *     description: |
 *       Refreshes query planner statistics for optimal query performance.
 *       This is a lightweight operation and safe to run at any time.
 *       Only available for SQLite databases.
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: ANALYZE completed successfully
 *       500:
 *         description: Failed to run ANALYZE
 */
export const analyzeDatabase = async (req, res) => {
  try {
    const dbConfig = config.getDatabase();

    if (dbConfig.dialect !== 'sqlite') {
      return errorResponse(res, 400, 'ANALYZE only available for SQLite');
    }

    log.database.info('Starting database ANALYZE', {
      triggered_by: req.entity.name,
    });

    await db.query('ANALYZE');

    log.database.info('Database ANALYZE completed', {
      triggered_by: req.entity.name,
    });

    return directSuccessResponse(res, 'Database ANALYZE completed successfully');
  } catch (error) {
    log.database.error('Error running ANALYZE', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to run ANALYZE', error.message);
  }
};

/**
 * @swagger
 * /database/cleanup:
 *   post:
 *     summary: Trigger manual database cleanup
 *     description: |
 *       Manually triggers the CleanupService which removes old completed, failed, and cancelled tasks
 *       plus expired monitoring data based on configured retention policies.
 *       This is the same cleanup that runs automatically on a timer.
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Cleanup triggered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cleanup_status:
 *                   type: object
 *                   description: CleanupService status after run
 *       500:
 *         description: Failed to trigger cleanup
 */
export const triggerCleanup = async (req, res) => {
  try {
    log.database.info('Manual cleanup triggered', {
      triggered_by: req.entity.name,
    });

    const status = await CleanupService.triggerImmediate();

    log.database.info('Manual cleanup completed', {
      triggered_by: req.entity.name,
      total_runs: status.stats.totalRuns,
      last_duration_ms: status.stats.lastRunDuration,
    });

    return directSuccessResponse(res, 'Database cleanup completed successfully', {
      cleanup_status: status,
    });
  } catch (error) {
    log.database.error('Error triggering cleanup', {
      error: error.message,
      stack: error.stack,
    });
    return errorResponse(res, 500, 'Failed to trigger cleanup', error.message);
  }
};
