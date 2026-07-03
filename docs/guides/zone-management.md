---
title: Zone Management
layout: default
nav_order: 5
parent: Guides
permalink: /docs/guides/zone-management/
---

# Zone Management
{: .no_toc }

Create, modify, and manage bhyve virtual machine zones through the API.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The Zoneweaver Agent provides full zone lifecycle management:

- **Create** zones with `POST /zones` - from scratch, from templates, or with existing storage
- **Modify** zone configuration with `PUT /zones/:zoneName` - changes queue and apply on next boot
- **Start/Stop/Restart** zones with existing lifecycle endpoints
- **Delete** zones with `DELETE /zones/:zoneName`

All create and modify operations are **asynchronous** - they return a task ID immediately, and the actual work is processed in the background via the task queue. Track progress with `GET /tasks/:taskId`.

---

## Creating Zones

### Minimal Creation

Only `name` and `brand` are required:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-vm-01",
    "brand": "bhyve"
  }'
```

Response:

```json
{
  "success": true,
  "task_id": "a1b2c3d4-...",
  "zone_name": "test-vm-01",
  "operation": "zone_create",
  "status": "pending",
  "message": "Zone creation task queued successfully"
}
```

This creates a bare bhyve zone with default settings and no disks - useful for PXE/netboot scenarios or when you plan to add resources via modification later.

### Creation with Resources

Specify optional resources at creation time:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "web-server-01",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "diskif": "virtio",
    "netif": "virtio",
    "vnc": "on",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G",
      "sparse": true
    },
    "nics": [
      {
        "physical": "vnic0",
        "global_nic": "igb0"
      }
    ],
    "cdroms": [
      { "path": "/iso/omnios-r151050.iso" }
    ],
    "start_after_create": true
  }'
```

### Creation from Template

Clone an existing template for fast provisioning:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "from-template",
    "brand": "bhyve",
    "source": {
      "type": "template",
      "template_dataset": "rpool/templates/omnios-base",
      "clone_strategy": "clone"
    },
    "boot_volume": {
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G"
    }
  }'
```

Clone strategies:
- `clone` - Thin ZFS clone (instant, shares blocks with template)
- `copy` - Full ZFS send/recv (independent copy, slower)

### Creation with Existing Storage

Attach an existing ZFS volume as the boot disk:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "migrated-vm",
    "brand": "bhyve",
    "ram": "4G",
    "vcpus": "4",
    "boot_volume": {
      "create_new": false,
      "existing_dataset": "rpool/vms/old-server/root"
    }
  }'
```

{: .note }
The API checks if existing zvols are already in use by another zone. Use `"force": true` to override this check.

### Auto-Start After Creation

Set `start_after_create: true` to automatically boot the zone once creation completes:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "auto-start-vm",
    "brand": "bhyve",
    "ram": "2G",
    "start_after_create": true
  }'
```

The response includes both task IDs:

```json
{
  "success": true,
  "task_id": "create-task-uuid",
  "start_task_id": "start-task-uuid",
  "zone_name": "auto-start-vm",
  "operation": "zone_create",
  "status": "pending",
  "message": "Zone creation task queued with auto-start"
}
```

### Cloud-Init Provisioning

Configure cloud-init attributes for automated guest setup:

```bash
curl -X POST https://your-server:5001/zones \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cloud-vm",
    "brand": "bhyve",
    "ram": "2G",
    "vcpus": "2",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G"
    },
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "example.com",
      "password": "changeme",
      "resolvers": "8.8.8.8,8.8.4.4",
      "sshkey": "ssh-rsa AAAA..."
    }
  }'
```

---

## Modifying Zones

### Overview

Zone modifications are applied via `zonecfg` and **take effect on next zone boot**. The zone can continue running while changes are queued - this allows you to make multiple modifications before restarting.

### Changing Resources

Update RAM, vCPUs, or other attributes:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "ram": "4G",
    "vcpus": "4",
    "vnc": "on"
  }'
```

Response:

```json
{
  "success": true,
  "task_id": "modify-task-uuid",
  "zone_name": "web-server-01",
  "operation": "zone_modify",
  "status": "pending",
  "message": "Modification queued. Changes will take effect on next zone boot.",
  "requires_restart": true
}
```

### Adding and Removing NICs

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_nics": [
      { "physical": "vnic1", "global_nic": "igb0" }
    ],
    "remove_nics": ["vnic0"]
  }'
```

NICs with `global_nic` are created on-demand when the zone boots. Omit `global_nic` for pre-created VNICs.

### Adding and Removing Disks

Add a new disk:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_disks": [
      {
        "create_new": true,
        "pool": "rpool",
        "dataset": "zones",
        "volume_name": "data",
        "size": "100G"
      }
    ]
  }'
```

Attach an existing zvol:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_disks": [
      {
        "create_new": false,
        "existing_dataset": "rpool/shared/backup-vol"
      }
    ]
  }'
```

Remove a disk:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "remove_disks": ["disk0"]
  }'
```

### Adding and Removing CD-ROMs

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "add_cdroms": [
      { "path": "/iso/install.iso" }
    ]
  }'
```

### Updating Cloud-Init

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "cloud_init": {
      "enabled": "on",
      "dns_domain": "newdomain.com",
      "resolvers": "1.1.1.1,1.0.0.1"
    }
  }'
```

### Setting Autoboot

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "autoboot": true
  }'
```

---

## Tracking Progress

All creation and modification operations are asynchronous. Track progress via the task API:

```bash
curl https://your-server:5001/tasks/TASK_ID \
  -H "Authorization: Bearer wh_your_api_key"
```

Creation tasks report granular progress:

| Progress | Stage |
|----------|-------|
| 5% | Validating parameters |
| 10% | Preparing storage (ZFS volumes) |
| 30% | Importing template (if applicable) |
| 40% | Applying zone configuration |
| 50% | Configuring boot disk |
| 60% | Configuring additional disks |
| 70% | Configuring CD-ROMs |
| 75% | Configuring network interfaces |
| 80% | Configuring cloud-init |
| 90% | Installing zone |
| 95% | Creating database record |
| 100% | Complete |

---

## Error Handling

### Duplicate Zone (409)

```json
{
  "error": "Zone web-server-01 already exists in database"
}
```

### Invalid Zone Name (400)

```json
{
  "error": "Invalid zone name"
}
```

### No Changes Specified (400)

```json
{
  "error": "No modification fields specified"
}
```

### Zvol In Use (during task execution)

If a zvol is already attached to another zone, the creation/modification task will fail unless `force: true` is set in the request body.

### Rollback on Failure

If zone creation fails at any stage, the system automatically rolls back:
1. Removes the `zonecfg` configuration (if applied)
2. Destroys any ZFS datasets that were created during the task (does not touch existing datasets)

---

## Available Properties

### Zone Attributes

| Property | Type | Description | Example |
|----------|------|-------------|---------|
| `name` | string | Zone name (required) | `"web-server-01"` |
| `brand` | string | Zone brand (required for creation) | `"bhyve"` |
| `ram` | string | Memory allocation | `"2G"` |
| `vcpus` | string | Virtual CPU count | `"2"` |
| `bootrom` | string | Boot ROM firmware | `"BHYVE_RELEASE_CSM"` |
| `hostbridge` | string | Host bridge emulation | `"i440fx"` |
| `diskif` | string | Disk interface | `"virtio"` |
| `netif` | string | Network interface type | `"virtio"` |
| `os_type` | string | Guest OS type | `"generic"` |
| `vnc` | string | VNC console | `"on"` |
| `acpi` | string | ACPI support | `"on"` |
| `xhci` | string | xHCI USB controller | `"on"` |
| `autoboot` | boolean | Auto-boot on host startup | `false` |

### Boot Volume Options

| Option | Description |
|--------|-------------|
| `create_new: true` | Create a new ZFS volume with specified pool/dataset/size |
| `existing_dataset` | Attach an existing ZFS dataset (zvol) |
| From template | Clone or copy from a template dataset |
| Omitted | No boot disk (diskless zone for PXE/netboot) |

---

## Provisioning Zones

### Overview

After zone creation, you can run the **provisioning pipeline** to automatically configure networking, sync files, and execute provisioners (shell scripts, Ansible playbooks). This is the automated equivalent of manually logging into a zone and running setup commands.

For comprehensive provisioning documentation, see the [Provisioning Pipeline Guide](provisioning.md).

### Provisioning Workflow

1. **Create zone** (if not already created)
2. **Upload provisioning artifact** — tar.gz with your scripts, playbooks, files
3. **Set provisioning configuration** on the zone
4. **Kick off provisioning pipeline** — `POST /zones/{name}/provision`
5. **Track progress** — Monitor the task chain as each stage completes

### Setting Provisioning Configuration

Use `PUT /zones/{name}` to set provisioning metadata:

```bash
curl -X PUT https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "provisioning": {
      "recipe_id": "uuid-of-debian-netplan-recipe",
      "mode": "ansible_local",
      "artifact_id": "uuid-of-uploaded-tar-gz",
      "credentials": {
        "username": "startcloud",
        "password": "STARTcloud24@!",
        "ssh_key_path": "/etc/zoneweaver-agent/ssh/provision_key"
      },
      "sync_folders": [
        {
          "source": "provisioning_dataset",
          "dest": "/vagrant",
          "exclude": []
        }
      ],
      "provisioners": [
        {
          "type": "ansible_local",
          "playbook": "/vagrant/ansible/playbook.yml",
          "collections": ["startcloud.startcloud_roles"],
          "extra_vars": {
            "hostname": "web01",
            "domain": "example.com"
          }
        }
      ],
      "variables": {
        "vnic_name": "eth0",
        "ip": "10.190.190.10",
        "gateway": "10.190.190.1",
        "dns": "8.8.8.8"
      }
    }
  }'
```

**Key fields:**
- `recipe_id` — Zlogin automation recipe for network setup (see [Provisioning Guide](provisioning.md))
- `mode` — Provisioner type: `shell`, `ansible`, `ansible_local`, or `none`
- `artifact_id` — ID of uploaded provisioning artifact (tar.gz)
- `credentials` — SSH credentials for zone access
- `provisioners` — Array of provisioner definitions
- `variables` — Custom variables for recipe and provisioners

### Kicking Off Provisioning

Once configuration is set, start the pipeline:

```bash
curl -X POST https://your-server:5001/zones/web-server-01/provision \
  -H "Authorization: Bearer wh_your_api_key"
```

**Response:**
```json
{
  "success": true,
  "task_id": "provision-task-uuid",
  "zone_name": "web-server-01",
  "operation": "zone_provision",
  "status": "pending",
  "message": "Provisioning pipeline started",
  "pipeline_tasks": {
    "extract": "extract-task-uuid",
    "boot": "boot-task-uuid",
    "setup": "setup-task-uuid",
    "wait_ssh": "wait-ssh-task-uuid",
    "sync": "sync-task-uuid",
    "provision": "provision-task-uuid"
  }
}
```

### Provisioning Pipeline Stages

The pipeline executes these stages sequentially (each is a separate task with `depends_on` chaining):

| Stage | Task Operation | Description |
|-------|----------------|-------------|
| 1. Extract | `zfs_create_dataset` + artifact extraction | Extract provisioning tar.gz to ZFS dataset |
| 2. Boot | `zone_start` | Start the zone |
| 3. Setup | `zone_setup` | Run zlogin recipe to configure network |
| 4. Wait SSH | `zone_wait_ssh` | Poll until SSH is responsive |
| 5. Sync | `zone_sync` | rsync files from host to zone |
| 6. Provision | `zone_provision` | Execute provisioners (shell/ansible) |

After completion, ZFS snapshots are created:
- `@pre-provision` — Before running provisioners (rollback point)
- `@post-provision` — After successful provisioning (known-good state)

### Checking Provisioning Status

```bash
curl https://your-server:5001/zones/web-server-01/provision/status \
  -H "Authorization: Bearer wh_your_api_key"
```

**Response:**
```json
{
  "success": true,
  "zone_name": "web-server-01",
  "status": "provisioning",
  "current_stage": "zone_sync",
  "progress": {
    "extract": "completed",
    "boot": "completed",
    "setup": "completed",
    "wait_ssh": "completed",
    "sync": "in_progress",
    "provision": "pending"
  },
  "last_provisioned_at": null
}
```

### Canceling Provisioning

If provisioning is stuck or needs to be stopped:

```bash
curl -X POST https://your-server:5001/zones/web-server-01/provision/cancel \
  -H "Authorization: Bearer wh_your_api_key"
```

This cancels all pending/running tasks in the pipeline.

### Rolling Back Provisioning

If provisioning failed or produced incorrect results, rollback to the pre-provision snapshot:

```bash
curl -X POST https://your-server:5001/zones/web-server-01/provision/rollback \
  -H "Authorization: Bearer wh_your_api_key"
```

This rolls back the provisioning ZFS dataset to `@pre-provision`, removing all provisioner changes.

### Provisioning Use Cases

**Scenario 1: Fresh Debian VM with Ansible**
1. Create zone from Debian template
2. Upload Ansible playbook tar.gz
3. Set provisioning config with `debian-netplan` recipe
4. Kick off provisioning → Zone auto-configures network, runs Ansible playbook

**Scenario 2: OmniOS Zone with Shell Scripts**
1. Create zone from OmniOS template
2. Upload scripts tar.gz
3. Set provisioning config with `omnios-dladm` recipe and `shell` provisioner
4. Kick off provisioning → Zone configures network, runs setup scripts

**Scenario 3: Cloud-Init Only (No Zlogin)**
1. Create zone with cloud-init attributes set
2. Set provisioning config with `cloud-init-wait` recipe (no zlogin automation)
3. Kick off provisioning → Pipeline waits for cloud-init, then syncs files and runs provisioners

### Related Documentation

- **[Provisioning Pipeline Guide](provisioning.md)** — Complete provisioning system documentation
- **[Network Management Guide](network-management.md)** — NAT, DHCP, provisioning network setup
- **Provisioning recipes** — `GET /provisioning/recipes` for available recipes

---

## Deleting Zones

### Basic Delete

Delete a zone (configuration only):

```bash
curl -X DELETE https://your-server:5001/zones/web-server-01 \
  -H "Authorization: Bearer wh_your_api_key"
```

**What happens:**
1. Zone halted (if running)
2. Zone uninstalled (`zoneadm uninstall -F`)
3. Zone configuration removed (`zonecfg delete -F`)
4. Database record removed

**ZFS datasets are NOT deleted** — boot volumes, additional disks, and provisioning datasets remain on disk. This is the safe default to prevent accidental data loss.

### Delete with ZFS Cleanup

To automatically destroy all zone-related ZFS datasets during deletion, use the `cleanup_datasets` query parameter:

```bash
curl -X DELETE "https://your-server:5001/zones/web-server-01?cleanup_datasets=true" \
  -H "Authorization: Bearer wh_your_api_key"
```

**What happens:**
1. Zone halted (if running)
2. Zone configuration read to identify all datasets
3. Zone uninstalled
4. Zone configuration removed
5. **ZFS datasets destroyed:**
   - Boot volume (e.g., `rpool/zones/web-server-01/root`)
   - Zonepath (e.g., `rpool/zones/web-server-01/path`)
   - Provisioning dataset (e.g., `rpool/zones/web-server-01/provisioning`)
   - Additional disks **within zone hierarchy** (e.g., `rpool/zones/web-server-01/data`)
6. Database record removed

**Safety considerations:**
- ✅ Only destroys datasets within the zone's own hierarchy (e.g., `rpool/zones/web-server-01/*`)
- ✅ Does NOT destroy datasets attached via `existing_dataset` (external storage not owned by the zone)
- ⚠️ **Irreversible** — All data in destroyed datasets is permanently lost
- ⚠️ **No ZFS snapshots preserved** — If you want to keep snapshots, manually snapshot before deleting

### When to Use Cleanup

**Use `cleanup_datasets=true` when:**
- Zone is temporary (testing, CI/CD, ephemeral workloads)
- You're certain the data is no longer needed
- You want a complete clean slate (no orphaned datasets)
- Storage space is limited and you need to reclaim space immediately

**Do NOT use cleanup when:**
- Zone data might be needed later (backups, forensics, rollback)
- Datasets are shared with other systems (e.g., NFS-exported zvols)
- You want to re-attach storage to a new zone later
- You're unsure about data retention requirements

### Example: Clean Delete Workflow

Full cleanup of a test zone:

```bash
# 1. Halt the zone
curl -X POST https://your-server:5001/zones/test-zone/halt \
  -H "Authorization: Bearer wh_your_api_key"

# 2. Wait for halt to complete (check task status)

# 3. Delete with cleanup
curl -X DELETE "https://your-server:5001/zones/test-zone?cleanup_datasets=true" \
  -H "Authorization: Bearer wh_your_api_key"

# 4. Verify deletion
curl https://your-server:5001/zones/test-zone \
  -H "Authorization: Bearer wh_your_api_key"
# Should return 404 Not Found
```

### Recovering from Failed Delete

If delete fails partway through:

1. **Check zone status:**
   ```bash
   # On host
   pfexec zoneadm list -cv
   ```

2. **Manually complete cleanup:**
   ```bash
   # On host
   pfexec zoneadm -z test-zone uninstall -F
   pfexec zonecfg -z test-zone delete -F
   pfexec zfs destroy -r rpool/zones/test-zone  # If cleanup_datasets was intended
   ```

3. **Remove database record:**
   ```bash
   curl -X DELETE https://your-server:5001/zones/test-zone/force \
     -H "Authorization: Bearer wh_your_api_key"
   ```

---

## Related Documentation

- [Provisioning Pipeline Guide](provisioning.md) — Automated zone configuration
- [Network Management Guide](network-management.md) — NAT, DHCP, provisioning network
- [VNC Console Guide](vnc-console.md) — Graphical access to zones
- [Template Management](templates.md) — Creating and managing zone templates
