/**
 * @fileoverview Artifact Storage Service for Zoneweaver Agent
 * @description Manages artifact storage locations and synchronization between config.yaml and database
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import config from '../config/ConfigLoader.js';
import ArtifactStorageLocation from '../models/ArtifactStorageLocationModel.js';
import Artifact from '../models/ArtifactModel.js';
import { executeArtifactScanAllTask } from './TaskManager/ArtifactManager/index.js';
import CleanupService from './CleanupService.js';
import { log, createTimer } from '../lib/Logger.js';
import { validatePath, executeCommand } from '../lib/FileSystemManager.js';
import { Op } from 'sequelize';
import yj from 'yieldable-json';

/**
 * Artifact Storage Service Class
 * @description Main service that manages artifact storage locations and file synchronization
 */
class ArtifactStorageService {
  constructor() {
    this.config = config.getArtifactStorage?.() || { enabled: false };
    this.intervals = {
      periodicScan: null,
    };
    this.isRunning = false;
    this.isInitialized = false;
    this.isScanning = false;

    // Performance tracking
    this.stats = {
      scanRuns: 0,
      lastScanSuccess: null,
      totalScanErrors: 0,
      locationsManaged: 0,
      artifactsTracked: 0,
    };
  }

  /**
   * Calculate configuration hash for change detection
   * @param {Object} pathConfig - Single path configuration from config.yaml
   * @returns {string} Hash of the configuration
   */
  calculateConfigHash(pathConfig) {
    const hashContent = JSON.stringify({
      name: pathConfig.name,
      path: pathConfig.path,
      type: pathConfig.type,
      enabled: pathConfig.enabled !== false,
    });
    return crypto.createHash('md5').update(hashContent).digest('hex');
  }

  /**
   * Synchronize config.yaml paths with database
   * @description Updates database to match current config.yaml artifact_storage.paths
   */
  async syncConfigWithDatabase() {
    const timer = createTimer('config_sync');
    try {
      if (!this.config.enabled || !this.config.paths) {
        log.artifact.info('Artifact storage disabled or no paths configured');
        return;
      }

      log.artifact.debug('Synchronizing config with database', {
        configured_paths: this.config.paths.length,
      });

      // Process each path in config (parallelized for performance)
      await Promise.all(
        this.config.paths.map(async pathConfig => {
          const configHash = this.calculateConfigHash(pathConfig);

          // Validate path exists and is accessible
          const validation = validatePath(pathConfig.path);
          if (!validation.valid) {
            log.artifact.warn('Invalid storage path in configuration', {
              name: pathConfig.name,
              path: pathConfig.path,
              error: validation.error,
            });
            return;
          }

          // Ensure directory exists or try to create it
          let directoryEnabled = pathConfig.enabled !== false;
          try {
            await fs.access(validation.normalizedPath);
            log.artifact.debug('Storage path exists', {
              name: pathConfig.name,
              path: validation.normalizedPath,
            });
          } catch (error) {
            // Directory doesn't exist, try to create it safely
            try {
              log.artifact.info('Creating storage directory', {
                name: pathConfig.name,
                path: validation.normalizedPath,
              });

              const mkdirResult = await executeCommand(
                `pfexec mkdir -p "${validation.normalizedPath}"`
              );

              if (!mkdirResult.success) {
                throw new Error(`mkdir failed: ${mkdirResult.error}`);
              }

              log.artifact.info('Storage directory created successfully', {
                name: pathConfig.name,
                path: validation.normalizedPath,
              });
            } catch (createError) {
              log.artifact.warn('Failed to create storage directory - marking as disabled', {
                name: pathConfig.name,
                path: pathConfig.path,
                original_error: error?.message || 'Unknown error',
                create_error: createError?.message || 'Unknown create error',
                create_error_type: typeof createError,
              });

              // Mark as disabled since we couldn't create the directory
              directoryEnabled = false;
            }
          }

          // Upsert storage location (always create DB entry, but may be disabled)
          await ArtifactStorageLocation.upsert({
            name: pathConfig.name,
            path: validation.normalizedPath,
            type: pathConfig.type,
            enabled: directoryEnabled,
            config_hash: configHash,
          });

          log.artifact.debug('Synchronized storage location', {
            name: pathConfig.name,
            path: validation.normalizedPath,
            type: pathConfig.type,
            enabled: pathConfig.enabled !== false,
          });
        })
      );

      // Remove storage locations that are no longer in config
      const configPaths = this.config.paths
        .map(p => {
          const validation = validatePath(p.path);
          return validation.valid ? validation.normalizedPath : null;
        })
        .filter(p => p !== null);

      const removedCount = await ArtifactStorageLocation.destroy({
        where: {
          path: { [Op.notIn]: configPaths },
        },
      });

      if (removedCount > 0) {
        log.artifact.info('Removed storage locations no longer in config', {
          removed_count: removedCount,
        });
      }

      this.stats.locationsManaged = configPaths.length;
      const duration = timer.end();

      log.artifact.info('Configuration synchronization completed', {
        managed_locations: this.stats.locationsManaged,
        removed_locations: removedCount,
        duration_ms: duration,
      });
    } catch (error) {
      timer.end();
      log.artifact.error('Failed to synchronize configuration', {
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace available',
        error_type: typeof error,
        raw_error: error,
      });
      throw error;
    }
  }

  /**
   * Run a scan of all storage locations directly — periodic and startup scans
   * no longer mint task-queue rows (user-triggered scans via the API still do).
   * In-flight guarded so a slow scan can never stack behind itself.
   * @param {string} source - Scan origin for logging (initial_scan | periodic_scan)
   */
  async runScanAll(source) {
    if (this.isScanning) {
      log.artifact.debug('Skipping artifact scan - previous scan still in progress', { source });
      return;
    }
    this.isScanning = true;

    try {
      const metadataJson = await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            verify_checksums: false,
            remove_orphaned: true, // Clean orphaned records during automatic scans
            source,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      });

      const result = await executeArtifactScanAllTask(metadataJson);
      if (result.success) {
        this.stats.scanRuns++;
        this.stats.lastScanSuccess = Date.now();
        log.artifact.debug('Artifact scan completed', {
          source,
          run_count: this.stats.scanRuns,
        });
      } else {
        this.stats.totalScanErrors++;
        log.artifact.error('Artifact scan failed', {
          source,
          error: result.error,
          total_errors: this.stats.totalScanErrors,
        });
      }
    } catch (error) {
      this.stats.totalScanErrors++;
      log.artifact.error('Artifact scan failed', {
        source,
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace available',
        total_errors: this.stats.totalScanErrors,
      });
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Perform initial filesystem scan of all enabled locations
   * @description Kicks off the startup scan without blocking initialization —
   * the scan walks every enabled storage location on disk.
   */
  performInitialScan() {
    if (!this.config.enabled) {
      return;
    }

    void this.runScanAll('initial_scan');
  }

  /**
   * Register cleanup tasks with CleanupService
   * @description Registers artifact-related cleanup functions
   */
  registerCleanupTasks() {
    try {
      // Register orphaned artifact cleanup
      CleanupService.registerTask({
        name: 'artifact_cleanup',
        description: 'Clean up orphaned artifact records and old files',
        handler: async () => {
          await this.cleanupOrphanedRecords();
        },
      });

      log.artifact.info('Cleanup tasks registered', {
        tasks_registered: 1,
      });
    } catch (error) {
      log.artifact.error('Failed to register cleanup tasks', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Clean up orphaned artifact records
   * @description Removes database records for files that no longer exist on disk
   */
  async cleanupOrphanedRecords() {
    const timer = createTimer('artifact_cleanup');
    try {
      if (!this.config.cleanup?.enabled) {
        return;
      }

      const retentionDays = this.config.cleanup.orphaned_files_retention_days || 30;
      const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

      // Find artifacts that haven't been verified recently
      const staleArtifacts = await Artifact.findAll({
        where: {
          [Op.or]: [{ last_verified: null }, { last_verified: { [Op.lt]: cutoffDate } }],
        },
        limit: 100, // Process in batches
      });

      // Process artifacts in parallel for better performance
      const results = await Promise.allSettled(
        staleArtifacts.map(async artifact => {
          try {
            await fs.access(artifact.path);
            // File exists, update last_verified
            await artifact.update({ last_verified: new Date() });
            return { removed: false };
          } catch {
            // File doesn't exist, remove record
            await artifact.destroy();
            log.artifact.debug('Removed orphaned artifact record', {
              filename: artifact.filename,
              path: artifact.path,
            });
            return { removed: true };
          }
        })
      );

      const removedCount = results.filter(r => r.status === 'fulfilled' && r.value.removed).length;

      const duration = timer.end();

      if (removedCount > 0 || staleArtifacts.length > 0) {
        log.artifact.info('Artifact cleanup completed', {
          checked_count: staleArtifacts.length,
          removed_count: removedCount,
          duration_ms: duration,
        });
      }
    } catch (error) {
      timer.end();
      log.artifact.error('Artifact cleanup failed', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Initialize the artifact storage service
   * @description Sets up database synchronization and performs initial scan
   */
  async initialize() {
    if (this.isInitialized) {
      return true;
    }

    if (!this.config.enabled) {
      log.artifact.info('Artifact storage service is disabled');
      return false;
    }

    try {
      log.artifact.info('Initializing artifact storage service');

      // Sync config with database
      await this.syncConfigWithDatabase();

      // Kick off the initial scan (runs in the background)
      this.performInitialScan();

      // Register cleanup tasks
      this.registerCleanupTasks();

      this.isInitialized = true;
      log.artifact.info('Artifact storage service initialized successfully');
      return true;
    } catch (error) {
      log.artifact.error('Failed to initialize artifact storage service', {
        error: error?.message || 'Unknown error',
        stack: error?.stack || 'No stack trace available',
        error_type: typeof error,
        raw_error: error,
      });
      return false;
    }
  }

  /**
   * Start the artifact storage service
   * @description Begins periodic scanning based on configured intervals
   */
  async start() {
    if (!this.isInitialized) {
      const initialized = await this.initialize();
      if (!initialized) {
        log.artifact.error('Cannot start artifact storage service - initialization failed');
        return false;
      }
    }

    if (this.isRunning || !this.config.enabled) {
      return true;
    }

    try {
      const scanInterval = this.config.scanning?.periodic_scan_interval || 300;

      // Start periodic scanning (direct, no task rows)
      this.intervals.periodicScan = setInterval(() => {
        void this.runScanAll('periodic_scan');
      }, scanInterval * 1000);

      this.isRunning = true;
      log.artifact.info('Artifact storage service started', {
        scan_interval_seconds: scanInterval,
        managed_locations: this.stats.locationsManaged,
      });

      return true;
    } catch (error) {
      log.artifact.error('Failed to start artifact storage service', {
        error: error.message,
        stack: error.stack,
      });
      this.stop();
      return false;
    }
  }

  /**
   * Stop the artifact storage service
   * @description Stops all periodic scanning
   */
  stop() {
    Object.values(this.intervals).forEach(intervalId => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    });

    // Reset interval IDs
    Object.keys(this.intervals).forEach(key => {
      this.intervals[key] = null;
    });

    this.isRunning = false;
    log.artifact.info('Artifact storage service stopped');
  }

  /**
   * Get current service status
   * @returns {Object} Service status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isInitialized: this.isInitialized,
      config: {
        enabled: this.config.enabled,
        scanning_interval: this.config.scanning?.periodic_scan_interval || 300,
        paths_configured: this.config.paths?.length || 0,
      },
      stats: {
        ...this.stats,
        uptime_seconds: this.isRunning
          ? Math.floor((Date.now() - (this.stats.lastScanSuccess || Date.now())) / 1000)
          : 0,
      },
      activeIntervals: {
        periodicScan: !!this.intervals.periodicScan,
      },
    };
  }

  /**
   * Get artifact statistics
   * @returns {Object} Artifact statistics
   */
  async getArtifactStats() {
    try {
      const locations = await ArtifactStorageLocation.findAll({
        include: [
          {
            model: Artifact,
            as: 'artifacts',
            attributes: [],
          },
        ],
        attributes: [
          'id',
          'name',
          'path',
          'type',
          'enabled',
          'file_count',
          'total_size',
          'last_scan_at',
        ],
      });

      const stats = {
        by_type: {},
        storage_locations: [],
        totals: {
          locations: locations.length,
          enabled_locations: 0,
          total_artifacts: 0,
          total_size: 0,
        },
      };

      for (const location of locations) {
        if (location.enabled) {
          stats.totals.enabled_locations++;
        }

        stats.totals.total_artifacts += location.file_count || 0;
        stats.totals.total_size += parseInt(location.total_size) || 0;

        // Group by type
        if (!stats.by_type[location.type]) {
          stats.by_type[location.type] = {
            count: 0,
            total_size: 0,
            locations: 0,
          };
        }

        stats.by_type[location.type].count += location.file_count || 0;
        stats.by_type[location.type].total_size += parseInt(location.total_size) || 0;
        stats.by_type[location.type].locations++;

        stats.storage_locations.push({
          id: location.id,
          name: location.name,
          path: location.path,
          type: location.type,
          enabled: location.enabled,
          file_count: location.file_count || 0,
          total_size: parseInt(location.total_size) || 0,
          last_scan: location.last_scan_at,
        });
      }

      return stats;
    } catch (error) {
      log.artifact.error('Failed to get artifact statistics', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

// Create singleton instance
const artifactStorageService = new ArtifactStorageService();

/**
 * Initialize artifact storage service
 * @description Exported function to initialize the service
 */
export const initializeArtifactStorage = () => artifactStorageService.initialize();

/**
 * Start artifact storage service
 * @description Exported function to start the service
 */
export const startArtifactStorage = () => artifactStorageService.start();

/**
 * Stop artifact storage service
 * @description Exported function to stop the service
 */
export const stopArtifactStorage = () => {
  artifactStorageService.stop();
};

/**
 * Get service instance
 * @description Exported function to get the service instance
 */
export const getArtifactStorageService = () => artifactStorageService;

export default artifactStorageService;
