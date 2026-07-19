#!/bin/bash
#
# Zoneweaver Agent startup script for SMF
#

set -e

# Environment is set by SMF, but ensure we have the basics
# node-22 MUST outrank /opt/ooce/bin — a co-installed node-24 owns the
# generic symlink there and its ABI breaks the shipped native modules
export PATH="/opt/ooce/node-22/bin:/opt/ooce/bin:/usr/gnu/bin:/usr/bin:/usr/sbin:/sbin"
export NODE_ENV="${NODE_ENV:-production}"
export CONFIG_PATH="${CONFIG_PATH:-/etc/zoneweaver-agent/config.yaml}"
export HOME="${HOME:-/var/lib/zoneweaver-agent}"
# bcrypt and node-sqlite3 share the libuv threadpool (default 4 threads);
# widen it so auth hashing never starves database IO
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}"

cd /opt/zoneweaver-agent

PIDFILE="/var/lib/zoneweaver-agent/zoneweaver-agent.pid"

# Create runtime directories following IPS best practices
# These are unpackaged content - preserved across package operations
mkdir -p /var/lib/zoneweaver-agent/database
mkdir -p /etc/zoneweaver-agent/ssl

# Set proper ownership for runtime directories
chown -R zwagent:zwagent /var/lib/zoneweaver-agent
chown -R zwagent:zwagent /etc/zoneweaver-agent/ssl

# Set proper permissions for SSL directory (more restrictive)
chmod 700 /etc/zoneweaver-agent/ssl

# Check if Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js not found in PATH" >&2
    exit 1
fi

# Check if main application file exists
if [ ! -f "/opt/zoneweaver-agent/index.js" ]; then
    echo "Error: Zoneweaver Agent application not found at /opt/zoneweaver-agent/index.js" >&2
    exit 1
fi

# Check if configuration file exists
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Error: Configuration file not found at $CONFIG_PATH" >&2
    exit 1
fi

# Remove stale PID file if it exists
if [ -f "$PIDFILE" ]; then
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Removing stale PID file $PIDFILE"
        rm -f "$PIDFILE"
    else
        echo "Error: Zoneweaver Agent appears to be already running (PID $(cat "$PIDFILE"))" >&2
        exit 1
    fi
fi

echo "Starting Zoneweaver Agent..."
echo "Node.js version: $(node --version)"
echo "Configuration: $CONFIG_PATH"
echo "Environment: $NODE_ENV"

# Start the Node.js application in the background
# Output goes to log file so we can see SSL generation messages
nohup node index.js </dev/null >>/var/log/zoneweaver-agent/application.log 2>&1 &
NODE_PID=$!

# Save the PID
echo $NODE_PID > "$PIDFILE"

# Give it a moment to start and check if it's still running
sleep 2
if ! kill -0 $NODE_PID 2>/dev/null; then
    echo "Error: Zoneweaver Agent failed to start" >&2
    rm -f "$PIDFILE"
    exit 1
fi

echo "Zoneweaver Agent started successfully with PID $NODE_PID"
echo "Log output will be available via SMF logging"
echo "Access the API at https://localhost:5001"

exit 0
