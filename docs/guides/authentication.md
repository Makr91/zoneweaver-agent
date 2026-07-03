---
title: Authentication
layout: default
nav_order: 2
parent: Guides
permalink: /docs/guides/authentication/
---

# Authentication Guide
{: .no_toc }

Learn how to set up and manage API keys for secure access to the Zoneweaver Agent.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Overview

The Zoneweaver Agent uses Bearer token authentication with API keys. All requests must include a valid API key in the Authorization header.

## API Key Format

Zoneweaver Agent keys use the following format:
```
wh_[random_string]
```

Example: `wh_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz`

## Getting Your First API Key

### Bootstrap Method (First Install)

On a fresh installation, use the bootstrap endpoint to generate your first API key:

```bash
curl -X POST https://your-server:5001/api-keys/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Initial Setup",
    "description": "Bootstrap API key for initial configuration"
  }'
```

**Response:**
```json
{
  "api_key": "wh_abc123def456...",
  "entity_id": 1,
  "name": "Initial Setup",
  "description": "Bootstrap API key for initial configuration",
  "message": "API key generated successfully",
  "note": "Bootstrap endpoint will be auto-disabled for future requests"
}
```

⚠️ **Important**: The bootstrap endpoint is automatically disabled after first use for security.

## Using API Keys

### In HTTP Requests

Include the API key in the Authorization header:

```bash
curl -H "Authorization: Bearer wh_your_api_key_here" \
  https://your-server:5001/stats
```

### In Frontend Applications

```javascript
const apiKey = 'wh_your_api_key_here';

fetch('https://your-server:5001/zones', {
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
})
.then(response => response.json())
.then(data => console.log(data));
```

## Managing API Keys

### Generate Additional API Keys

Once you have your first API key, you can generate additional keys:

```bash
curl -X POST https://your-server:5001/api-keys/generate \
  -H "Authorization: Bearer wh_your_existing_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Frontend Application",
    "description": "API key for the web frontend"
  }'
```

### List Existing API Keys

View all API keys (without exposing the actual key values):

```bash
curl -H "Authorization: Bearer wh_your_api_key" \
  https://your-server:5001/api-keys
```

### Get Current API Key Information

Check information about the API key you're currently using:

```bash
curl -H "Authorization: Bearer wh_your_api_key" \
  https://your-server:5001/api-keys/info
```

### Revoke API Keys

Deactivate an API key (can be reactivated later):

```bash
curl -X PUT \
  -H "Authorization: Bearer wh_your_api_key" \
  https://your-server:5001/api-keys/1/revoke
```

### Delete API Keys

Permanently delete an API key:

```bash
curl -X DELETE \
  -H "Authorization: Bearer wh_your_api_key" \
  https://your-server:5001/api-keys/1
```

## Security Best Practices

### 1. Environment Variables

Store API keys in environment variables, not in code:

```bash
export ZONEWEAVER_API_KEY="wh_your_api_key_here"
```

```javascript
const apiKey = process.env.ZONEWEAVER_API_KEY;
```

### 2. Different Keys for Different Uses

Create separate API keys for:
- Frontend applications
- Backend services  
- Development/testing
- Administrative tasks

### 3. Regular Key Rotation

Periodically regenerate API keys:
1. Generate a new key
2. Update applications to use the new key
3. Delete or revoke the old key

### 4. Monitor Key Usage

Check the `last_used` field to identify unused keys:

```bash
curl -H "Authorization: Bearer wh_your_api_key" \
  https://your-server:5001/api-keys
```

## Configuration Options

Configure API key behavior in `/etc/zoneweaver-agent/config.yaml`:

```yaml
api_keys:
  # Enable/disable bootstrap endpoint
  bootstrap_enabled: true
  
  # Auto-disable bootstrap after first use
  bootstrap_auto_disable: true
  
  # API key length (characters after wh_ prefix)
  key_length: 32
  
  # Bcrypt hash rounds for storing keys
  hash_rounds: 12
```

## Troubleshooting

### Invalid API Key Errors

**Error:** `401 Unauthorized - Invalid API key`

**Solutions:**
1. Verify the API key format includes `wh_` prefix
2. Check that the key hasn't been revoked
3. Ensure the Authorization header is properly formatted
4. Verify the key exists in the database

### Bootstrap Endpoint Disabled

**Error:** `403 Forbidden - Bootstrap endpoint disabled`

**Solutions:**
1. Use an existing API key to generate new keys
2. If no keys exist, manually enable bootstrap in config:
   ```yaml
   api_keys:
     bootstrap_enabled: true
   ```
3. Restart the service: `svcadm restart zoneweaver-agent`

### Missing Authorization Header

**Error:** `401 Unauthorized - API key required`

**Solution:** Include the Authorization header in your request:
```bash
-H "Authorization: Bearer wh_your_api_key"
