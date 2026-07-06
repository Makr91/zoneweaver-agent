/**
 * @fileoverview Settings backup management endpoints
 */

import config from '../../config/ConfigLoader.js';
import { promises as fs } from 'fs';
import path from 'path';
import { log } from '../../lib/Logger.js';
import { createBackup, configPath, backupDir } from './utils/BackupHelper.js';

/**
 * @swagger
 * /settings/backups:
 *   get:
 *     summary: List available configuration backups
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of configuration backups
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   filename:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *       500:
 *         description: Failed to list backups
 */
export const listBackups = async (req, res) => {
  void req;
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const files = await fs.readdir(backupDir);
    const backups = files
      .filter(file => file.endsWith('.yaml'))
      .map(file => {
        // Extract timestamp from filename (config-1749723866123.yaml -> 1749723866123)
        const timestampStr = file.replace('config-', '').replace('.yaml', '');
        const timestamp = parseInt(timestampStr, 10);

        // Only include valid timestamps
        if (isNaN(timestamp)) {
          return null;
        }

        return {
          filename: file,
          createdAt: new Date(timestamp).toISOString(),
        };
      })
      .filter(backup => backup !== null)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json(backups);
  } catch (error) {
    log.api.error('Error listing backups', {
      error: error.message,
      stack: error.stack,
      backup_dir: backupDir,
    });
    return res.status(500).json({ error: 'Failed to list backups', details: error.message });
  }
};

/**
 * @swagger
 * /settings/backup:
 *   post:
 *     summary: Create a backup of the current configuration
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backup created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 backup:
 *                   type: object
 *                   properties:
 *                     filename:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Failed to create backup
 */
export const createConfigBackup = async (req, res) => {
  void req;
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const timestamp = Date.now();
    const filename = `config-${timestamp}.yaml`;
    const backupPath = path.join(backupDir, filename);

    await fs.copyFile(configPath, backupPath);
    log.app.info('Created config backup', {
      backup_path: backupPath,
      filename,
      timestamp,
    });

    return res.json({
      success: true,
      message: 'Backup created successfully',
      backup: {
        filename,
        createdAt: new Date(timestamp).toISOString(),
      },
    });
  } catch (error) {
    log.api.error('Error creating backup', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to create backup', details: error.message });
  }
};

/**
 * @swagger
 * /settings/backups/{filename}:
 *   delete:
 *     summary: Delete a specific configuration backup
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: The filename of the backup to delete
 *     responses:
 *       200:
 *         description: Backup deleted successfully
 *       400:
 *         description: Invalid filename (path traversal rejected)
 *       404:
 *         description: Backup not found
 *       500:
 *         description: Failed to delete backup
 */
export const deleteBackup = async (req, res) => {
  const { filename } = req.params;

  try {
    // Basic security check to prevent path traversal
    if (filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const backupPath = path.join(backupDir, filename);

    // Check if backup file exists
    await fs.access(backupPath);

    // Delete the file
    await fs.unlink(backupPath);

    return res.json({ success: true, message: `Backup ${filename} deleted successfully.` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Backup not found' });
    }
    log.api.error('Error deleting backup', {
      error: error.message,
      stack: error.stack,
      filename,
    });
    return res.status(500).json({ error: 'Failed to delete backup', details: error.message });
  }
};

/**
 * @swagger
 * /settings/restore/{filename}:
 *   post:
 *     summary: Restore configuration from a backup
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: The filename of the backup to restore
 *     responses:
 *       200:
 *         description: Configuration restored successfully
 *       400:
 *         description: Invalid filename (path traversal rejected)
 *       500:
 *         description: Failed to restore backup
 */
export const restoreBackup = async (req, res) => {
  const { filename } = req.params;

  try {
    // Basic security check to prevent path traversal (same guard as deleteBackup)
    if (filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const backupPath = path.join(backupDir, filename);

    // Check if backup file exists
    await fs.access(backupPath);

    // Create a backup of the current config before restoring
    await createBackup();

    // Restore the backup
    await fs.copyFile(backupPath, configPath);

    // Reload the configuration
    config.load();

    return res.json({
      success: true,
      message: `Restored configuration from ${filename}. A server restart may be required.`,
    });
  } catch (error) {
    log.api.error('Error restoring backup', {
      error: error.message,
      stack: error.stack,
      filename,
    });
    return res.status(500).json({ error: 'Failed to restore backup', details: error.message });
  }
};
