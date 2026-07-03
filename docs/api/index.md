---
title: API Reference
layout: default
nav_order: 2
has_children: false
permalink: /docs/api/
---

# API Reference
{: .no_toc }

The Zoneweaver Agent provides comprehensive RESTful endpoints for managing Bhyve virtual machines, networking, storage, and system monitoring on OmniOS/illumos systems.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Authentication

All API endpoints require authentication using API keys in the Bearer token format:

```http
Authorization: Bearer wh_your_api_key_here
```

See the [Authentication Guide](../guides/authentication/) for detailed setup instructions.

## Base URL

The API is served from your Zoneweaver Agent server:

- **HTTPS (Recommended)**: `https://your-server:5001`
- **HTTP**: `http://your-server:5000`

## OpenAPI Specification

The Zoneweaver Agent is fully documented using OpenAPI 3.0 specification.

### Interactive Documentation

- **[Live API Reference](swagger-ui.html)** - Complete interactive API documentation with examples and testing capabilities
- **[OpenAPI JSON](openapi.json)** - Raw OpenAPI specification for tools and integrations

### API Categories

The Zoneweaver Agent is organized into the following categories:

#### Zone Management
- Zone lifecycle management (create, start, stop, delete, restart)
- Zone configuration and properties
- Zone modification (add/remove disks, NICs, CD-ROMs)
- Boot environment management
- **Zone provisioning pipeline** (automated configuration, file sync, provisioner execution)

#### Network Management
- VLAN configuration and management
- VNIC (Virtual Network Interface) management
- Etherstub management
- Network bridge configuration
- **NAT rules and IP forwarding** (network address translation, routing)
- **DHCP server management** (subnet config, static host entries, service control)
- **Provisioning network setup** (isolated network for zone setup)

#### Storage Management
- ZFS dataset management
- ZFS pool management and monitoring
- Swap area management
- Artifact management (provisioning file uploads)

#### Console Access
- VNC console sessions
- Terminal/SSH sessions (zlogin)
- **Zlogin automation** (recipe-based serial console automation)
- WebSocket connections for real-time access

#### Provisioning System
- **Recipe management** (zlogin automation templates for OS-specific network setup)
- **Provisioning profiles** (reusable provisioning configurations)
- **Provisioning orchestration** (complete pipeline: extract → boot → setup → sync → execute)
- **Tool installation** (automatic setup of rsync, ansible, dhcpd, git)

#### System Monitoring
- Host system metrics and statistics
- Network usage and performance monitoring
- Storage I/O and capacity monitoring
- CPU and memory statistics

#### Template Management
- Vagrant box import from BoxVault registries
- Template storage and versioning
- ZFS clone strategies (thin clone vs full copy)

#### API Management
- API key generation and management
- Bootstrap configuration
- Entity management

---

## Rate Limiting

The API currently does not implement rate limiting, but this may be added in future versions for production deployments.

## Error Handling

The API uses standard HTTP status codes and returns JSON error responses:

```json
{
  "msg": "Error description"
}
```

Common status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized (Invalid API key)
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

## Pagination

Paginated endpoints support the following query parameters:
- `limit` - Number of items per page (default: 50)
- `offset` - Number of items to skip

## WebSocket Endpoints

Real-time features use WebSocket connections:
- `/term/{sessionId}` - Terminal sessions
- `/zlogin/{sessionId}` - Zone login sessions
- `/zones/{zoneName}/vnc/websockify` - VNC console access
