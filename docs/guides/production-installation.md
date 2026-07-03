---
title: Production Installation
layout: default
nav_order: 2
parent: Guides
permalink: /docs/guides/production-installation/
---

# Production Installation
{: .no_toc }

Complete guide for installing Zoneweaver Agent in production using the OmniOS package.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## System Requirements

### OmniOS Host Requirements
- **Operating System**: OmniOS (Latest stable release recommended)
- **Architecture**: x86_64
- **Memory**: Minimum 512MB RAM, 2GB+ recommended for production workloads
- **Storage**: 1GB+ free space for application and database
- **Network**: HTTP/HTTPS connectivity for package installation and API access

### Dependencies
The following packages are automatically installed as dependencies:
- **Node.js**: `ooce/runtime/node-22`
- **SQLite**: `database/sqlite-3`
- **GCC 14**: `developer/gcc-14` (for bcrypt native module compilation)
- **GNU Make**: `developer/build/gnu-make`
- **OpenSSL**: For SSL certificate generation

---

## Quick Installation

### 1. Configure Package Repository

Add the Zoneweaverpackage repository:

```bash
# Add the repository
pfexec pkg set-publisher -g https://public.omnios.packages.startcloud.com startcloud

# Update package catalog
pfexec pkg refresh
```

### 2. Install Zoneweaver Agent Package

```bash
# Install the package
pfexec pkg install system/virtualization/zoneweaver-agent
```

The installation will:
- Create the `zwagent` system user and group
- Install application files to `/opt/zoneweaver-agent`
- Set up configuration directory at `/etc/zoneweaver-agent`
- Create data directory at `/var/lib/zoneweaver-agent`
- Configure SMF service `application/zoneweaver-agent`

### 3. Enable and Start the Service

```bash
# Enable the service (starts automatically at boot)
pfexec svcadm enable application/zoneweaver-agent

# Check service status
svcs application/zoneweaver-agent
```

Expected output:
```
STATE          STIME    FMRI
online         12:34:56 svc:/application/zoneweaver-agent:default
```

---

## Configuration

### Default Configuration

The service uses `/etc/zoneweaver-agent/config.yaml` for configuration. The default production configuration includes:

```yaml
server:
  http_port: 5000
  https_port: 5001

ssl:
  key_path: "/etc/zoneweaver-agent/ssl/server.key"
  cert_path: "/etc/zoneweaver-agent/ssl/server.crt"

database:
  dialect: "sqlite"
  storage: "/var/lib/zoneweaver-agent/database/database.sqlite"

api_keys:
  bootstrap_enabled: true
  bootstrap_auto_disable: true
```

### SSL Certificates

**SSL certificates are automatically generated on first startup** if they don't exist:
- **Private Key**: `/etc/zoneweaver-agent/ssl/server.key`
- **Certificate**: `/etc/zoneweaver-agent/ssl/server.crt`

**Optional: Custom SSL certificates** (only needed if you want to use your own certificates):
```bash
# Copy your certificates
pfexec cp your-server.key /etc/zoneweaver-agent/ssl/server.key
pfexec cp your-server.crt /etc/zoneweaver-agent/ssl/server.crt

# Set proper ownership
pfexec chown zwagent:zwagent /etc/zoneweaver-agent/ssl/*
pfexec chmod 600 /etc/zoneweaver-agent/ssl/server.key
pfexec chmod 644 /etc/zoneweaver-agent/ssl/server.crt

# Restart service to use new certificates
pfexec svcadm restart application/zoneweaver-agent
```

**Note**: If you set `generate_ssl: false` in the configuration, you must provide your own SSL certificates.

---

## Initial Setup

### 1. Generate Bootstrap API Key

After installation, generate your first API key:

```bash
curl -X POST http://localhost:5000/api-keys/bootstrap \
     -H "Content-Type: application/json" \
     -d '{"name": "Production-Setup"}'
```

Example response:
```json
{
  "api_key": "wh_1234567890abcdef...",
  "name": "Production-Setup",
  "created_at": "2025-01-15T12:00:00.000Z"
}
```

**Important**: Save this API key securely - it cannot be retrieved later. The bootstrap endpoint will automatically disable after first use.

### 2. Test API Access

Verify the API is working:

```bash
# Test HTTP endpoint
curl -H "Authorization: Bearer wh_your_api_key_here" \
     http://localhost:5000/api/entities

# Test HTTPS endpoint  
curl -k -H "Authorization: Bearer wh_your_api_key_here" \
     https://localhost:5001/api/entities
```

### 3. Access API Documentation

The interactive Swagger documentation is available at:
- **HTTPS**: https://localhost:5001/api-docs (Recommended)
- **HTTP**: http://localhost:5000/api-docs

---

## Service Management

### SMF Service Commands

```bash
# Check service status
svcs application/zoneweaver-agent

# View detailed service information
svcs -l application/zoneweaver-agent

# Start service
pfexec svcadm enable application/zoneweaver-agent

# Stop service
pfexec svcadm disable application/zoneweaver-agent

# Restart service
pfexec svcadm restart application/zoneweaver-agent

# Refresh configuration
pfexec svcadm refresh application/zoneweaver-agent
```

### Log Files

- **Application Log**: `/var/log/zoneweaver-agent/application.log`
- **SMF Service Log**: `/var/svc/log/application-zoneweaver-agent:default.log`

```bash
# Monitor application logs
tail -f /var/log/zoneweaver-agent/application.log

# Monitor service logs
tail -f /var/svc/log/application-zoneweaver-agent:default.log
```

---

## Security Configuration

### Production Security Checklist

- [ ] **Change default ports** if needed in `/etc/zoneweaver-agent/config.yaml`
- [ ] **Configure CORS whitelist** for your frontend domains
- [ ] **Set up proper SSL certificates** for production use
- [ ] **Disable bootstrap endpoint** after initial setup
- [ ] **Configure firewall rules** to restrict access
- [ ] **Set up log rotation** for long-term operations

### CORS Configuration

Edit `/etc/zoneweaver-agent/config.yaml`:

```yaml
cors:
  whitelist:
    - "https://your-zoneweaver-frontend.domain.com"
    - "https://your-management-interface.domain.com"
```

### Firewall Configuration

```bash
# Allow Zoneweaver Agent ports
pfexec /usr/sbin/svccfg -s network/firewall setprop 'policy/custom_rules' = astring: '{ "direction":"in", "protocol":"tcp", "port":5000, "action":"accept" }'
pfexec /usr/sbin/svccfg -s network/firewall setprop 'policy/custom_rules' = astring: '{ "direction":"in", "protocol":"tcp", "port":5001, "action":"accept" }'
pfexec svcadm refresh network/firewall
```

---

## Updates and Maintenance

### Package Updates

```bash
# Check for updates
pfexec pkg list -u system/virtualization/zoneweaver-agent

# Update to latest version
pfexec pkg update system/virtualization/zoneweaver-agent
```

Package updates automatically:
- Preserve configuration files
- Restart the service
- Maintain database integrity

### Database Backup

```bash
# Create database backup
pfexec cp /var/lib/zoneweaver-agent/database/database.sqlite \
         /var/lib/zoneweaver-agent/database/database.sqlite.backup.$(date +%Y%m%d)

# Automated daily backup (add to cron)
echo "0 2 * * * root cp /var/lib/zoneweaver-agent/database/database.sqlite /var/lib/zoneweaver-agent/database/database.sqlite.backup.\$(date +\%Y\%m\%d)" >> /etc/crontab
```

### Log Rotation

The package includes automatic log rotation. Configuration is in `/etc/logadm.conf`:

```bash
# View log rotation settings
grep zoneweaver-agent /etc/logadm.conf
```

---

## Troubleshooting

### Service Won't Start

1. **Check service status**:
   ```bash
   svcs -xv application/zoneweaver-agent
   ```

2. **Check SMF logs**:
   ```bash
   tail -f /var/svc/log/application-zoneweaver-agent:default.log
   ```

3. **Check application logs**:
   ```bash
   tail -f /var/log/zoneweaver-agent/application.log
   ```

### Common Issues

#### SSL Certificate Problems
```bash
# Check certificate files
ls -la /etc/zoneweaver-agent/ssl/

# Regenerate certificates (removes existing ones)
pfexec rm /etc/zoneweaver-agent/ssl/*.{key,crt}
pfexec svcadm restart application/zoneweaver-agent
```

#### Database Permission Issues
```bash
# Fix database directory permissions
pfexec chown -R zwagent:zwagent /var/lib/zoneweaver-agent
pfexec chmod -R 755 /var/lib/zoneweaver-agent
pfexec svcadm restart application/zoneweaver-agent
```

#### Configuration Issues
```bash
# Validate configuration syntax
pfexec -u zwagent /opt/zoneweaver-agent/node_modules/.bin/node -c /etc/zoneweaver-agent/config.yaml
```

### Support and Documentation

- **GitHub Issues**: [https://github.com/Makr91/zoneweaver-agent/issues](https://github.com/Makr91/zoneweaver-agent/issues)
- **API Documentation**: Available at your server's `/api-docs` endpoint
- **Configuration Reference**: [Configuration Guide](../reference/configuration/)

---

## Uninstallation

**Warning**: This will permanently remove all Zoneweaver Agent data.

```bash
# Stop and disable service
pfexec svcadm disable application/zoneweaver-agent

# Remove package
pfexec pkg uninstall system/virtualization/zoneweaver-agent

# Optional: Remove data directories (WARNING: All data will be lost!)
pfexec rm -rf /var/lib/zoneweaver-agent
pfexec rm -rf /var/log/zoneweaver-agent
pfexec rm -rf /etc/zoneweaver-agent
