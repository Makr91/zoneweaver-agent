import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

/**
 * @fileoverview Configuration loader for Zoneweaver Agent
 * @description Loads and provides access to YAML configuration settings
 */

/**
 * Configuration loader class for managing application settings
 * @description Singleton class that loads YAML configuration and provides typed access methods
 */
class ConfigLoader {
  /**
   * Creates a new ConfigLoader instance
   * @description Automatically loads configuration on instantiation
   */
  constructor() {
    this.config = null;
    this.load();
  }

  /**
   * Loads configuration from config.yaml file
   * @description Reads and parses the YAML configuration file, checking CONFIG_PATH environment variable first
   * @throws {Error} If configuration file cannot be loaded or parsed
   */
  load() {
    try {
      // Check environment variable first (set by SMF), then fallback to local config
      const configPath =
        process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
      // eslint-disable-next-line no-console
      console.log(`Loading configuration from: ${configPath}`);
      const fileContents = fs.readFileSync(configPath, 'utf8');
      const fullConfig = yaml.load(fileContents);
      this.config = fullConfig.zoneweaver_api_backend || fullConfig;
    } catch (error) {
      const attemptedPath =
        process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
      // eslint-disable-next-line no-console
      console.error('Error loading config file:', error);
      // eslint-disable-next-line no-console
      console.error('Tried path:', attemptedPath);
      throw new Error('Failed to load configuration');
    }
  }

  /**
   * Gets a configuration value by dot-notation key
   * @description Retrieves nested configuration values using dot notation (e.g., 'api_keys.bootstrap_enabled')
   * @param {string} key - Dot-notation key path to the configuration value
   * @returns {any} The configuration value or undefined if not found
   *
   * @example
   * const bootstrapEnabled = config.get('api_keys.bootstrap_enabled');
   * const httpPort = config.get('server.http_port');
   */
  get(key) {
    const keys = key.split('.');
    let value = this.config;

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Gets all configuration settings
   * @description Returns the entire configuration object
   * @returns {Object} The full configuration object
   */
  getAll() {
    return this.config;
  }

  /**
   * Gets server configuration
   * @description Returns server-related configuration including ports
   * @returns {Object} Server configuration object
   * @returns {number} returns.http_port - HTTP server port
   * @returns {number} returns.https_port - HTTPS server port
   */
  getServer() {
    return this.config.server;
  }

  /**
   * Gets SSL configuration
   * @description Returns SSL certificate configuration
   * @returns {Object} SSL configuration object
   * @returns {boolean} returns.enabled - Whether SSL is enabled
   * @returns {boolean} returns.generate_ssl - Whether to auto-generate SSL certificates
   * @returns {string} returns.key_path - Path to SSL private key
   * @returns {string} returns.cert_path - Path to SSL certificate
   */
  getSSL() {
    return this.config.ssl;
  }

  /**
   * Gets CORS configuration
   * @description Returns Cross-Origin Resource Sharing configuration
   * @returns {Object} CORS configuration object
   * @returns {string[]} returns.whitelist - Array of allowed origins
   */
  getCORS() {
    return this.config.cors;
  }

  /**
   * Gets database configuration
   * @description Returns database connection configuration
   * @returns {Object} Database configuration object
   * @returns {string} returns.dialect - Database dialect (sqlite, postgres, mysql, mariadb)
   * @returns {string} [returns.storage] - SQLite database file path
   * @returns {string} [returns.host] - Database host (for non-SQLite)
   * @returns {number} [returns.port] - Database port (for non-SQLite)
   * @returns {string} [returns.database] - Database name (for non-SQLite)
   * @returns {string} [returns.username] - Database username (for non-SQLite)
   * @returns {string} [returns.password] - Database password (for non-SQLite)
   * @returns {boolean} returns.logging - Whether to enable SQL query logging
   */
  getDatabase() {
    return this.config.database;
  }

  /**
   * Gets API keys configuration
   * @description Returns API key authentication configuration
   * @returns {Object} API keys configuration object
   * @returns {boolean} returns.bootstrap_enabled - Whether bootstrap key generation is enabled
   * @returns {boolean} returns.bootstrap_auto_disable - Whether to disable bootstrap after first use
   * @returns {number} returns.key_length - Length of random bytes for API key generation
   * @returns {number} returns.hash_rounds - bcrypt hash rounds for API key storage
   */
  getApiKeys() {
    return this.config.api_keys;
  }

  /**
   * Gets stats endpoint configuration
   * @description Returns stats endpoint access configuration
   * @returns {Object} Stats configuration object
   * @returns {boolean} returns.public_access - Whether stats endpoint requires API key
   */
  getStats() {
    return this.config.stats;
  }

  /**
   * Gets zones configuration
   * @description Returns zone management configuration
   * @returns {Object} Zones configuration object
   * @returns {number} returns.discovery_interval - Seconds between automatic zone discovery scans
   * @returns {boolean} returns.auto_discovery - Whether to enable automatic zone discovery
   * @returns {number} returns.max_concurrent_tasks - Maximum concurrent zone operations
   * @returns {number} returns.task_timeout - Task execution timeout in seconds
   * @returns {number} returns.orphan_retention - Days to keep orphaned zones
   * @returns {number} returns.default_pagination_limit - Default number of items for paginated responses
   */
  getZones() {
    return this.config.zones;
  }

  /**
   * Gets VNC configuration
   * @description Returns VNC console configuration
   * @returns {Object} VNC configuration object
   * @returns {number} returns.web_port_range_start - Starting port for noVNC web interfaces
   * @returns {number} returns.web_port_range_end - Ending port for noVNC web interfaces
   * @returns {number} returns.session_timeout - VNC session timeout in seconds
   * @returns {number} returns.cleanup_interval - VNC session cleanup interval in seconds
   * @returns {string} returns.bind_address - Bind address for VNC servers
   * @returns {number} returns.max_concurrent_sessions - Maximum concurrent VNC sessions
   */
  getVnc() {
    return this.config.vnc;
  }

  /**
   * Gets host monitoring configuration
   * @description Returns host information collection configuration
   * @returns {Object} Host monitoring configuration object
   * @returns {boolean} returns.enabled - Whether host monitoring is enabled
   * @returns {boolean} returns.auto_enable_network_accounting - Auto-enable network accounting
   * @returns {string} returns.network_accounting_file - Network accounting log file path
   * @returns {Object} returns.intervals - Collection intervals in seconds
   * @returns {Object} returns.retention - Data retention settings in days
   * @returns {Object} returns.error_handling - Error handling configuration
   * @returns {Object} returns.performance - Performance settings
   */
  getHostMonitoring() {
    return this.config.host_monitoring;
  }

  /**
   * Gets API documentation configuration
   * @description Returns API documentation endpoint configuration
   * @returns {Object} API docs configuration object
   * @returns {boolean} returns.enabled - Whether API docs endpoint is enabled
   */
  getApiDocs() {
    return this.config.api_docs;
  }

  /**
   * Gets fault management configuration
   * @description Returns fault management configuration
   * @returns {Object} Fault management configuration object
   * @returns {boolean} returns.enabled - Whether fault management is enabled
   * @returns {number} returns.cache_interval - Cache interval in seconds
   * @returns {number} returns.timeout - Command timeout in seconds
   * @returns {number} returns.max_faults_displayed - Maximum faults to display
   */
  getFaultManagement() {
    return this.config.fault_management;
  }

  /**
   * Gets system logs configuration
   * @description Returns system log viewing configuration
   * @returns {Object} System logs configuration object
   * @returns {boolean} returns.enabled - Whether system logs are enabled
   * @returns {number} returns.max_lines - Maximum lines to read from log files
   * @returns {number} returns.default_tail_lines - Default number of lines for tail operations
   * @returns {number} returns.timeout - File read timeout in seconds
   * @returns {string[]} returns.allowed_paths - Allowed log file paths
   * @returns {Object} returns.security - Security restrictions
   */
  getSystemLogs() {
    return this.config.system_logs;
  }

  /**
   * Gets file browser configuration
   * @description Returns file browser configuration
   * @returns {Object} File browser configuration object
   * @returns {boolean} returns.enabled - Whether file browser is enabled
   * @returns {number} returns.upload_size_limit_gb - Maximum upload size in GB
   * @returns {Object} returns.security - Security restrictions and limits
   * @returns {Object} returns.archive - Archive operation settings
   */
  getFileBrowser() {
    return this.config.file_browser;
  }

  /**
   * Gets artifact storage configuration
   * @description Returns artifact storage configuration for ISOs and VM images
   * @returns {Object} Artifact storage configuration object
   * @returns {boolean} returns.enabled - Whether artifact storage is enabled
   * @returns {Object} returns.checksums - Checksum calculation settings
   * @returns {Object} returns.scanning - Filesystem scanning configuration
   * @returns {Array} returns.paths - Array of storage path configurations
   * @returns {Object} returns.security - Security restrictions and limits
   * @returns {Object} returns.cleanup - Cleanup and retention settings
   */
  getArtifactStorage() {
    return this.config.artifact_storage;
  }

  /**
   * Gets template sources configuration
   * @description Returns template source registry configuration for zone templates
   * @returns {Object} Template sources configuration object
   * @returns {boolean} returns.enabled - Whether template sources are enabled
   * @returns {string} returns.local_storage_path - Local path for extracted templates
   * @returns {Array} returns.sources - Array of registry source configurations
   * @returns {Object} returns.download - Download settings (timeout, progress, size limits)
   */
  getTemplateSources() {
    return this.config.template_sources;
  }

  /**
   * Gets zone orchestration configuration
   * @description Returns zone orchestration configuration for priority-based zone management
   * @returns {Object} Zone orchestration configuration object
   * @returns {boolean} returns.enabled - Whether zone orchestration is enabled
   * @returns {Object} returns.strategies - Default orchestration strategies
   * @returns {Object} returns.timeouts - Timeout configurations
   * @returns {Object} returns.priorities - Priority system configuration
   * @returns {Object} returns.failure_handling - Failure handling settings
   */
  getZoneOrchestration() {
    return this.config.zones?.orchestration || {};
  }

  /**
   * Gets resource validation configuration
   * @description Returns resource over-provisioning prevention settings
   * @returns {Object} Resource validation configuration object
   * @returns {boolean} returns.enabled - Whether resource validation is enabled
   * @returns {Object} returns.storage - Storage validation settings (strategy, thresholds)
   */
  getResourceValidation() {
    return this.config.zones?.resource_validation || {};
  }
}

// Export singleton instance
const config = new ConfigLoader();
export default config;
