/**
 * @fileoverview Configuration Helper Functions for Artifact Management
 * @description Utilities for managing artifact storage configuration in config.yaml
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import config from '../../../config/ConfigLoader.js';
import { log } from '../../../lib/Logger.js';

/**
 * Update config.yaml with new storage path
 * @description Updates the configuration file with a new artifact storage path
 * @param {Object} pathConfig - New path configuration
 * @param {string} pathConfig.name - Display name for the storage path
 * @param {string} pathConfig.path - Filesystem path for storage
 * @param {string} pathConfig.type - Type of artifacts (iso, image)
 * @param {boolean} pathConfig.enabled - Whether the path is enabled
 * @returns {Promise<void>}
 */
export const updateConfigWithNewPath = async pathConfig => {
  const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');

  // Read current config
  const fileContents = await fs.promises.readFile(configPath, 'utf8');
  const fullConfig = yaml.load(fileContents);
  const currentConfig = fullConfig.zoneweaver_api_backend || fullConfig;

  // Ensure artifact_storage.paths array exists
  if (!currentConfig.artifact_storage) {
    currentConfig.artifact_storage = {};
  }
  if (!currentConfig.artifact_storage.paths) {
    currentConfig.artifact_storage.paths = [];
  }

  // Add new path to config
  currentConfig.artifact_storage.paths.push({
    name: pathConfig.name,
    path: pathConfig.path,
    type: pathConfig.type,
    enabled: pathConfig.enabled,
  });

  // Write updated config to temp file first
  const tempConfigPath = `${configPath}.tmp`;
  const updatedYaml = yaml.dump(fullConfig.zoneweaver_api_backend ? fullConfig : currentConfig);
  await fs.promises.writeFile(tempConfigPath, updatedYaml, 'utf8');

  // Atomically replace the old config
  await fs.promises.rename(tempConfigPath, configPath);

  // Reload configuration
  config.load();

  log.artifact.info('Config file updated with new storage path', {
    config_path: configPath,
    path_name: pathConfig.name,
    path_location: pathConfig.path,
  });
};
