import { Sequelize } from 'sequelize';
import config from './ConfigLoader.js';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview Database connection configuration for Zoneweaver Agent
 * @description Configures and establishes database connection using Sequelize ORM with support for multiple database types
 */

const dbConfig = config.getDatabase();

/**
 * Sequelize connection options
 * @type {Object}
 */
const sequelizeOptions = {
  dialect: dbConfig.dialect,
  logging: dbConfig.logging
    ? (sql, timing) => {
        // Log slow queries for performance monitoring
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
    : false,
  benchmark: true, // Enable query timing
  pool: {
    max: 25, // Support 5+ concurrent users without saturation
    min: 5, // Keep more connections ready
    acquire: 30000, // 30s timeout to acquire connection
    idle: 10000, // 10s timeout for idle connections
    evict: 1000, // Check for idle connections every 1s
  },
};

/**
 * Configure database connection based on dialect
 * @description Sets up connection parameters for different database types (SQLite, PostgreSQL, MySQL/MariaDB)
 */
switch (dbConfig.dialect) {
  case 'sqlite': {
    /**
     * SQLite configuration
     * @description File-based database, ideal for development and single-host deployments
     * Optimized with configurable performance parameters
     */
    sequelizeOptions.storage = dbConfig.storage;

    // Get SQLite-specific options from configuration (with defaults)
    const sqliteOpts = dbConfig.sqlite_options || {};
    const poolOpts = sqliteOpts.pool || {};
    const retryOpts = sqliteOpts.retry || {};

    // Configure connection pool for SQLite
    sequelizeOptions.pool = {
      max: poolOpts.max || 10,
      min: poolOpts.min || 2,
      acquire: poolOpts.acquire_timeout_ms || 60000,
      idle: poolOpts.idle_timeout_ms || 30000,
      evict: poolOpts.evict_interval_ms || 5000,
    };

    // Enable configurable SQLite optimizations
    sequelizeOptions.dialectOptions = {
      pragma: {
        journal_mode: sqliteOpts.journal_mode || 'WAL',
        synchronous: sqliteOpts.synchronous || 'NORMAL',
        cache_size: -(sqliteOpts.cache_size_mb || 128) * 1024, // Convert MB to negative KB
        temp_store: sqliteOpts.temp_store || 'MEMORY',
        mmap_size: (sqliteOpts.mmap_size_mb || 512) * 1024 * 1024, // Convert MB to bytes
        busy_timeout: sqliteOpts.busy_timeout_ms || 30000,
        wal_autocheckpoint: sqliteOpts.wal_autocheckpoint || 1000,
        optimize: sqliteOpts.optimize !== false, // Default to true unless explicitly false
      },
    };

    // Configurable retry configuration for busy database
    sequelizeOptions.retry = {
      match: [/SQLITE_BUSY/, /SQLITE_LOCKED/],
      max: retryOpts.max_retries || 5,
      backoffBase: retryOpts.backoff_base_ms || 100,
      backoffExponent: retryOpts.backoff_exponent || 1.5,
    };

    log.database.info('SQLite configured with performance optimizations', {
      journal_mode: sqliteOpts.journal_mode || 'WAL',
      synchronous: sqliteOpts.synchronous || 'NORMAL',
      cache_size_mb: sqliteOpts.cache_size_mb || 128,
      mmap_size_mb: sqliteOpts.mmap_size_mb || 512,
      temp_store: sqliteOpts.temp_store || 'MEMORY',
      busy_timeout_ms: sqliteOpts.busy_timeout_ms || 30000,
      wal_autocheckpoint: sqliteOpts.wal_autocheckpoint || 1000,
      optimize_enabled: sqliteOpts.optimize !== false,
      pool_config: {
        max: poolOpts.max || 10,
        min: poolOpts.min || 2,
        acquire_timeout_ms: poolOpts.acquire_timeout_ms || 60000,
        idle_timeout_ms: poolOpts.idle_timeout_ms || 30000,
        evict_interval_ms: poolOpts.evict_interval_ms || 5000,
      },
      retry_config: {
        max_retries: retryOpts.max_retries || 5,
        backoff_base_ms: retryOpts.backoff_base_ms || 100,
        backoff_exponent: retryOpts.backoff_exponent || 1.5,
      },
    });
    break;
  }

  case 'postgres':
  case 'mysql':
  case 'mariadb':
    /**
     * Network database configuration
     * @description Remote database connection for production and multi-host deployments
     */
    sequelizeOptions.host = dbConfig.host;
    sequelizeOptions.port = dbConfig.port;
    sequelizeOptions.database = dbConfig.database;
    sequelizeOptions.username = dbConfig.username;
    sequelizeOptions.password = dbConfig.password;

    // Optional SSL configuration for remote databases
    if (dbConfig.ssl) {
      sequelizeOptions.dialectOptions = {
        ssl: dbConfig.ssl,
      };
    }
    break;

  default:
    throw new Error(`Unsupported database dialect: ${dbConfig.dialect}`);
}

/**
 * Sequelize database instance
 * @description Main database connection instance used throughout the application
 * @type {import('sequelize').Sequelize}
 *
 * @example
 * // Import and use in models
 * import db from './config/Database.js';
 * const MyModel = db.define('my_model', { ... });
 */
const db = new Sequelize(sequelizeOptions);

/**
 * Test database connection on startup
 * @description Verifies database connectivity and logs connection status
 */
(async () => {
  try {
    await db.authenticate();
    log.database.info('Database connection established successfully', {
      dialect: dbConfig.dialect,
      host: dbConfig.host || 'local',
      database: dbConfig.database || dbConfig.storage,
    });
  } catch (error) {
    log.database.error('Unable to connect to the database', {
      dialect: dbConfig.dialect,
      error: error.message,
      stack: error.stack,
    });
  }
})();

export default db;
