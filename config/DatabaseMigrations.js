/**
 * @fileoverview Database Migration Utilities for Zoneweaver Agent
 * @description Schema setup for the per-datatype database files, plus a
 * migration framework retained for future production releases. There are
 * currently NO pending migrations — the schema comes entirely from model
 * sync on the fresh per-datatype files.
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
   * @description No pending migrations — model sync on the per-datatype files
   * builds the current schema in full. When production migrations become
   * necessary, make this async again and gate each one on tableExists/
   * columnExists against the database instance that owns the table.
   * @returns {boolean} True if all migrations successful
   */
  runMigrations() {
    log.database.info('No pending database migrations');
    return true;
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
