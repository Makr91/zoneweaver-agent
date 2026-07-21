import { parseAsync } from '../../lib/AsyncJson.js';
import { log } from '../../lib/Logger.js';
import { moveItem, copyItem, createArchive, extractArchive } from '../../lib/FileSystemManager.js';

/**
 * File Manager for File Operations
 * Handles file move, copy, archive creation, and archive extraction
 */

/**
 * Execute file move task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeFileMoveTask = async metadataJson => {
  log.filesystem.debug('File move task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { source, destination } = metadata;

    log.filesystem.debug('File move task parameters', {
      source,
      destination,
    });

    await moveItem(source, destination);

    log.filesystem.info('File move completed', {
      source,
      destination,
    });

    return {
      success: true,
      message: `Successfully moved '${source}' to '${destination}'`,
    };
  } catch (error) {
    log.filesystem.error('File move task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `File move task failed: ${error.message}` };
  }
};

/**
 * Execute file copy task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeFileCopyTask = async metadataJson => {
  log.filesystem.debug('File copy task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { source, destination } = metadata;

    log.filesystem.debug('File copy task parameters', {
      source,
      destination,
    });

    await copyItem(source, destination);

    log.filesystem.info('File copy completed', {
      source,
      destination,
    });

    return {
      success: true,
      message: `Successfully copied '${source}' to '${destination}'`,
    };
  } catch (error) {
    log.filesystem.error('File copy task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `File copy task failed: ${error.message}` };
  }
};

/**
 * Execute file archive creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeFileArchiveCreateTask = async metadataJson => {
  log.filesystem.debug('File archive create task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { sources, archive_path, format } = metadata;

    log.filesystem.debug('Archive creation task parameters', {
      sources,
      archive_path,
      format,
    });

    await createArchive(sources, archive_path, format);

    log.filesystem.info('Archive created successfully', {
      archive_path,
      format,
      source_count: sources.length,
    });

    return {
      success: true,
      message: `Successfully created ${format} archive '${archive_path}' with ${sources.length} items`,
    };
  } catch (error) {
    log.filesystem.error('Archive creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Archive creation task failed: ${error.message}` };
  }
};

/**
 * Execute file archive extraction task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeFileArchiveExtractTask = async metadataJson => {
  log.filesystem.debug('File archive extract task starting');

  try {
    const metadata = await parseAsync(metadataJson);
    const { archive_path, extract_path } = metadata;

    log.filesystem.debug('Archive extraction task parameters', {
      archive_path,
      extract_path,
    });

    await extractArchive(archive_path, extract_path);

    log.filesystem.info('Archive extracted successfully', {
      archive_path,
      extract_path,
    });

    return {
      success: true,
      message: `Successfully extracted archive '${archive_path}' to '${extract_path}'`,
    };
  } catch (error) {
    log.filesystem.error('Archive extraction task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Archive extraction task failed: ${error.message}` };
  }
};
