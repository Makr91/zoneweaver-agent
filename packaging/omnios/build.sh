#!/usr/bin/bash
#
# CDDL HEADER START
#
# The contents of this file are subject to the terms of the
# Common Development and Distribution License, Version 1.0 only
# (the "License").  You may not use this file except in compliance
# with the License.
#
# You can obtain a copy of the license at usr/src/OPENSOLARIS.LICENSE
# or http://www.opensolaris.org/os/licensing.
# See the License for the specific language governing permissions
# and limitations under the License.
#
# When distributing Covered Code, include this CDDL HEADER in each
# file and include the License file at usr/src/OPENSOLARIS.LICENSE.
# If applicable, add the following below this CDDL HEADER, with the
# fields enclosed by brackets "[]" replaced with your own identifying
# information: Portions Copyright [yyyy] [name of copyright owner]
#
# CDDL HEADER END
#
#
# Copyright 2025 Makr91. All rights reserved.
# Use is subject to license terms.
#

set -e

# Simple logging functions
logmsg() { echo "=== $*"; }
logcmd() { echo ">>> $*"; "$@"; }
logerr() { echo "ERROR: $*" >&2; }

# Set up variables
SRCDIR="$(pwd)"
DESTDIR="${SRCDIR}/proto"
PROG=zoneweaver-agent
VER=$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")
PKG=system/virtualization/zoneweaver-agent

# Clean and create staging directory
rm -rf "$DESTDIR"
mkdir -p "$DESTDIR"

#### Build Structure
# /opt/zoneweaver-agent/
#   # Node.js application files
#   index.js
#   package.json
#   controllers/
#   models/
#   routes/
#   middleware/
#   config/
#   lib/
#   node_modules/
#   startup.sh
# /etc/zoneweaver-agent/
#   config.yaml
# /var/lib/zoneweaver-agent/
# /var/log/zoneweaver-agent/

build_app() {
    logmsg "Building Zoneweaver Agent"
    
    # Set up environment for OmniOS/Solaris
    export MAKE=gmake
    export CC=gcc
    export CXX=g++
    
    # Install dependencies first
    MAKE=gmake logcmd npm ci
    
    # Sync versions after dependencies are installed
    if [ -f "scripts/sync-versions.js" ]; then
        logcmd node scripts/sync-versions.js
    fi
    
    # Install production dependencies only
    MAKE=gmake logcmd npm ci --omit=dev

    # Remove cpu-features: optional ssh2 native addon that fails to link on
    # illumos (fatal relocation error: GetX86Info). ssh2 degrades gracefully
    # when it is absent. npm overrides cannot disable it (no boolean support),
    # so strip it here after install.
    logcmd rm -rf node_modules/cpu-features
}

install_app() {
    pushd $DESTDIR >/dev/null

    # Create main application directory
    logcmd mkdir -p opt/zoneweaver-agent
    pushd opt/zoneweaver-agent >/dev/null

    # Copy application files
    logmsg "Installing Zoneweaver Agent application files"
    logcmd cp $SRCDIR/index.js .
    logcmd cp $SRCDIR/package.json .
    logcmd cp $SRCDIR/LICENSE.md .
    
    # Copy application directories
    for dir in controllers models routes middleware config lib db; do
        if [ -d "$SRCDIR/$dir" ]; then
            logcmd cp -r $SRCDIR/$dir .
        fi
    done
    
    # Copy node_modules (production only)
    if [ -d "$SRCDIR/node_modules" ]; then
        logcmd cp -r $SRCDIR/node_modules .
    fi
    
    # Copy SMF start method script (the stop method uses SMF's :kill token, so
    # no stop script is packaged)
    logcmd cp $SRCDIR/packaging/omnios/startup.sh .
    logcmd chmod 755 startup.sh
    
    popd >/dev/null # /opt/zoneweaver-agent

    # Install configuration
    logmsg "Installing configuration files"
    logcmd mkdir -p etc/zoneweaver-agent
    logcmd cp $SRCDIR/packaging/config/production-config.yaml etc/zoneweaver-agent/config.yaml

    # RBAC: pkg's user action cannot set profiles= (silently ignored), so the
    # Primary Administrator grant ships as a user_attr.d fragment
    logmsg "Installing user_attr fragment for zwagent RBAC profile"
    logcmd mkdir -p etc/user_attr.d
    logcmd cp $SRCDIR/packaging/omnios/zoneweaver-agent.user_attr etc/user_attr.d/zoneweaver-agent

    # Copy skeleton files to zwagent user home directory
    logmsg "Installing skeleton files for zwagent user"
    if [ -d "/etc/skel" ]; then
        # Copy each skeleton file if it exists
        for skelfile in .profile .bashrc .kshrc; do
            if [ -f "/etc/skel/$skelfile" ]; then
                logcmd cp "/etc/skel/$skelfile" "var/lib/zoneweaver-agent/" || \
                    logerr "--- copying skeleton file $skelfile failed"
            fi
        done
        logmsg "Skeleton files copied successfully"
    else
        logmsg "Warning: /etc/skel directory not found, skeleton files not installed"
    fi

    # Create empty SSL, database, and log directories (packaged content)
    # This prevents salvaging on uninstall - files within stay in place
    logcmd mkdir -p etc/zoneweaver-agent/ssl
    logcmd mkdir -p var/lib/zoneweaver-agent/database
    logcmd mkdir -p var/log/zoneweaver-agent

    # Install SMF manifest
    logmsg "Installing SMF manifest"
    logcmd mkdir -p lib/svc/manifest/system
    logcmd cp $SRCDIR/packaging/omnios/zoneweaver-agent-smf.xml lib/svc/manifest/system/zoneweaver-agent.xml

    # Install man pages in standard OOCE location
    logmsg "Installing man pages"
    logcmd mkdir -p opt/ooce/share/man/man8 opt/ooce/share/man/man5
    logcmd cp $SRCDIR/packaging/omnios/man/zoneweaver-agent.8 opt/ooce/share/man/man8/ || \
        logerr "--- copying main man page failed"
    logcmd cp $SRCDIR/packaging/omnios/man/zoneweaver-agent.yaml.5 opt/ooce/share/man/man5/ || \
        logerr "--- copying config man page failed"

    popd >/dev/null # $DESTDIR
}

install_ui() {
    # Bake the published Hyperweaver UI artifact (D4) into the package.
    # Pinned by the hyperweaverUiVersion field in package.json (same convention
    # as hyperweaver-server). Tarball root is the SPA root (index.html at top).
    UI_VERSION=$(node -p "require('./package.json').hyperweaverUiVersion || ''" 2>/dev/null)
    if [ -z "$UI_VERSION" ]; then
        logmsg "No hyperweaverUiVersion pin in package.json - skipping UI artifact"
        return 0
    fi

    logmsg "Installing Hyperweaver UI ${UI_VERSION}"
    UI_URL="https://github.com/MarkProminic/hyperweaver-ui/releases/download/v${UI_VERSION}/hyperweaver-ui-${UI_VERSION}.tar.gz"
    UI_TARBALL="${SRCDIR}/hyperweaver-ui-${UI_VERSION}.tar.gz"
    UI_DIR="${DESTDIR}/opt/zoneweaver-agent/ui"

    logcmd curl -fsSL -o "$UI_TARBALL" "$UI_URL"
    logcmd mkdir -p "$UI_DIR"
    (cd "$UI_DIR" && gunzip -c "$UI_TARBALL" | tar -xf -)
    logcmd rm -f "$UI_TARBALL"

    if [ ! -f "${UI_DIR}/index.html" ]; then
        logerr "Hyperweaver UI artifact has no index.html at root - aborting"
        exit 1
    fi
}

post_install() {
    logmsg "--- Setting up Zoneweaver Agent staging directory"

    logmsg "Zoneweaver Agent staging setup completed"
}

# Main build process
logmsg "Starting Zoneweaver Agent build process"
build_app
install_app
install_ui
post_install

# Create the complete package
logmsg "Creating IPS package"
cd "$SRCDIR"
export VERSION="$VER"
sed "s/@VERSION@/${VERSION}/g" packaging/omnios/zoneweaver-agent.p5m > zoneweaver-agent.p5m.tmp
pkgsend generate proto | pkgfmt > zoneweaver-agent.p5m.generated
pkgmogrify -DVERSION="${VERSION}" zoneweaver-agent.p5m.tmp zoneweaver-agent.p5m.generated > zoneweaver-agent.p5m.final

# Create temporary local repository
TEMP_REPO="${SRCDIR}/temp-repo"
rm -rf "$TEMP_REPO"
pkgrepo create "$TEMP_REPO"
pkgrepo set -s "$TEMP_REPO" publisher/prefix=Makr91

# Publish package to temporary repository
pkgsend -s "file://${TEMP_REPO}" publish -d proto zoneweaver-agent.p5m.final

# Create .p5p package archive
PACKAGE_FILE="zoneweaver-agent-${VERSION}.p5p"
pkgrecv -s "file://${TEMP_REPO}" -a -d "${PACKAGE_FILE}" "${PKG}"

# Clean up temporary repository
rm -rf "$TEMP_REPO"

logmsg "Package build completed: ${PACKAGE_FILE}"
logmsg "Complete package ready for upload to GitHub artifacts"

# Vim hints
# vim:ts=4:sw=4:et:
