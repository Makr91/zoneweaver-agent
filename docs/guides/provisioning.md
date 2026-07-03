---
layout: default
title: Provisioning Pipeline Guide
parent: Guides
nav_order: 4
---

# Provisioning Pipeline Guide
{: .no_toc }

Complete guide to the Zoneweaver Agent provisioning pipeline for automated zone configuration.
{: .fs-6 .fw-300 }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The Zoneweaver Agent provisioning pipeline automates the complete lifecycle from zone creation through network configuration, file synchronization, and application deployment. This replicates the full vagrant-zones + core_provisioner workflow in a REST API.

### Pipeline Stages

```
1. Extract Artifact  → Extract provisioning tar.gz to ZFS dataset
2. Boot Zone         → Start the zone
3. Setup (Recipe)    → Configure network via zlogin console automation
4. Wait for SSH      → Poll until SSH becomes available
5. Sync Files        → rsync provisioning files into zone
6. Execute           → Run shell scripts or Ansible playbooks
```

### Key Features

- **Zlogin Automation**: Configure networking before SSH via console recipes
- **Recipe System**: Reusable automation templates for different OS families
- **Artifact Management**: Upload provisioning files as tar.gz archives
- **Provisioning Profiles**: Named configurations for common deployment patterns
- **ZFS Integration**: Provisioning files stored as datasets with snapshot support
- **Rollback Capability**: @pre-provision snapshot for easy recovery

---

## Prerequisites

Before provisioning a zone, ensure:

1. **Zone Created**: Zone must exist (via `POST /zones`)
2. **Provisioning Artifact**: Upload tar.gz with ansible playbooks, scripts, files
3. **Recipe Exists**: (Optional) Zlogin automation recipe for OS family
4. **Provisioning Network**: (Optional) Host has provisioning network set up

---

## Quick Start

### 1. Create Zone

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/zones \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "name": "web-server-01",
    "brand": "bhyve",
    "ram": "4G",
    "vcpus": "2",
    "boot_volume": {
      "create_new": true,
      "pool": "rpool",
      "dataset": "zones",
      "volume_name": "root",
      "size": "30G"
    },
    "nics": [
      {"physical": "vnic0", "global_nic": "igb0"}
    ]
  }'
```

### 2. Upload Provisioning Artifact

Prepare a tar.gz with your provisioning files:

```bash
tar -czf provisioning.tar.gz ansible/ scripts/ files/
```

Upload via the artifact API:

```bash
# Prepare upload
curl -X POST https://hv-04-backend.home.m4kr.net:5001/artifacts/upload/prepare \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "filename": "provisioning.tar.gz",
    "size": 1048576,
    "zone_name": "web-server-01"
  }'

# Upload chunks (use returned task_id)
curl -X POST https://hv-04-backend.home.m4kr.net:5001/artifacts/upload/TASK_ID \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  --data-binary @provisioning.tar.gz
```

### 3. Set Provisioning Configuration

```bash
curl -X PUT https://hv-04-backend.home.m4kr.net:5001/zones/web-server-01 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "provisioning": {
      "recipe_id": "RECIPE_UUID",
      "mode": "ansible_local",
      "artifact_id": "ARTIFACT_UUID",
      "credentials": {
        "username": "startcloud",
        "password": "STARTcloud24@!"
      },
      "ip": "10.190.190.10",
      "ssh_port": 22,
      "variables": {
        "vnic_name": "enp0s3",
        "mac": "02:08:20:00:00:01",
        "gateway": "10.190.190.1",
        "dns": "8.8.8.8"
      },
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
      ]
    }
  }'
```

### 4. Kick Off Provisioning Pipeline

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/zones/web-server-01/provision \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 5. Monitor Progress

```bash
curl https://hv-04-backend.home.m4kr.net:5001/zones/web-server-01/provision/status \
  -H "Authorization: Bearer YOUR_API_KEY"
```

---

## Recipe System

### What are Recipes?

Recipes are zlogin automation templates for configuring networking via the zone's serial console **before SSH is available**. Think of them as expect-like scripts for early-boot configuration.

### Default Recipes

Zoneweaver Agent ships with 5 default recipes:

| Name | OS Family | Description |
|------|-----------|-------------|
| `debian-netplan` | Linux | Debian 12+, Ubuntu 18+ (netplan) |
| `linux-ifconfig` | Linux | Older Linux (ifconfig/interfaces) |
| `omnios-dladm` | Solaris | OmniOS/illumos (dladm/ipadm) |
| `windows-sac` | Windows | Windows Server (SAC console + netsh) |
| `cloud-init-wait` | Linux | Wait for cloud-init (no automation) |

### Recipe Structure

```json
{
  "name": "debian-netplan",
  "os_family": "linux",
  "brand": "bhyve",
  "boot_string": "Web console:",
  "login_prompt": "login:",
  "shell_prompt": ":~$",
  "timeout_seconds": 300,
  "variables": {
    "username": "root",
    "password": "changeme",
    "vnic_name": "enp0s3",
    "ip": "10.190.190.10",
    "prefix": "24",
    "gateway": "10.190.190.1"
  },
  "steps": [
    { "type": "wait", "pattern": "{{login_prompt}}", "timeout": 60 },
    { "type": "send", "value": "{{username}}\\r\\n" },
    { "type": "wait", "pattern": "Password:" },
    { "type": "send", "value": "{{password}}\\r\\n" },
    { "type": "command", "value": "rm -rf /etc/netplan/*.yaml" },
    { "type": "template", "dest": "/etc/netplan/config.yaml", "content": "..." },
    { "type": "command", "value": "netplan apply" }
  ]
}
```

### Recipe Step Types

| Type | Purpose | Example |
|------|---------|---------|
| `wait` | Wait for pattern in console output | `{"type": "wait", "pattern": "login:", "timeout": 60}` |
| `send` | Send text to console | `{"type": "send", "value": "root\\r\\n"}` |
| `command` | Execute command, verify exit code | `{"type": "command", "value": "netplan apply"}` |
| `template` | Write file via echo redirect or heredoc | `{"type": "template", "dest": "/etc/config", "content": "..."}` |
| `delay` | Wait N seconds | `{"type": "delay", "seconds": 5}` |

### Variable Resolution

Variables are resolved at execution time using `{{variable}}` syntax:

```json
{
  "variables": {
    "ip": "10.190.190.10",
    "gateway": "10.190.190.1"
  },
  "steps": [
    {
      "type": "command",
      "value": "ip addr add {{ip}}/24 dev eth0"
    }
  ]
}
```

Variables can come from:
- Recipe defaults (`recipe.variables`)
- Provisioning config (`provisioning.variables`)
- Runtime overrides (via API request)

### Creating Custom Recipes

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/provisioning/recipes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "name": "alpine-ifconfig",
    "description": "Alpine Linux network config",
    "os_family": "linux",
    "brand": "bhyve",
    "boot_string": "localhost login:",
    "login_prompt": "login:",
    "shell_prompt": ":~#",
    "timeout_seconds": 300,
    "variables": {
      "username": "root",
      "password": "alpine"
    },
    "steps": [
      { "type": "wait", "pattern": "{{login_prompt}}", "timeout": 60 },
      { "type": "send", "value": "{{username}}\\r\\n" },
      { "type": "wait", "pattern": "Password:" },
      { "type": "send", "value": "{{password}}\\r\\n" },
      { "type": "command", "value": "ifconfig eth0 {{ip}} netmask {{netmask}}" },
      { "type": "command", "value": "route add default gw {{gateway}}" }
    ]
  }'
```

### Testing Recipes

Dry-run test against a running zone:

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/provisioning/recipes/RECIPE_ID/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "zone_name": "test-zone",
    "dry_run": true,
    "variables": {
      "username": "root",
      "password": "changeme",
      "ip": "10.190.190.10"
    }
  }'
```

---

## Provisioner Types

### Shell Provisioner

Execute bash scripts via SSH:

```json
{
  "type": "shell",
  "scripts": [
    "/vagrant/scripts/setup.sh",
    "/vagrant/scripts/configure.sh"
  ],
  "run_as": "root",
  "env": {
    "APP_ENV": "production"
  }
}
```

Scripts execute sequentially. Exit code 0 = success.

### Ansible Provisioner (Remote)

Run ansible-playbook **on the host** targeting the zone:

```json
{
  "type": "ansible",
  "playbook": "ansible/site.yml",
  "inventory": "custom-inventory",
  "extra_vars": {
    "app_version": "1.2.3",
    "domain": "example.com"
  },
  "collections": [
    "startcloud.startcloud_roles"
  ]
}
```

- Ansible runs on the Zoneweaver Agent host
- Uses SSH to target the zone
- SSH key: `/etc/zoneweaver-agent/ssh/provision_key`

### Ansible-Local Provisioner

Run ansible-playbook **inside the zone**:

```json
{
  "type": "ansible_local",
  "playbook": "/vagrant/ansible/playbook.yml",
  "install_mode": "pip",
  "extra_vars": {
    "hostname": "web01"
  },
  "collections": [
    "startcloud.startcloud_roles"
  ]
}
```

- Ansible executes inside the zone (local connection)
- `install_mode`: `pip` or `pkg` (auto-install Ansible if needed)
- Useful when host doesn't have Ansible installed

---

## Provisioning Profiles

Reusable named configurations for common patterns.

### Create Profile

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/provisioning/profiles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "name": "debian-ansible",
    "description": "Debian zone with Ansible provisioning",
    "recipe_id": "DEBIAN_NETPLAN_RECIPE_ID",
    "default_credentials": {
      "username": "startcloud",
      "password": "STARTcloud24@!"
    },
    "default_provisioners": [
      {
        "type": "ansible_local",
        "playbook": "/vagrant/ansible/playbook.yml",
        "install_mode": "pip"
      }
    ]
  }'
```

### Use Profile

When setting provisioning config, reference the profile:

```bash
curl -X PUT https://hv-04-backend.home.m4kr.net:5001/zones/my-zone \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "provisioning": {
      "profile_id": "PROFILE_UUID",
      "artifact_id": "ARTIFACT_UUID",
      "ip": "10.190.190.10"
    }
  }'
```

Profile settings are merged with zone-specific overrides.

---

## ZFS Integration

### Provisioning Dataset

Provisioning files are stored in a per-zone ZFS dataset:

```
/rpool/zones/web-server-01/provisioning
├── ansible/
│   ├── playbook.yml
│   └── roles/
├── scripts/
│   └── setup.sh
└── files/
    └── config.json
```

Benefits:
- **Snapshots**: Rollback on provisioning failure
- **Quotas**: Limit provisioning file size
- **Compression**: Automatic compression of provisioning data
- **Cloning**: Fast copy for similar zones

### Snapshots

Two automatic snapshots:

| Snapshot | When | Purpose |
|----------|------|---------|
| `@pre-provision` | Before provisioning | Rollback point if provisioners fail |
| `@post-provision` | After success | Known-good state |

### Rollback

If provisioning fails, rollback to clean state:

```bash
curl -X POST https://hv-04-backend.home.m4kr.net:5001/zones/web-server-01/provision/rollback \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This executes:
```bash
pfexec zfs rollback rpool/zones/web-server-01/provisioning@pre-provision
```

---

## Troubleshooting

### Recipe Not Matching Prompts

**Symptom**: Recipe times out waiting for login prompt

**Solutions**:
- Check boot_string, login_prompt, shell_prompt patterns
- Use `POST /provisioning/recipes/{id}/test` with `dry_run: false` to see actual output
- Increase `timeout_seconds` if OS boots slowly
- Check zone serial console manually: `pfexec zlogin -C zone-name`

### SSH Not Available

**Symptom**: zone_wait_ssh task times out

**Solutions**:
- Verify recipe actually configured networking (check recipe execution log)
- Confirm zone IP is correct in provisioning config
- Check zone can reach provisioning network: `pfexec zlogin zone-name ping 10.190.190.1`
- Verify SSH service is running in zone

### Provisioner Fails

**Symptom**: zone_provision task fails with exit code error

**Solutions**:
- Check task output for stderr
- SSH into zone manually and run playbook/script to debug
- Check `/vagrant` directory exists and files synced correctly
- Verify Ansible collections installed (for ansible_local)

### Artifact Extraction Fails

**Symptom**: Provisioning fails before boot

**Solutions**:
- Verify artifact uploaded successfully
- Check artifact is a valid tar.gz: `file artifact.tar.gz`
- Ensure ZFS pool has space: `pfexec zfs list -o space`
- Check artifact_id exists in database

### Rollback Not Working

**Symptom**: @pre-provision snapshot not found

**Solutions**:
- Snapshot is created only if artifact extraction succeeds
- Check ZFS snapshots manually: `pfexec zfs list -t snapshot | grep pre-provision`
- If missing, re-run provisioning from scratch

---

## Best Practices

### Recipe Design

- **Keep recipes simple**: Focus only on network configuration
- **Use variables**: Make recipes reusable across zones
- **Test incrementally**: Test each step with dry_run first
- **Timeout generously**: Set timeout_seconds higher than needed

### Artifact Structure

Organize provisioning files logically:

```
provisioning/
├── ansible/
│   ├── playbook.yml
│   ├── roles/
│   └── collections/
├── scripts/
│   ├── 01-setup.sh
│   ├── 02-configure.sh
│   └── 03-deploy.sh
├── files/
│   ├── configs/
│   └── keys/
└── README.md
```

### Provisioning Workflow

1. **Develop locally**: Test recipes and provisioners on a test zone
2. **Version control**: Store provisioning files in git
3. **CI/CD integration**: Auto-upload artifacts on commit
4. **Snapshot before major changes**: `zfs snapshot rpool/zones/zone@before-upgrade`
5. **Monitor tasks**: Check task status during provisioning

### Security

- **Credentials**: Store passwords in vault, not in plain text
- **SSH keys**: Use key-based auth instead of passwords when possible
- **Artifact scanning**: Scan uploaded artifacts for malware
- **Network isolation**: Use provisioning network for initial setup
- **Remove provisioning NIC**: After SSH is working, remove DHCP NIC

---

## API Reference

### Provisioning Pipeline Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/zones/:name/provision` | Start provisioning pipeline |
| `GET` | `/zones/:name/provision/status` | Get provisioning status |
| `POST` | `/zones/:name/provision/cancel` | Cancel running provisioning |
| `POST` | `/zones/:name/provision/rollback` | Rollback to @pre-provision |

### Recipe Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/provisioning/recipes` | List all recipes |
| `POST` | `/provisioning/recipes` | Create recipe |
| `GET` | `/provisioning/recipes/:id` | Get recipe details |
| `PUT` | `/provisioning/recipes/:id` | Update recipe |
| `DELETE` | `/provisioning/recipes/:id` | Delete recipe |
| `POST` | `/provisioning/recipes/:id/test` | Test recipe (dry-run) |

### Profile Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/provisioning/profiles` | List all profiles |
| `POST` | `/provisioning/profiles` | Create profile |
| `GET` | `/provisioning/profiles/:id` | Get profile details |
| `PUT` | `/provisioning/profiles/:id` | Update profile |
| `DELETE` | `/provisioning/profiles/:id` | Delete profile |

---

## Next Steps

- [Network Management Guide](network-management.md) - Setup provisioning network
- [Zone Management Guide](zone-management.md) - Zone lifecycle operations
- [Configuration Reference](../configuration.md) - Provisioning config options
- [API Documentation](/api-docs) - Full API reference
