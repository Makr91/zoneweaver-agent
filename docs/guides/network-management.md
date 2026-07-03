---
layout: default
title: Network Management
parent: Guides
nav_order: 4
---

# Network Management Guide
{: .no_toc }

Comprehensive guide to managing network infrastructure for zones in zoneweaver-agent.
{: .fs-6 .fw-300 }

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

Zoneweaver-api provides comprehensive network management capabilities to support zone networking, including:

- **Etherstubs & VNICs** — Virtual network infrastructure (already documented in [VNIC Management](vnics.md))
- **NAT & IP Forwarding** — Network Address Translation and routing for zone internet access
- **DHCP Server** — Automatic IP assignment for zones on provisioning networks
- **Provisioning Network** — Dedicated isolated network for zone setup and configuration

This guide focuses on the **NAT, DHCP, and provisioning network** features introduced in Phase 2.

---

## Why Network Management?

### The Problem

When creating zones in an isolated environment:

1. **No external connectivity** — Zones on etherstubs can't reach the internet or physical network
2. **Manual IP configuration** — Without DHCP, every zone needs manual network setup
3. **Complex routing** — Host may not be on same VLAN as guest zones
4. **Provisioning challenges** — Zones need network access during initial setup (SSH, package downloads)

### The Solution

Zoneweaver-api's network management provides:

- **NAT rules** — Translate private zone IPs to host's public IP
- **IP forwarding** — Route traffic between zone networks and physical interfaces
- **DHCP server** — Automatic IP assignment with static MAC→IP mappings
- **Provisioning network** — One-command setup of complete isolated network infrastructure

---

## Network Architecture

### Typical Provisioning Network Setup

```
┌─────────────────────────────────────────────────────────────┐
│ OmniOS Host (hv-04)                                         │
│                                                              │
│  ┌──────────────┐         ┌─────────────────────────────┐  │
│  │ Physical NIC │         │ Provisioning Etherstub      │  │
│  │   (igb0)     │         │   (estub_provision)         │  │
│  │ 192.168.1.10 │         │                             │  │
│  └──────┬───────┘         └──────────┬──────────────────┘  │
│         │                            │                      │
│         │   NAT + IP Forwarding      │                      │
│         │   ◄────────────────────►   │                      │
│         │                            │                      │
│         │                   ┌────────┴────────┐             │
│         │                   │ Host VNIC       │             │
│         │                   │ provision_      │             │
│         │                   │ interconnect0   │             │
│         │                   │ 10.190.190.1/24 │             │
│         │                   └────────┬────────┘             │
│         │                            │                      │
│         │                   DHCP Server Listening           │
│         │                   Range: 10.190.190.10-.254       │
│         │                            │                      │
│         │              ┌─────────────┼─────────────┐        │
│         │              │             │             │        │
│  ┌──────┴──────┐   ┌───┴────┐   ┌───┴────┐   ┌───┴────┐   │
│  │ Zone 1      │   │ Zone 2 │   │ Zone 3 │   │ Zone N │   │
│  │ web-01      │   │ db-01  │   │ app-01 │   │ ...    │   │
│  │             │   │        │   │        │   │        │   │
│  │ vnic:       │   │ vnic:  │   │ vnic:  │   │ vnic:  │   │
│  │ zone1_prov0 │   │ zone2_ │   │ zone3_ │   │ zoneN_ │   │
│  │             │   │ prov0  │   │ prov0  │   │ prov0  │   │
│  │ IP: DHCP    │   │ IP:    │   │ IP:    │   │ IP:    │   │
│  │ 10.190.     │   │ 10.190.│   │ 10.190.│   │ 10.190.│   │
│  │ 190.10      │   │ 190.11 │   │ 190.12 │   │ 190.xx │   │
│  └─────────────┘   └────────┘   └────────┘   └────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘

Traffic Flow:
1. Zone sends packet to internet (e.g., 8.8.8.8)
2. Zone's default gateway: 10.190.190.1 (host VNIC)
3. Host forwards to physical NIC (igb0) with IP forwarding enabled
4. NAT rule translates source IP: 10.190.190.10 → 192.168.1.10
5. Response returns, NAT translates back, host forwards to zone
```

---

## NAT & IP Forwarding

### Understanding NAT

**Network Address Translation (NAT)** allows zones on private networks (e.g., 10.190.190.0/24) to access external networks using the host's public IP.

**When to use NAT:**
- Zones need internet access for package downloads
- Multiple zones share one public IP
- Zones are on isolated etherstubs without direct routing

**OmniOS NAT implementation:**
- Uses **ipfilter** (`/etc/ipf/ipnat.conf`)
- Managed via **ipnat** command
- Service: `svc:/network/ipfilter:default`

### NAT Rule Types

| Type | Purpose | Example |
|------|---------|---------|
| `map` (portmap) | NAT with automatic port mapping | `map igb0 10.190.190.0/24 -> 0/32 portmap tcp/udp auto` |
| `bimap` | Bidirectional NAT (1:1 mapping) | `bimap igb0 10.190.190.10 -> 192.168.1.100` |
| `rdr` | Port redirection (port forwarding) | `rdr igb0 192.168.1.10 port 8080 -> 10.190.190.10 port 80` |

**Most common for provisioning:** `map` with portmap auto.

### List NAT Rules

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/network/nat/rules \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "rules": [
    {
      "rule_id": 0,
      "rule": "map igb0 10.190.190.0/24 -> 0/32 portmap tcp/udp auto",
      "type": "map",
      "interface": "igb0",
      "subnet": "10.190.190.0/24"
    }
  ],
  "ipfilter_enabled": true,
  "config_path": "/etc/ipf/ipnat.conf"
}
```

### Create NAT Rule

```bash
curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/network/nat/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "bridge": "igb0",
    "subnet": "10.190.190.0/24",
    "target": "0/32",
    "protocol": "tcp/udp",
    "type": "portmap"
  }'
```

**Parameters:**
- `bridge` (required) — Physical interface (e.g., `igb0`, `e1000g0`)
- `subnet` (required) — Private subnet to NAT (e.g., `10.190.190.0/24`)
- `target` (optional) — Target address (default: `0/32` = any)
- `protocol` (optional) — Protocols to NAT (default: `tcp/udp`)
- `type` (optional) — NAT type (default: `portmap`)

**What happens:**
1. Rule appended to `/etc/ipf/ipnat.conf`
2. ipfilter service refreshed
3. NAT immediately active

### Delete NAT Rule

```bash
curl -s -X DELETE https://hv-04-backend.home.m4kr.net:5001/network/nat/rules/0 \
  -H "Authorization: Bearer {api_key}"
```

Rules are indexed by line number (0-based). Get current rule IDs via `GET /network/nat/rules`.

### IP Forwarding

**IP forwarding** allows the host to route packets between interfaces (e.g., etherstub ↔ physical NIC).

**Without IP forwarding enabled:** Zones can't reach beyond their local subnet, even with NAT rules.

#### Check Forwarding Status

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/network/forwarding \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "global_ipv4_forwarding": "enabled",
  "interfaces": [
    {
      "name": "igb0",
      "ipv4_forwarding": "on"
    },
    {
      "name": "provision_interconnect0",
      "ipv4_forwarding": "on"
    }
  ]
}
```

#### Enable IP Forwarding

```bash
curl -s -X PUT https://hv-04-backend.home.m4kr.net:5001/network/forwarding \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "enabled": true,
    "interfaces": ["igb0", "provision_interconnect0"]
  }'
```

**Parameters:**
- `enabled` (optional) — Global IPv4 forwarding (true/false)
- `interfaces` (optional) — Array of interface names to enable forwarding on

**What happens:**
1. Global: `pfexec routeadm -u -e ipv4-forwarding`
2. Per-interface: `pfexec ipadm set-ifprop -p forwarding=on -m ipv4 {iface}`
3. Changes take effect immediately

---

## DHCP Server Management

### Understanding DHCP

**Dynamic Host Configuration Protocol (DHCP)** automatically assigns IP addresses to zones when they boot.

**Why use DHCP for zones:**
- No manual network configuration inside zones
- Centralized IP management on host
- Static MAC→IP mappings for predictable addressing
- Works with zlogin automation (recipes don't need to know the IP in advance)

**OmniOS DHCP implementation:**
- Uses **isc-dhcp-server** (dhcpd)
- Config: `/etc/dhcpd.conf`
- Service: `svc:/network/dhcp/server:ipv4`

### DHCP Configuration

#### Get Current Config

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/network/dhcp/config \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "config": {
    "subnet": "10.190.190.0",
    "netmask": "255.255.255.0",
    "router": "10.190.190.1",
    "range_start": "10.190.190.10",
    "range_end": "10.190.190.254",
    "dns": "8.8.8.8,8.8.4.4",
    "listen_interface": "provision_interconnect0"
  },
  "service_enabled": true,
  "config_path": "/etc/dhcpd.conf"
}
```

#### Update DHCP Config

```bash
curl -s -X PUT https://hv-04-backend.home.m4kr.net:5001/network/dhcp/config \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "subnet": "10.190.190.0",
    "netmask": "255.255.255.0",
    "router": "10.190.190.1",
    "range_start": "10.190.190.10",
    "range_end": "10.190.190.254",
    "dns": "8.8.8.8,8.8.4.4",
    "listen_interface": "provision_interconnect0"
  }'
```

**Parameters:**
- `subnet` (required) — Network address (e.g., `10.190.190.0`)
- `netmask` (required) — Subnet mask (e.g., `255.255.255.0`)
- `router` (required) — Default gateway for DHCP clients (e.g., `10.190.190.1`)
- `range_start` (required) — Start of dynamic IP range
- `range_end` (required) — End of dynamic IP range
- `dns` (optional) — DNS servers (comma-separated)
- `listen_interface` (optional) — VNIC to listen on

**What happens:**
1. Current `/etc/dhcpd.conf` read to preserve host entries
2. New subnet config written
3. Host entries appended back
4. Listen interface set via SMF property
5. DHCP service refreshed

### Static Host Entries

**Static host entries** map MAC addresses to fixed IPs (DHCP reservations).

#### List Host Entries

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/network/dhcp/hosts \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "hosts": [
    {
      "hostname": "web-01",
      "mac": "02:08:20:ab:cd:01",
      "ip": "10.190.190.10"
    },
    {
      "hostname": "db-01",
      "mac": "02:08:20:ab:cd:02",
      "ip": "10.190.190.11"
    }
  ],
  "config_path": "/etc/dhcpd.conf"
}
```

#### Add Host Entry

```bash
curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/network/dhcp/hosts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "hostname": "web-01",
    "mac": "02:08:20:ab:cd:01",
    "ip": "10.190.190.10"
  }'
```

**Parameters:**
- `hostname` (required) — Unique hostname identifier
- `mac` (required) — MAC address (format: `xx:xx:xx:xx:xx:xx`)
- `ip` (required) — Fixed IP address (must be within subnet)

**What happens:**
1. Check for duplicate hostname
2. Append host block to `/etc/dhcpd.conf`:
   ```
   host web-01 {
     hardware ethernet 02:08:20:ab:cd:01;
     fixed-address 10.190.190.10;
   }
   ```
3. DHCP service refreshed

#### Remove Host Entry

```bash
curl -s -X DELETE https://hv-04-backend.home.m4kr.net:5001/network/dhcp/hosts/web-01 \
  -H "Authorization: Bearer {api_key}"
```

### DHCP Service Control

#### Get Service Status

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/network/dhcp/status \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "service": "dhcp/server:ipv4",
  "state": "online",
  "enabled": true
}
```

#### Control Service

```bash
curl -s -X PUT https://hv-04-backend.home.m4kr.net:5001/network/dhcp/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{"action": "refresh"}'
```

**Actions:**
- `start` — Enable DHCP service
- `stop` — Disable DHCP service
- `refresh` — Reload configuration
- `restart` — Stop then start

---

## Provisioning Network Setup

### What Is the Provisioning Network?

The **provisioning network** is a complete isolated network infrastructure created specifically for zone setup and configuration. It includes:

1. **Etherstub** — Virtual switch backbone
2. **Host VNIC** — Host-side network interface with static IP
3. **NAT rule** — Internet access for zones
4. **IP forwarding** — Routing between etherstub and physical NIC
5. **DHCP server** — Automatic IP assignment

This is the network that zones connect to during the provisioning pipeline.

### One-Command Setup

```bash
curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/provisioning/network/setup \
  -H "Authorization: Bearer {api_key}"
```

**What happens (idempotent — safe to run multiple times):**

1. **Create etherstub** — `estub_provision` (if doesn't exist)
2. **Create host VNIC** — `provision_interconnect0` on etherstub (if doesn't exist)
3. **Assign IP** — `10.190.190.1/24` on host VNIC (if doesn't exist)
4. **Detect physical NIC** — Find active interface (e.g., `igb0`)
5. **Create NAT rule** — Map provisioning subnet to physical NIC (if doesn't exist)
6. **Enable IP forwarding** — On physical NIC and host VNIC (if not enabled)
7. **Configure DHCP** — Subnet config + start service (if not configured)

**Response:**
```json
{
  "success": true,
  "message": "Provisioning network setup completed",
  "components": {
    "etherstub": "estub_provision",
    "host_vnic": "provision_interconnect0",
    "host_ip": "10.190.190.1/24",
    "physical_interface": "igb0",
    "nat_rule": "map igb0 10.190.190.0/24 -> 0/32 portmap tcp/udp auto",
    "dhcp_subnet": "10.190.190.0/24",
    "dhcp_range": "10.190.190.10 - 10.190.190.254"
  }
}
```

### Check Status

```bash
curl -s https://hv-04-backend.home.m4kr.net:5001/provisioning/network/status \
  -H "Authorization: Bearer {api_key}"
```

**Response:**
```json
{
  "success": true,
  "configured": true,
  "components": {
    "etherstub": {
      "name": "estub_provision",
      "exists": true
    },
    "host_vnic": {
      "name": "provision_interconnect0",
      "exists": true,
      "ip": "10.190.190.1/24"
    },
    "nat": {
      "configured": true,
      "rule": "map igb0 10.190.190.0/24 -> 0/32 portmap tcp/udp auto"
    },
    "dhcp": {
      "configured": true,
      "service_enabled": true,
      "subnet": "10.190.190.0/24"
    },
    "forwarding": {
      "global_enabled": true,
      "interfaces": ["igb0", "provision_interconnect0"]
    }
  }
}
```

### Teardown

```bash
curl -s -X DELETE https://hv-04-backend.home.m4kr.net:5001/provisioning/network/teardown \
  -H "Authorization: Bearer {api_key}"
```

**What happens:**
1. Stop DHCP service
2. Remove NAT rule
3. Delete host VNIC IP address
4. Delete host VNIC
5. Delete etherstub

**Warning:** This will disrupt any zones currently using the provisioning network. Only teardown when no zones are provisioning.

---

## Configuration

Provisioning network settings are defined in `config.yaml`:

```yaml
provisioning:
  network:
    enabled: true
    etherstub_name: "estub_provision"
    host_vnic_name: "provision_interconnect0"
    subnet: "10.190.190.0/24"
    host_ip: "10.190.190.1"
    dhcp_range_start: "10.190.190.10"
    dhcp_range_end: "10.190.190.254"
```

**Customization:**
- Change `subnet` if `10.190.190.0/24` conflicts with existing networks
- Adjust `dhcp_range_start`/`dhcp_range_end` to reserve static IPs
- Modify `etherstub_name` and `host_vnic_name` if needed (must update zones too)

---

## Integration with Zone Provisioning

### How Zones Connect

During the provisioning pipeline (`POST /zones/{name}/provision`):

1. **Temporary NIC added** — Zone gets a VNIC on `estub_provision`
2. **DHCP assignment** — Zone boots, requests IP, DHCP assigns from pool
3. **Network configuration** — Zlogin recipe configures network inside zone (if needed)
4. **SSH access** — Host can reach zone via assigned IP
5. **Provisioning completes** — Files synced, provisioners run
6. **NIC removal (optional)** — Provisioning NIC removed, zone switches to production network

### Adding Provisioning NIC to Zone

This is done automatically by `POST /zones/{name}/provision`, but you can do it manually:

```bash
curl -s -X PUT https://hv-04-backend.home.m4kr.net:5001/zones/web-01 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "add_nics": [
      {
        "physical": "web01_prov0",
        "global_nic": "estub_provision"
      }
    ]
  }'
```

The zone's VNIC will auto-create on the etherstub. When zone boots, DHCP assigns an IP.

---

## Troubleshooting

### NAT Not Working

**Symptom:** Zones can't reach internet despite NAT rule configured.

**Check:**
1. Verify NAT rule exists:
   ```bash
   curl -s https://hv-04-backend.home.m4kr.net:5001/network/nat/rules \
     -H "Authorization: Bearer {api_key}"
   ```

2. Verify IP forwarding enabled:
   ```bash
   curl -s https://hv-04-backend.home.m4kr.net:5001/network/forwarding \
     -H "Authorization: Bearer {api_key}"
   ```

3. Check ipfilter service:
   ```bash
   # On host
   pfexec svcs network/ipfilter
   # Should show: online
   ```

4. Verify NAT rule in config:
   ```bash
   # On host
   cat /etc/ipf/ipnat.conf
   ```

5. Test from zone:
   ```bash
   # Inside zone
   ping 8.8.8.8
   traceroute 8.8.8.8
   ```

**Fix:**
```bash
# Manually refresh ipfilter
pfexec svcadm refresh network/ipfilter
pfexec svcadm disable network/ipfilter
pfexec svcadm enable network/ipfilter
```

### DHCP Not Assigning IPs

**Symptom:** Zone boots but doesn't get an IP via DHCP.

**Check:**
1. Verify DHCP service running:
   ```bash
   curl -s https://hv-04-backend.home.m4kr.net:5001/network/dhcp/status \
     -H "Authorization: Bearer {api_key}"
   ```

2. Check DHCP config:
   ```bash
   # On host
   cat /etc/dhcpd.conf
   ```

3. Verify listen interface:
   ```bash
   # On host
   pfexec svccfg -s dhcp/server:ipv4 listprop config/listen_ifnames
   # Should show: provision_interconnect0
   ```

4. Check DHCP logs:
   ```bash
   # On host
   tail -f /var/log/dhcpd.log
   # (If logging enabled)
   ```

5. Test DHCP from zone:
   ```bash
   # Inside zone (Linux)
   dhclient -v eth0
   ```

**Fix:**
```bash
# Restart DHCP service
curl -s -X PUT https://hv-04-backend.home.m4kr.net:5001/network/dhcp/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{"action": "restart"}'
```

### Provisioning Network Setup Fails

**Symptom:** `POST /provisioning/network/setup` returns errors.

**Common causes:**
1. **Etherstub name conflict** — Another etherstub with same name exists
2. **IP conflict** — `10.190.190.1` already assigned elsewhere
3. **DHCP already running** — Another DHCP server on same interface
4. **Permission issues** — API running without pfexec privileges

**Check system state:**
```bash
# List etherstubs
dladm show-etherstub

# List VNICs
dladm show-vnic

# List IP addresses
ipadm show-addr

# Check DHCP service
svcs dhcp/server:ipv4
```

**Fix:**
- If components partially exist, run teardown then setup again:
  ```bash
  curl -s -X DELETE https://hv-04-backend.home.m4kr.net:5001/provisioning/network/teardown \
    -H "Authorization: Bearer {api_key}"

  curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/provisioning/network/setup \
    -H "Authorization: Bearer {api_key}"
  ```

### Zones Can't Reach Host Services

**Symptom:** Zones can ping internet but can't reach services on host (e.g., NFS, artifact server).

**Cause:** Firewall or routing issue.

**Check:**
1. Test connectivity from zone:
   ```bash
   # Inside zone
   ping 10.190.190.1  # Host's provisioning IP
   curl http://10.190.190.1:5001/health  # API health check
   ```

2. Check host firewall (if ipfilter used for filtering, not just NAT):
   ```bash
   # On host
   pfexec ipfstat -io
   ```

3. Verify host is listening on provisioning IP:
   ```bash
   # On host
   netstat -an | grep 10.190.190.1
   ```

**Fix:**
- If zoneweaver-agent needs to be accessible from zones, ensure it binds to `0.0.0.0` or `10.190.190.1`, not just `127.0.0.1`
- Add ipfilter pass rules if packet filtering is enabled (separate from NAT)

---

## Best Practices

### Network Segmentation

1. **Separate production from provisioning** — Use different VLANs/etherstubs for production zones vs. provisioning
2. **Dedicated provisioning subnet** — Keep `10.190.190.0/24` only for setup, move zones to production networks after provisioning
3. **Firewall between networks** — Use ipfilter to restrict provisioning network access (e.g., block zone-to-zone traffic during setup)

### DHCP Management

1. **Reserve IP ranges** — Keep lower IPs (e.g., .2-.9) for static assignment, start DHCP pool at .10
2. **Static mappings for important zones** — Use DHCP host entries for zones that need predictable IPs
3. **Document MAC addresses** — Keep a record of which zone has which MAC (zoneweaver-agent auto-generates, but track them)

### NAT Rules

1. **Single NAT rule for provisioning** — One `map` rule covers entire provisioning subnet
2. **Avoid overlapping rules** — Each subnet should have only one NAT rule
3. **Use specific interfaces** — Specify exact physical interface (e.g., `igb0`), not wildcards

### Performance

1. **MTU considerations** — Ensure consistent MTU across etherstubs, VNICs, and physical interfaces (default 1500 is usually fine)
2. **NIC offloading** — For high-throughput zones, consider physical VNIC placement and NIC queues
3. **DHCP lease times** — Provisioning is short-lived, use short lease times (e.g., 1 hour) to quickly reclaim IPs

### Security

1. **Isolate provisioning network** — Don't route production traffic through provisioning etherstub
2. **No persistent provisioning NICs** — Remove provisioning NICs after setup completes
3. **DHCP snooping** — Consider additional security if untrusted zones exist (OmniOS doesn't have built-in DHCP snooping, but can use ipfilter)
4. **Change default subnet** — If `10.190.190.0/24` is too predictable, use a custom RFC1918 range

---

## Advanced Topics

### Multiple Provisioning Networks

For complex environments (e.g., tenant isolation), create multiple provisioning networks:

1. Create additional etherstubs:
   ```bash
   curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/network/etherstubs \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer {api_key}" \
     -d '{"name": "estub_provision_tenant2"}'
   ```

2. Create host VNICs with different subnets:
   ```bash
   # 10.190.191.0/24 for tenant 2
   ```

3. Configure separate DHCP instances (requires manual SMF configuration)

4. Add separate NAT rules per subnet

### Port Forwarding (rdr rules)

Expose zone services to external networks:

```bash
curl -s -X POST https://hv-04-backend.home.m4kr.net:5001/network/nat/rules \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {api_key}" \
  -d '{
    "type": "rdr",
    "bridge": "igb0",
    "external_ip": "192.168.1.10",
    "external_port": 8080,
    "internal_ip": "10.190.190.10",
    "internal_port": 80,
    "protocol": "tcp"
  }'
```

This forwards external requests to `192.168.1.10:8080` → zone `10.190.190.10:80`.

### Monitoring Network Usage

Track bandwidth and connections:

```bash
# On host - monitor etherstub traffic
dladm show-link -s estub_provision

# Per-VNIC statistics
dladm show-link -s provision_interconnect0

# Zone VNIC statistics
dladm show-link -s web01_prov0
```

For detailed packet inspection, use `snoop`:

```bash
# Capture traffic on provisioning interconnect
pfexec snoop -d provision_interconnect0 -o /tmp/capture.pcap

# Filter DHCP traffic
pfexec snoop -d provision_interconnect0 port 67 or port 68
```

---

## API Reference Summary

### NAT & Forwarding

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/network/nat/rules` | GET | List NAT rules |
| `/network/nat/rules` | POST | Create NAT rule |
| `/network/nat/rules/:ruleId` | DELETE | Delete NAT rule |
| `/network/nat/status` | GET | ipfilter service status |
| `/network/forwarding` | GET | IP forwarding status |
| `/network/forwarding` | PUT | Configure IP forwarding |

### DHCP

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/network/dhcp/config` | GET | Get DHCP configuration |
| `/network/dhcp/config` | PUT | Update DHCP configuration |
| `/network/dhcp/hosts` | GET | List static host entries |
| `/network/dhcp/hosts` | POST | Add host entry |
| `/network/dhcp/hosts/:hostname` | DELETE | Remove host entry |
| `/network/dhcp/status` | GET | DHCP service status |
| `/network/dhcp/status` | PUT | Control DHCP service |

### Provisioning Network

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/provisioning/network/status` | GET | Check provisioning network |
| `/provisioning/network/setup` | POST | Setup provisioning network |
| `/provisioning/network/teardown` | DELETE | Remove provisioning network |

For detailed API schemas and examples, see the [API Documentation](../api/index.md) and Swagger UI at `/api-docs`.

---

## Related Documentation

- [Provisioning Pipeline Guide](provisioning.md) — Complete provisioning workflow
- [VNIC Management](vnics.md) — Creating and managing VNICs
- [Zone Management](zone-management.md) — Zone creation, lifecycle, and provisioning
- [Configuration Reference](../configuration.md) — Network and provisioning settings

---

## Summary

Zoneweaver-api's network management provides:

✅ **One-command setup** — `POST /provisioning/network/setup` creates complete infrastructure
✅ **Automatic IP assignment** — DHCP with static MAC→IP mappings
✅ **Internet access** — NAT with portmap for zone outbound connectivity
✅ **Isolated networking** — Etherstub-based provisioning network separate from production
✅ **OmniOS native** — Uses ipfilter, routeadm, ipadm, and isc-dhcp

This network infrastructure enables the automated zone provisioning pipeline, providing the connectivity needed for zlogin automation, SSH access, file sync, and provisioner execution.
