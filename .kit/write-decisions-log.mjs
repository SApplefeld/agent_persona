#!/usr/bin/env node
// Write decisions log from the persona store.
import { readFileSync, writeFileSync } from 'fs';

try {
  const s = JSON.parse(readFileSync('.agentic-personas.json', 'utf8'));
  const p = Object.keys(s)[0];
  const d = (s[p].decisions || []).map(x =>
    new Date(x.timestamp).toISOString().slice(11, 19) + ' ' +
    x.loop + ' | ' + x.action + ' | ' + x.detail
  );
  writeFileSync('cost.decisions.log', d.join('\n') + '\n');
} catch (e) {
  console.error('Failed to write decisions log:', e.message);
  process.exit(1);
}
