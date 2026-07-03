/**
 * @fileoverview Database Migration Utilities for Zoneweaver Agent
 * @description Handles database schema migrations and updates
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import db from './Database.js';
import { log } from '../lib/Logger.js';
import { up as seedDefaultRecipes } from '../db/seeders/20260209-default-recipes.js';

// Import models to ensure they are registered before sync
import '../models/TemplateModel.js';
import '../models/RecipeModel.js';
import '../models/ProvisioningProfileModel.js';
import '../models/SSHSessionModel.js';

/**
 * Database Migration Helper Class
 * @description Provides utilities for safely migrating database schemas
 */
class DatabaseMigrations {
  /**
   * Check if a column exists in a table
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column
   * @returns {Promise<boolean>} True if column exists
   */
  async columnExists(tableName, columnName) {
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
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column
   * @param {string} columnDefinition - SQL column definition
   * @returns {Promise<boolean>} True if column was added or already exists
   */
  async addColumnIfNotExists(tableName, columnName, columnDefinition) {
    try {
      const exists = await this.columnExists(tableName, columnName);
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
   * @param {string} tableName - Name of the table
   * @returns {Promise<boolean>} True if table exists
   */
  async tableExists(tableName) {
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
   * @description Executes all necessary database migrations
   * @returns {boolean} True if all migrations successful
   */
  async runMigrations() {
    try {
      // Migration for templates table timestamps
      if (await this.tableExists('templates')) {
        await this.addColumnIfNotExists(
          'templates',
          'created_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
        await this.addColumnIfNotExists(
          'templates',
          'updated_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
      }

      // Migration for nat_rules table timestamps
      if (await this.tableExists('nat_rules')) {
        await this.addColumnIfNotExists(
          'nat_rules',
          'created_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
        await this.addColumnIfNotExists(
          'nat_rules',
          'updated_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
      }

      // Migration for dhcp_hosts table timestamps
      if (await this.tableExists('dhcp_hosts')) {
        await this.addColumnIfNotExists(
          'dhcp_hosts',
          'created_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
        await this.addColumnIfNotExists(
          'dhcp_hosts',
          'updated_at',
          'DATETIME DEFAULT CURRENT_TIMESTAMP'
        );
      }

      // Migration for tasks table parent_task_id
      if (await this.tableExists('tasks')) {
        await this.addColumnIfNotExists('tasks', 'parent_task_id', 'CHAR(36) REFERENCES tasks(id)');
        await this.addColumnIfNotExists('tasks', 'output', 'TEXT');
      }

      // Migration for vnc_sessions static port columns
      if (await this.tableExists('vnc_sessions')) {
        await this.addColumnIfNotExists('vnc_sessions', 'requested_port', 'INTEGER');
        await this.addColumnIfNotExists(
          'vnc_sessions',
          'console_host',
          "VARCHAR(255) DEFAULT '0.0.0.0'"
        );
        await this.addColumnIfNotExists(
          'vnc_sessions',
          'port_source',
          "VARCHAR(255) DEFAULT 'dynamic'"
        );
      }

      // Migration for zlogin_sessions automation columns
      if (await this.tableExists('zlogin_sessions')) {
        await this.addColumnIfNotExists('zlogin_sessions', 'session_buffer', 'TEXT');
        await this.addColumnIfNotExists(
          'zlogin_sessions',
          'automation_active',
          'BOOLEAN DEFAULT 0'
        );
        await this.addColumnIfNotExists('zlogin_sessions', 'last_activity', 'DATETIME');
      }

      // Migration for zones table server_id and vm_type (legacy - kept for old installs)
      if (await this.tableExists('zones')) {
        await this.addColumnIfNotExists('zones', 'server_id', 'VARCHAR(8)');
        // SQLite doesn't support UNIQUE in ALTER TABLE ADD COLUMN, so create index separately
        try {
          await db.query('CREATE UNIQUE INDEX IF NOT EXISTS zones_server_id ON zones(server_id)');
        } catch (indexError) {
          log.database.warn('Failed to create server_id unique index (may already exist)', {
            error: indexError.message,
          });
        }
        await this.addColumnIfNotExists('zones', 'vm_type', "VARCHAR(255) DEFAULT 'production'");
      }

      // Migration for zones table notes field
      if (await this.tableExists('zones')) {
        await this.addColumnIfNotExists('zones', 'notes', 'TEXT');
      }

      // Migration for zones table tags field
      if (await this.tableExists('zones')) {
        await this.addColumnIfNotExists('zones', 'tags', 'TEXT');
      }

      // Migration: Rename partition_id to server_id in zones table
      if (await this.tableExists('zones')) {
        const hasPartitionId = await this.columnExists('zones', 'partition_id');
        const hasServerId = await this.columnExists('zones', 'server_id');

        if (hasPartitionId && !hasServerId) {
          log.database.info('Migrating partition_id to server_id in zones table');
          try {
            // Drop old index
            await db.query('DROP INDEX IF EXISTS zones_partition_id');

            // Rename column (SQLite 3.25.0+)
            await db.query('ALTER TABLE zones RENAME COLUMN partition_id TO server_id');

            // Create new unique index
            await db.query('CREATE UNIQUE INDEX IF NOT EXISTS zones_server_id ON zones(server_id)');

            log.database.info('Successfully renamed partition_id to server_id');
          } catch (renameError) {
            log.database.error('Failed to rename partition_id to server_id', {
              error: renameError.message,
            });
            throw renameError;
          }
        } else if (hasServerId) {
          log.database.debug('zones.server_id already exists, skipping migration');
        }
      }

      log.database.info('All database migrations completed successfully');
      return true;
    } catch (error) {
      log.database.error('Database migration failed', {
        error: error.message,
        stack: error.stack,
      });
      return false;
    }
  }

  /**
   * Initialize database tables if they don't exist
   * @description Creates tables using Sequelize sync for new installations
   * @returns {Promise<boolean>} True if initialization successful
   */
  async initializeTables() {
    try {
      // Sync all models to create tables if they don't exist
      await db.sync({ alter: false }); // Don't alter existing tables, just create missing ones

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
