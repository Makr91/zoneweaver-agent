# Zoneweaver Agent - OmniOS Package

This directory contains the files needed to build an OmniOS IPS package for the Zoneweaver Agent.

## Package Information

- **Package Name**: `system/virtualization/zoneweaver-agent`
- **Service Name**: `system/virtualization/zoneweaver-agent`
- **User/Group**: `zwagent` (UID/GID: 301)
- **Installation Path**: `/opt/zoneweaver-agent`
- **Configuration**: `/etc/zoneweaver-agent`
- **Data Directory**: `/var/lib/zoneweaver-agent` (also user home directory)
- **Log Directory**: `/var/log/zoneweaver-agent`

## Package Contents

### Build Files
- `build.sh` - Main build script that creates the IPS package
- `zoneweaver-agent.p5m` - IPS package manifest
- `local.mog` - Package transformation rules

### SMF Service Files
- `zoneweaver-agent-smf.xml` - SMF service manifest (stop method uses SMF's `:kill` token)
- `startup.sh` - Service startup script
- `post-install.sh` - Post-installation setup script

### Configuration
- `../config/production-config.yaml` - Production configuration template

## Dependencies

- **Node.js**: `ooce/runtime/node-22`
- **SQLite**: `database/sqlite-3`
- **OpenSSL**: For SSL certificate generation (optional)

## Installation

### From Package Repository
```bash
pkg install system/virtualization/zoneweaver-agent
```

### Manual Installation
```bash
# Install the .p5p package file
pkg install -g zoneweaver-agent-x.x.x.p5p system/virtualization/zoneweaver-agent
```

### Enable and Start Service
```bash
# Enable the service
svcadm enable system/virtualization/zoneweaver-agent

# Check service status
svcs system/virtualization/zoneweaver-agent

# View service logs
tail -f /var/log/zoneweaver-agent/application.log
```

## Configuration

The service uses configuration file at `/etc/zoneweaver-agent/config.yaml`. This file is preserved during package updates.

### SSL Certificates

SSL certificates are automatically generated during first startup if they don't exist:
- **Private Key**: `/etc/zoneweaver-agent/ssl/server.key`
- **Certificate**: `/etc/zoneweaver-agent/ssl/server.crt`

### Database

The SQLite database is stored at:
- **Database**: `/var/lib/zoneweaver-agent/database/database.sqlite`

### User Account and Shell Environment

The `zwagent` user is created with the following shell initialization files in its home directory (`/var/lib/zoneweaver-agent`):
- **`.profile`** - POSIX shell initialization (copied from `/etc/skel/.profile`)
- **`.bashrc`** - Bash-specific initialization (copied from `/etc/skel/.bashrc`)
- **`.kshrc`** - Korn shell initialization (copied from `/etc/skel/.kshrc`)

These files ensure that interactive shell sessions and shell scripts run as the `zwagent` user have proper environment setup including PATH configuration for OmniOS/OOCE tools.

## API Access

Once running, the API will be available at:
- **HTTP**: `http://localhost:5000`
- **HTTPS**: `https://localhost:5001`
- **API Documentation**: `https://localhost:5001/api-docs`

## Service Management

### SMF Commands
```bash
# Start service
svcadm enable system/virtualization/zoneweaver-agent

# Stop service
svcadm disable system/virtualization/zoneweaver-agent

# Restart service
svcadm restart system/virtualization/zoneweaver-agent

# Refresh configuration
svcadm refresh system/virtualization/zoneweaver-agent

# View service status
svcs -l system/virtualization/zoneweaver-agent
```

### Log Files
- **Service Log**: `/var/log/zoneweaver-agent/application.log`
- **SMF Log**: `/var/svc/log/system-virtualization-zoneweaver-agent:default.log`

## Build Process

The package is built automatically via GitHub Actions when a new release is created. The build process:

1. Syncs version numbers across all configuration files
2. Installs Node.js dependencies (production only)
3. Copies application files to staging area
4. Creates IPS package with proper permissions and ownership
5. Uploads package to GitHub releases
6. Publishes to package repository

## Troubleshooting

### Service Won't Start
1. Check SMF service status: `svcs -xv system/virtualization/zoneweaver-agent`
2. Check service logs: `tail -f /var/svc/log/system-virtualization-zoneweaver-agent:default.log`
3. Check application logs: `tail -f /var/log/zoneweaver-agent/application.log`
4. Verify configuration: `/etc/zoneweaver-agent/config.yaml`

### SSL Certificate Issues
1. Check certificate files exist: `ls -la /etc/zoneweaver-agent/ssl/`
2. Check file ownership: `ls -la /etc/zoneweaver-agent/ssl/`
3. Regenerate certificates: `rm /etc/zoneweaver-agent/ssl/*.{key,crt}` and restart service

### Database Issues
1. Check database directory exists: `/var/lib/zoneweaver-agent/database/`
2. Check file ownership: `chown -R zoneweaver-agent:zoneweaver-agent /var/lib/zoneweaver-agent`
3. Check database file permissions

## Package Updates

Configuration files are preserved during package updates. The service will automatically restart after package installation.

## Uninstallation

```bash
# Stop and disable service
svcadm disable system/virtualization/zoneweaver-agent

# Remove package
pkg uninstall system/virtualization/zoneweaver-agent

# Optional: Clean up data (WARNING: This removes all data!)
rm -rf /var/lib/zoneweaver-agent
rm -rf /var/log/zoneweaver-agent
```

## Support

For support and documentation, visit:
- **GitHub**: https://github.com/Makr91/zoneweaver-agent
- **Issues**: https://github.com/Makr91/zoneweaver-agent/issues
