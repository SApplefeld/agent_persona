#!/usr/bin/env node
// Health probe: exits 1 while .agentic-health-fail exists, 0 otherwise.
const fs = require('fs');
const path = require('path');

const failPath = path.join(process.cwd(), '.agentic-health-fail');
if (fs.existsSync(failPath)) {
  process.exit(1);
}
process.exit(0);
