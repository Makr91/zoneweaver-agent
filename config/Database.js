import { Sequelize } from 'sequelize';
import path from 'path';
import config from './ConfigLoader.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview Database connections for Zoneweaver Agent
 * @description Per-datatype SQLite databases (Hyperweaver architecture D14): the
 * high-churn collector domains each get their own database file so metric writes
 * never contend with the core application data (auth, tasks, zones, sessions)
 * for a file lock. Non-SQLite dialects use a single shared connection — the
 * split is a SQLite locking concern, network databases handle concurrency
 * server-side.
 */

const dbConfig = config.getDatabase();

/**
 * Per-datatype database files, created inside `database.directory`.
 * @type {Object<string, string>}
 */
const DATABASE_FILES = {
  core: 'core.sqlite',
  metricsNetwork: 'metrics-network.sqlite',
  metricsStorage: 'metrics-storage.sqlite',
  metricsSystem: 'metrics-system.sqlite',
};

/**
 * Shared query logger — logs slow queries when database logging is enabled.
 * @returns {false|Function} Sequelize logging option
 */
const buildLogging = () =>
  dbConfig.logging
    ? (sql, timing) => {
        if (timing && timing > 100) {
          log.database.warn('Slow query detected', {
            duration_ms: timing,
            query: sql.substring(0, 200),
            performance_threshold: 100,
          });
        } else if (!timing && dbConfig.logging) {
          log.database.debug('SQL query', {
            query: sql.substring(0, 200),
          });
        }
      }
    : false;

/**
 * Build the PRAGMA statements applied to every SQLite connection.
 * Sequelize's sqlite driver ignores `dialectOptions.pragma`, so these are
 * executed explicitly via an afterConnect hook — this is what actually turns
 * WAL mode and the busy timeout on.
 * @param {Object} sqliteOpts - database.sqlite_options from config
 * @returns {string} Semicolon-separated PRAGMA statements
 */
const buildPragmaSql = sqliteOpts => {
  const statements = [
    `PRAGMA journal_mode = ${sqliteOpts.journal_mode || 'WAL'}`,
    `PRAGMA synchronous = ${sqliteOpts.synchronous || 'NORMAL'}`,
    `PRAGMA cache_size = ${-(sqliteOpts.cache_size_mb || 128) * 1024}`,
    `PRAGMA temp_store = ${sqliteOpts.temp_store || 'MEMORY'}`,
    `PRAGMA mmap_size = ${(sqliteOpts.mmap_size_mb || 512) * 1024 * 1024}`,
    `PRAGMA busy_timeout = ${sqliteOpts.busy_timeout_ms || 30000}`,
    `PRAGMA wal_autocheckpoint = ${sqliteOpts.wal_autocheckpoint || 1000}`,
  ];
  if (sqliteOpts.optimize !== false) {
    statements.push('PRAGMA optimize');
  }
  return `${statements.join('; ')};`;
};

/**
 * All database handles, keyed by domain. Populated below per dialect.
 * @type {Array<{name: string, file: string|null, instance: import('sequelize').Sequelize}>}
 */
export const allDatabases = [];

let coreDb;
let metricsNetworkDb;
let metricsStorageDb;
let metricsSystemDb;

switch (dbConfig.dialect) {
  case 'sqlite': {
    const directory = dbConfig.directory || '/var/lib/zoneweaver-agent/database';
    const sqliteOpts = dbConfig.sqlite_options || {};
    const poolOpts = sqliteOpts.pool || {};
    const retryOpts = sqliteOpts.retry || {};
    const pragmaSql = buildPragmaSql(sqliteOpts);

    const createSqliteInstance = fileName => {
      const storage = path.join(directory, fileName);
      const instance = new Sequelize({
        dialect: 'sqlite',
        storage,
        logging: buildLogging(),
        benchmark: true,
        pool: {
          max: poolOpts.max || 10,
          min: poolOpts.min || 2,
          acquire: poolOpts.acquire_timeout_ms || 60000,
          idle: poolOpts.idle_timeout_ms || 30000,
          evict: poolOpts.evict_interval_ms || 5000,
        },
        retry: {
          match: [/SQLITE_BUSY/, /SQLITE_LOCKED/],
          max: retryOpts.max_retries || 5,
          backoffBase: retryOpts.backoff_base_ms || 100,
          backoffExponent: retryOpts.backoff_exponent || 1.5,
        },
      });

      // Apply the pragmas on every raw connection the pool opens.
      instance.addHook(
        'afterConnect',
        connection =>
          new Promise((resolve, reject) => {
            connection.exec(pragmaSql, error => (error ? reject(error) : resolve()));
          })
      );

      return { instance, storage };
    };

    for (const [name, fileName] of Object.entries(DATABASE_FILES)) {
      const { instance, storage } = createSqliteInstance(fileName);
      allDatabases.push({ name, file: storage, instance });
    }

    const byName = Object.fromEntries(allDatabases.map(d => [d.name, d.instance]));
    coreDb = byName.core;
    metricsNetworkDb = byName.metricsNetwork;
    metricsStorageDb = byName.metricsStorage;
    metricsSystemDb = byName.metricsSystem;

    log.database.info('SQLite configured with per-datatype database files', {
      directory,
      files: Object.values(DATABASE_FILES),
      journal_mode: sqliteOpts.journal_mode || 'WAL',
      synchronous: sqliteOpts.synchronous || 'NORMAL',
      cache_size_mb: sqliteOpts.cache_size_mb || 128,
      mmap_size_mb: sqliteOpts.mmap_size_mb || 512,
      busy_timeout_ms: sqliteOpts.busy_timeout_ms || 30000,
      wal_autocheckpoint: sqliteOpts.wal_autocheckpoint || 1000,
      optimize_enabled: sqliteOpts.optimize !== false,
    });
    break;
  }

  case 'postgres':
  case 'mysql':
  case 'mariadb': {
    /**
     * Network database: one shared connection serves every domain — the
     * per-file split exists to break SQLite's whole-file locking, which
     * server databases do not have.
     */
    const options = {
      dialect: dbConfig.dialect,
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      username: dbConfig.username,
      password: dbConfig.password,
      logging: buildLogging(),
      benchmark: true,
      pool: {
        max: 25,
        min: 5,
        acquire: 30000,
        idle: 10000,
        evict: 1000,
      },
    };

    if (dbConfig.ssl) {
      options.dialectOptions = { ssl: dbConfig.ssl };
    }

    const shared = new Sequelize(options);
    coreDb = shared;
    metricsNetworkDb = shared;
    metricsStorageDb = shared;
    metricsSystemDb = shared;
    allDatabases.push({ name: 'shared', file: null, instance: shared });
    break;
  }

  default:
    throw new Error(`Unsupported database dialect: ${dbConfig.dialect}`);
}

/**
 * Test every database connection on startup (concurrently — separate files).
 */
Promise.all(
  allDatabases.map(async ({ name, instance }) => {
    try {
      await instance.authenticate();
      log.database.info('Database connection established successfully', {
        dialect: dbConfig.dialect,
        database: name,
      });
    } catch (error) {
      log.database.error('Unable to connect to the database', {
        dialect: dbConfig.dialect,
        database: name,
        error: error.message,
        stack: error.stack,
      });
    }
  })
);

export { coreDb, metricsNetworkDb, metricsStorageDb, metricsSystemDb };
