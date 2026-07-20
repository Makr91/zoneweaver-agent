/**
 * @fileoverview Database Management Controller
 * @description Endpoints for database maintenance operations (stats, vacuum, analyze, cleanup)
 * across the per-datatype SQLite database files.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import CleanupService from './CleanupService.js';
import { log } from '../lib/Logger.js';
import {
  directSuccessResponse,
  errorResponse,
} from './SystemHostController/utils/ResponseHelpers.js';
import {
  collectAllDatabaseStats,
  runAnalyze,
  runVacuum,
  summarizeDatabaseTotals,
} from './Database/DatabaseStatsHelpers.js';
import {
  buildOrderClause,
  buildTableSummaries,
  fetchTableColumns,
  findDatabase,
  listTableNames,
  unknownDatabaseMessage,
} from './Database/DatabaseExplorerHelpers.js';

/**
 * @swagger
 * /database/stats:
 *   get:
 *     summary: Get database statistics
 *     description: |
 *       Returns statistics for every per-datatype database file: file sizes
 *       (main DB, WAL, SHM), table row counts, index inventory, and SQLite
 *       page/freelist internals. Only available for SQLite databases.
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
 *                 databases:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                         description: Database domain (core, metricsNetwork, metricsStorage, metricsSystem)
 *                       storage_path:
 *                         type: string
 *                       files:
 *                         type: object
 *                         properties:
 *                           database:
 *                             type: integer
 *                             description: Main database file size in bytes
 *                           wal:
 *                             type: integer
 *                             description: WAL file size in bytes
 *                           shm:
 *                             type: integer
 *                             description: SHM file size in bytes
 *                           total:
 *                             type: integer
 *                             description: Total size in bytes
 *                       internal:
 *                         type: object
 *                         description: SQLite internals (PRAGMA page/freelist statistics)
 *                         properties:
 *                           page_size:
 *                             type: integer
 *                           page_count:
 *                             type: integer
 *                           freelist_count:
 *                             type: integer
 *                           freelist_bytes:
 *                             type: integer
 *                       tables:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name:
 *                               type: string
 *                             row_count:
 *                               type: integer
 *                       total_tables:
 *                         type: integer
 *                       total_rows:
 *                         type: integer
 *                       indexes:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name:
 *                               type: string
 *                             table:
 *                               type: string
 *                       total_indexes:
 *                         type: integer
 *                 total_size:
 *                   type: integer
 *                   description: Combined size of every database file in bytes
 *                 total_tables:
 *                   type: integer
 *                 total_rows:
 *                   type: integer
 *       400:
 *         description: Database stats only available for SQLite
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

    const databases = await collectAllDatabaseStats();

    return directSuccessResponse(res, 'Database statistics retrieved successfully', {
      dialect: dbConfig.dialect,
      databases,
      ...summarizeDatabaseTotals(databases),
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
 *       Reclaims disk space from deleted rows by rebuilding every per-datatype
 *       database file. This operation may take a while for large databases and
 *       temporarily doubles disk usage. Only available for SQLite databases.
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
 *                 databases:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       size_before:
 *                         type: integer
 *                       size_after:
 *                         type: integer
 *                       space_reclaimed:
 *                         type: integer
 *                 total_reclaimed:
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

    const { databases, totalReclaimed } = await runVacuum(req.entity.name);

    return directSuccessResponse(res, 'Database VACUUM completed successfully', {
      databases,
      total_reclaimed: totalReclaimed,
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
 *       Refreshes query planner statistics on every per-datatype database file.
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

    await runAnalyze(req.entity.name);

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

/**
 * @swagger
 * /database/{db}/tables:
 *   get:
 *     summary: List a database's tables
 *     description: |
 *       Read-only explorer drill-down: the named per-datatype database's tables
 *       with row counts and index names. Database names are the /database/stats
 *       `databases[].name` values (core, metricsNetwork, metricsStorage,
 *       metricsSystem). Only available for SQLite databases.
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: db
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Tables retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: string
 *                 tables:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       rows:
 *                         type: integer
 *                       indexes:
 *                         type: array
 *                         items:
 *                           type: string
 *       404:
 *         description: Unknown database
 */
export const listDatabaseTables = async (req, res) => {
  try {
    if (config.getDatabase().dialect !== 'sqlite') {
      return errorResponse(res, 400, 'Database explorer only available for SQLite');
    }
    const database = findDatabase(req.params.db);
    if (!database) {
      return errorResponse(res, 404, unknownDatabaseMessage());
    }
    const tables = await buildTableSummaries(database.instance);
    return directSuccessResponse(res, 'Database tables retrieved successfully', {
      database: database.name,
      tables,
    });
  } catch (error) {
    log.database.error('Error listing database tables', {
      error: error.message,
      database: req.params.db,
    });
    return errorResponse(res, 500, 'Failed to list database tables', error.message);
  }
};

/**
 * @swagger
 * /database/{db}/tables/{table}/rows:
 *   get:
 *     summary: Browse a table's rows (read-only, paged)
 *     description: |
 *       Read-only row browser for the explorer drill-down — no arbitrary SQL.
 *       The table must exist in the named database (validated against
 *       sqlite_master, never interpolated raw). order_by takes a column name,
 *       optionally suffixed :desc (e.g. `scan_timestamp:desc`).
 *     tags: [Database Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: db
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: table
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 500
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: order_by
 *         schema:
 *           type: string
 *         description: Column name, optionally with :desc (default order is the table's natural rowid order)
 *     responses:
 *       200:
 *         description: Rows retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: string
 *                 table:
 *                   type: string
 *                 columns:
 *                   type: array
 *                   items:
 *                     type: string
 *                 rows:
 *                   type: array
 *                   items:
 *                     type: array
 *                 total:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *       400:
 *         description: Invalid order_by column
 *       404:
 *         description: Unknown database or table
 */
export const browseDatabaseTable = async (req, res) => {
  try {
    if (config.getDatabase().dialect !== 'sqlite') {
      return errorResponse(res, 400, 'Database explorer only available for SQLite');
    }
    const database = findDatabase(req.params.db);
    if (!database) {
      return errorResponse(res, 404, unknownDatabaseMessage());
    }
    const names = await listTableNames(database.instance);
    const table = names.find(name => name === req.params.table);
    if (!table) {
      return errorResponse(res, 404, `Unknown table in ${database.name}`);
    }

    const columns = await fetchTableColumns(database.instance, table);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const orderClause = buildOrderClause(req.query.order_by, columns);
    if (orderClause === null) {
      return errorResponse(res, 400, `order_by must name a column of ${table}`);
    }

    const [[countResult]] = await database.instance.query(
      `SELECT COUNT(*) as count FROM "${table}"`
    );
    const [rowObjects] = await database.instance.query(
      `SELECT * FROM "${table}"${orderClause} LIMIT ${limit} OFFSET ${offset}`
    );

    return directSuccessResponse(res, 'Table rows retrieved successfully', {
      database: database.name,
      table,
      columns,
      rows: rowObjects.map(row => columns.map(column => row[column])),
      total: countResult.count,
      pagination: { limit, offset, hasMore: offset + rowObjects.length < countResult.count },
    });
  } catch (error) {
    log.database.error('Error browsing database table', {
      error: error.message,
      database: req.params.db,
      table: req.params.table,
    });
    return errorResponse(res, 500, 'Failed to browse database table', error.message);
  }
};
