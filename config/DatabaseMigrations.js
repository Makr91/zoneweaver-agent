/**
 * @fileoverview Database Migration Utilities for Zoneweaver Agent
 * @description Schema setup for the per-datatype database files, plus the
 * release migrations existing installs need (cookie-era session tables,
 * disks.removable). Fresh files get the full schema from model sync.
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import { allDatabases } from './Database.js';
import { log } from '../lib/Logger.js';
import { up as seedDefaultRecipes } from '../db/seeders/20260209-default-recipes.js';

// Import models to ensure they are registered before sync
import '../models/TemplateModel.js';
import '../models/RecipeModel.js';
import '../models/ProvisioningProfileModel.js';
import '../models/SSHSessionModel.js';
import TerminalSessions from '../models/TerminalSessionModel.js';
import LogStreamSession from '../models/LogStreamSessionModel.js';
import Disks from '../models/DiskModel.js';
import '../models/ZoneMetricsModel.js';

/**
 * Database Migration Helper Class
 * @description Provides utilities for safely migrating database schemas.
 * Helpers take the owning database instance explicitly — with per-datatype
 * files, a migration must run against the database that holds its table.
 */
class DatabaseMigrations {
  /**
   * Check if a column exists in a table
   * @param {import('sequelize').Sequelize} db - Database holding the table
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column
   * @returns {Promise<boolean>} True if column exists
   */
  async columnExists(db, tableName, columnName) {
    try {
      const [results] = await db.query(`PRAGMA table_info(${tableName})`);
      return results.some(col => col.name === columnName);
    } catch (error) {
      log.database.warn('Failed to check column existence', {
        table: tableName,
        column: columnName,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Add a column to a table if it doesn't exist
   * @param {import('sequelize').Sequelize} db - Database holding the table
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column
   * @param {string} columnDefinition - SQL column definition
   * @returns {Promise<boolean>} True if column was added or already exists
   */
  async addColumnIfNotExists(db, tableName, columnName, columnDefinition) {
    try {
      const exists = await this.columnExists(db, tableName, columnName);
      if (exists) {
        return true;
      }

      await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
      return true;
    } catch (error) {
      log.database.error('Failed to add column to table', {
        table: tableName,
        column: columnName,
        definition: columnDefinition,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Check if a table exists
   * @param {import('sequelize').Sequelize} db - Database to check
   * @param {string} tableName - Name of the table
   * @returns {Promise<boolean>} True if table exists
   */
  async tableExists(db, tableName) {
    try {
      const [results] = await db.query(`
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='${tableName}'
            `);
      return results.length > 0;
    } catch (error) {
      log.database.warn('Failed to check if table exists', {
        table: tableName,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Run all pending migrations
   * @returns {Promise<boolean>} True if all migrations successful
   */
  async runMigrations() {
    await this.migrateTerminalSessionsToTermContract();
    await this.migrateLogStreamSessionsToTicketContract();
    await this.migrateDisksInventoryColumns();
    return true;
  }

  /**
   * disks: the diskinfo -cHp inventory added removable/faulty/chassis/bay.
   * Disk rows are ephemeral (the storage interval re-scans them), so like the
   * session tables this drops the pre-inventory table and syncs the current
   * schema — no ALTER fragility, and a skip is LOUD (the silent
   * column-add failure left host-1162 answering "no such column: removable"
   * on every disks read and write).
   */
  async migrateDisksInventoryColumns() {
    const storage = allDatabases.find(({ name }) => name === 'metricsStorage' || name === 'shared');
    if (!storage) {
      log.database.error('disks inventory migration skipped — no metricsStorage database');
      return;
    }
    try {
      const queryInterface = storage.instance.getQueryInterface();
      const table = await queryInterface.describeTable('disks');
      if (!table.removable || !table.faulty || !table.chassis || !table.bay) {
        await queryInterface.dropTable('disks');
        await Disks.sync();
        log.database.info(
          'disks migrated to the diskinfo inventory schema (removable/faulty/chassis/bay)'
        );
      }
    } catch (error) {
      // Table absent on fresh installs — initializeTables creates it with the
      // current schema. Anything else must be visible.
      log.database.warn('disks inventory migration skipped', { error: error.message });
    }
  }

  /**
   * terminal_sessions: the cookie-era schema (terminal_cookie NOT NULL UNIQUE)
   * predates the /term contract, where sessions are minted by id alone.
   * Session rows are ephemeral — PTYs never survive an agent restart — so the
   * migration drops the old table and syncs the current schema in its place.
   */
  async migrateTerminalSessionsToTermContract() {
    const core = allDatabases.find(({ name }) => name === 'core' || name === 'shared');
    if (!core) {
      return;
    }
    try {
      const queryInterface = core.instance.getQueryInterface();
      const table = await queryInterface.describeTable('terminal_sessions');
      if (table.terminal_cookie) {
        await queryInterface.dropTable('terminal_sessions');
        await TerminalSessions.sync();
        log.database.info('terminal_sessions migrated to the /term schema (cookie column dropped)');
      }
    } catch {
      // Table absent — initializeTables creates it with the current schema.
    }
  }

  /**
   * log_stream_sessions: the cookie-era schema carried a cookie NOT NULL
   * column; WS auth is ticket-based now. Stream rows are ephemeral (tail
   * processes never survive a restart), so drop and resync like
   * terminal_sessions.
   */
  async migrateLogStreamSessionsToTicketContract() {
    const core = allDatabases.find(({ name }) => name === 'core' || name === 'shared');
    if (!core) {
      return;
    }
    try {
      const queryInterface = core.instance.getQueryInterface();
      const table = await queryInterface.describeTable('log_stream_sessions');
      if (table.cookie) {
        await queryInterface.dropTable('log_stream_sessions');
        await LogStreamSession.sync();
        log.database.info(
          'log_stream_sessions migrated to the ticket schema (cookie column dropped)'
        );
      }
    } catch {
      // Table absent — initializeTables creates it with the current schema.
    }
  }

  /**
   * Initialize database tables if they don't exist
   * @description Creates tables using Sequelize sync for new installations —
   * each per-datatype database syncs the models registered against it.
   * @returns {Promise<boolean>} True if initialization successful
   */
  async initializeTables() {
    try {
      // Non-SQLite dialects share one instance across all domain exports —
      // sync each underlying instance exactly once. Separate files sync
      // concurrently.
      const seen = new Set();
      const unique = allDatabases.filter(({ instance }) =>
        seen.has(instance) ? false : seen.add(instance)
      );
      await Promise.all(
        unique.map(async ({ name, instance }) => {
          await instance.sync({ alter: false }); // Don't alter existing tables, just create missing ones
          log.database.debug('Database tables synchronized', { database: name });
        })
      );

      return true;
    } catch (error) {
      log.database.error('Database table initialization failed', {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Seed default data into database
   * @description Seeds default recipes and other initial data
   * @returns {Promise<boolean>} True if seeding successful
   */
  async seedDefaultData() {
    try {
      // Seed default recipes
      await seedDefaultRecipes();

      log.database.info('Default data seeding completed');
      return true;
    } catch (error) {
      log.database.warn('Default data seeding failed (may already exist)', {
        error: error.message,
      });
      return true; // Don't fail setup if seeding fails (data may already exist)
    }
  }

  /**
   * Full database setup: initialize tables and run migrations
   * @description Complete database setup process for new and existing installations
   * @returns {Promise<boolean>} True if setup successful
   */
  async setupDatabase() {
    try {
      // First, initialize any missing tables
      await this.initializeTables();

      // Then run migrations to update existing tables
      await this.runMigrations();

      // Finally, seed default data
      await this.seedDefaultData();

      return true;
    } catch (error) {
      log.database.error('Database setup failed', {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }
}

export default new DatabaseMigrations();
