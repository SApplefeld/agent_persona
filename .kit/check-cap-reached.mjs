#!/usr/bin/env node
// Check if cost_cap_reached is in the decisions log.
import { readFileSync } from 'fs';

try {
  const s = JSON.parse(readFileSync('.agentic-personas.json', 'utf8'));
  const p = Object.keys(s)[0];
  const d = (s[p].decisions || []).filter(x => x.action === 'cost_cap_reached');
  process.exit(d.length > 0 ? 0 : 1);
} catch (e) {
  process.exit(1);
}
