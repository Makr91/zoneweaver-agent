import { parseAsync } from '../../../lib/AsyncJson.js';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import Template from '../../../models/TemplateModel.js';

/**
 * @fileoverview Template delete task executor
 */

/**
 * Execute template delete task
 * Destroys the ZFS dataset and removes the database record
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateDeleteTask = async metadataJson => {
  log.task.debug('Template delete task starting');

  try {
    const metadata = await parseAsync(metadataJson);

    const { template_id } = metadata;

    const template = await Template.findByPk(template_id);
    if (!template) {
      return {
        success: false,
        error: `Template not found: ${template_id}`,
      };
    }

    log.task.info('Deleting template', {
      template_id,
      dataset_path: template.dataset_path,
      box: `${template.organization}/${template.box_name}`,
      version: template.version,
    });

    // Destroy ZFS dataset
    if (template.dataset_path) {
      const destroyResult = await executeCommand(`pfexec zfs destroy -r ${template.dataset_path}`);
      if (!destroyResult.success) {
        log.task.warn('Failed to destroy ZFS dataset, continuing with DB cleanup', {
          dataset_path: template.dataset_path,
          error: destroyResult.error,
        });
      }
    }

    // Remove database record
    const templateInfo = {
      organization: template.organization,
      box_name: template.box_name,
      version: template.version,
    };
    await template.destroy();

    log.task.info('Template deleted successfully', {
      template_id,
      ...templateInfo,
    });

    return {
      success: true,
      message: `Template '${templateInfo.organization}/${templateInfo.box_name}' v${templateInfo.version} deleted successfully`,
    };
  } catch (error) {
    log.task.error('Template delete task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template deletion failed: ${error.message}` };
  }
};
