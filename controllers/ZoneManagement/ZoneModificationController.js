import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';
import { validateZoneModificationResources } from '../../lib/ResourceValidation.js';

/**
 * @fileoverview Zone modification controller
 */

/**
 * @swagger
 * /machines/{machineName}:
 *   put:
 *     summary: Modify machine configuration
 *     description: |
 *       Queues a task to modify an existing machine's (zone's) configuration via `zonecfg`.
 *       Changes are applied to the zone config but take effect on next zone boot.
 *       The zone can continue running while modifications are queued.
 *       At least one modification field must be provided.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: machineName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the machine to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ram:
 *                 type: string
 *                 description: Memory allocation
 *                 example: "4G"
 *               vcpus:
 *                 type: string
 *                 description: Number of virtual CPUs
 *                 example: "4"
 *               bootrom:
 *                 type: string
 *                 description: Boot ROM firmware
 *                 example: "BHYVE_RELEASE_CSM"
 *               hostbridge:
 *                 type: string
 *                 description: Host bridge emulation
 *                 example: "i440fx"
 *               diskif:
 *                 type: string
 *                 description: Disk interface type
 *                 example: "virtio"
 *               netif:
 *                 type: string
 *                 description: Network interface type
 *                 example: "virtio"
 *               os_type:
 *                 type: string
 *                 description: Guest OS type
 *                 example: "generic"
 *               vnc:
 *                 type: string
 *                 description: VNC console setting
 *                 example: "on"
 *               acpi:
 *                 type: string
 *                 description: ACPI support
 *                 example: "on"
 *               xhci:
 *                 type: string
 *                 description: xHCI USB controller
 *                 example: "on"
 *               autoboot:
 *                 type: boolean
 *                 description: Auto-boot zone on system startup
 *               cpu_configuration:
 *                 type: string
 *                 enum: [simple, complex]
 *                 description: "Change CPU topology mode"
 *                 example: "complex"
 *               complex_cpu_conf:
 *                 type: array
 *                 description: "New CPU topology (required if cpu_configuration is 'complex')"
 *                 items:
 *                   type: object
 *                   required: [sockets, cores, threads]
 *                   properties:
 *                     sockets:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 16
 *                     cores:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 32
 *                     threads:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 2
 *                 example:
 *                   - sockets: 2
 *                     cores: 2
 *                     threads: 1
 *               add_nics:
 *                 type: array
 *                 description: NICs to add to the zone
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC name
 *                       example: "vnic1"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand creation
 *                       example: "igb0"
 *               remove_nics:
 *                 type: array
 *                 description: VNIC names to remove
 *                 items:
 *                   type: string
 *                   example: "vnic0"
 *               add_disks:
 *                 type: array
 *                 description: Disks to add (new zvols or existing datasets)
 *                 items:
 *                   type: object
 *                   properties:
 *                     create_new:
 *                       type: boolean
 *                     existing_dataset:
 *                       type: string
 *                     pool:
 *                       type: string
 *                       example: "rpool"
 *                     dataset:
 *                       type: string
 *                       example: "zones"
 *                     volume_name:
 *                       type: string
 *                       example: "extra"
 *                     size:
 *                       type: string
 *                       example: "100G"
 *               remove_disks:
 *                 type: array
 *                 description: Disk attribute names to remove (e.g. "disk0")
 *                 items:
 *                   type: string
 *                   example: "disk0"
 *               add_cdroms:
 *                 type: array
 *                 description: ISO images to attach
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                       example: "/iso/install.iso"
 *               remove_cdroms:
 *                 type: array
 *                 description: CDROM attribute names to remove (e.g. "cdrom0")
 *                 items:
 *                   type: string
 *                   example: "cdrom0"
 *               notes:
 *                 type: string
 *                 nullable: true
 *                 description: Free-form user notes for this zone
 *                 example: "Primary web server"
 *               tags:
 *                 type: array
 *                 nullable: true
 *                 description: User-defined tags for categorization and filtering
 *                 items:
 *                   type: string
 *                 example: ["web", "production"]
 *               cloud_init:
 *                 type: object
 *                 description: Cloud-init attributes to set or update
 *                 properties:
 *                   enabled:
 *                     type: string
 *                     example: "on"
 *                   dns_domain:
 *                     type: string
 *                     example: "example.com"
 *                   password:
 *                     type: string
 *                   resolvers:
 *                     type: string
 *                     example: "8.8.8.8,8.8.4.4"
 *                   sshkey:
 *                     type: string
 *               provisioner:
 *                 type: object
 *                 description: Provisioner configuration object
 *                 example: { "type": "ansible", "playbook": "site.yml" }
 *           examples:
 *             change_resources:
 *               summary: Change RAM and vCPUs
 *               value:
 *                 ram: "4G"
 *                 vcpus: "4"
 *             add_nic:
 *               summary: Add a NIC
 *               value:
 *                 add_nics:
 *                   - physical: "vnic1"
 *                     global_nic: "igb0"
 *             add_disk:
 *               summary: Add a new disk
 *               value:
 *                 add_disks:
 *                   - create_new: true
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "extra"
 *                     size: "100G"
 *     responses:
 *       200:
 *         description: Modification task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 machine_name:
 *                   type: string
 *                   example: "web-server-01"
 *                 operation:
 *                   type: string
 *                   example: "zone_modify"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Modification queued. Changes will take effect on next zone boot."
 *                 requires_restart:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid parameters or no changes specified
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue modification task
 */
export const modifyZone = async (req, res) => {
  try {
    const { machineName: zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check zone exists in DB
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Validate that at least one change field is present
    const changeFields = [
      'ram',
      'vcpus',
      'bootrom',
      'hostbridge',
      'diskif',
      'netif',
      'os_type',
      'vnc',
      'acpi',
      'xhci',
      'autoboot',
      'add_nics',
      'remove_nics',
      'add_disks',
      'remove_disks',
      'add_cdroms',
      'remove_cdroms',
      'cloud_init',
      'provisioner',
      'notes',
      'tags',
    ];
    const hasChanges = changeFields.some(field => req.body[field] !== undefined);

    if (!hasChanges) {
      return res.status(400).json({ error: 'No modification fields specified' });
    }

    // Handle notes update immediately (DB only, no zone config task needed)
    if (req.body.notes !== undefined) {
      await zone.update({ notes: req.body.notes || null });
    }

    // Handle tags update immediately (DB only, no zone config task needed)
    if (req.body.tags !== undefined) {
      const tags = Array.isArray(req.body.tags) ? req.body.tags : null;
      await zone.update({ tags });
    }

    // If only DB-only fields were changed, return early
    const dbOnlyFields = ['notes', 'tags'];
    const hasDbOnlyChanges = dbOnlyFields.some(f => req.body[f] !== undefined);
    const hasOtherChanges = changeFields
      .filter(f => !dbOnlyFields.includes(f))
      .some(field => req.body[field] !== undefined);
    if (hasDbOnlyChanges && !hasOtherChanges) {
      return res.json({
        success: true,
        machine_name: zoneName,
        operation: 'zone_modify',
        status: 'completed',
        message: 'Zone metadata updated successfully.',
        requires_restart: false,
      });
    }

    // Handle provisioner config update immediately (DB only)
    // This ensures the config is available for the provision endpoint without waiting for the task
    if (req.body.provisioner) {
      let currentConfig = zone.configuration || {};
      if (typeof currentConfig === 'string') {
        try {
          currentConfig = JSON.parse(currentConfig);
        } catch (parseError) {
          log.database.warn('Failed to parse current zone configuration', {
            error: parseError.message,
          });
          currentConfig = {};
        }
      }
      const newConfig = { ...currentConfig, provisioner: req.body.provisioner };
      await zone.update({ configuration: newConfig });

      // If this is the only change, we can return early without queuing a task
      const otherChanges = changeFields
        .filter(f => f !== 'provisioner')
        .some(field => req.body[field] !== undefined);
      if (!otherChanges) {
        return res.json({
          success: true,
          machine_name: zoneName,
          operation: 'zone_modify',
          status: 'completed',
          message: 'Provisioner configuration updated successfully.',
          requires_restart: false,
        });
      }
    }

    // Validate resource availability for modifications (e.g., add_disks)
    const resourceValidation = await validateZoneModificationResources(req.body, zoneName);
    if (!resourceValidation.valid) {
      return res.status(400).json({
        error: 'Insufficient resources',
        details: resourceValidation.errors,
      });
    }

    // Create the zone_modify task
    const modifyTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'zone_modify',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'pending',
    });

    const modifyResponse = {
      success: true,
      task_id: modifyTask.id,
      machine_name: zoneName,
      operation: 'zone_modify',
      status: 'pending',
      message: 'Modification queued. Changes will take effect on next zone boot.',
      requires_restart: true,
    };
    if (resourceValidation.warnings.length > 0) {
      modifyResponse.resource_warnings = resourceValidation.warnings;
    }
    return res.json(modifyResponse);
  } catch (error) {
    log.database.error('Database error modifying zone task', {
      error: error.message,
      zone_name: req.params.machineName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone modification task' });
  }
};
