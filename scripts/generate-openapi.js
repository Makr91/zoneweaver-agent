#!/usr/bin/env node

/**
 * @fileoverview Emit the OpenAPI spec as a plain JSON file.
 * @description Writes ./openapi.json (plain JSON) so CI can publish it as a release
 * asset. The hyperweaver-docs site fetches it live from
 * releases/latest/download/openapi.json to render the agent's Swagger UI; the agent's
 * own runtime /api-docs builds the spec from config/swagger.js directly. The spec's
 * `servers:` block (the Swagger server selector) is carried through verbatim.
 */

import fs from 'fs';
import path from 'path';
import { specs } from '../config/swagger.js';

const outPath = path.join(process.cwd(), 'openapi.json');

try {
  fs.writeFileSync(outPath, `${JSON.stringify(specs, null, 2)}\n`);
  console.log(`✅ Wrote ${path.relative(process.cwd(), outPath)}`);
} catch (error) {
  console.error('❌ Error generating OpenAPI spec:', error.message);
  process.exit(1);
}
