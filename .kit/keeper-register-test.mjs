#!/usr/bin/env node
// Test for bin/Register-PersonaTasks.ps1.
// Run: node .kit/keeper-register-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Drives the real powershell.exe with spawnSync and an args array (never a -Command string
// carrying a double quote, per the node-e-through-powershell-cannot-carry-a-double-quote memory).
// The elevation, disabled, absent and -Prune cases are driven by dot-sourcing the script and
// calling Register-PersonaTasks directly, through a scratch .ps1 file written to a temp directory,
// so the args array never has to carry a hashtable or a PowerShell array literal through a shell.
//
// This session is unelevated, so every case here either never registers a task (-WhatIf) or
// throws before touching the scheduler (the elevation guard). The suite's own control proves the
// absence checks mean something: Get-ScheduledTask against a task name known to exist on this box
// (CswapAuto) returns one object, and the same read against AgentPersona-* is checked before and
// after the suite runs.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const scriptPath = join(repoRoot, 'bin', 'Register-PersonaTasks.ps1');
const fixtureRoster = join(repoRoot, '.kit', 'fixtures', 'fleet.fixture.json');

const scratchDir = mkdtempSync(join(tmpdir(), 'keeper-register-test-'));
const scratchEnvFile = join(scratchDir, 'keeper.env');

function runPowerShell(args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8',
  });
}

function countScheduledTasks(namePattern) {
  const script = join(scratchDir, 'count.ps1');
  writeFileSync(
    script,
    "param([string]$Pattern)\n" +
      "Write-Output @(Get-ScheduledTask -TaskName $Pattern -ErrorAction SilentlyContinue).Count\n",
    'utf8'
  );
  const result = runPowerShell(['-File', script, '-Pattern', namePattern]);
  return parseInt(result.stdout.trim(), 10);
}

// Splits stdout into blocks, one per "task <name>" line and its following indented field lines.
function parseTaskBlocks(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('task ')) {
      current = { taskLine: line, fields: {} };
      blocks.push(current);
    } else if (current && line.startsWith('  ')) {
      const idx = line.indexOf(':');
      const key = line.slice(2, idx).trim();
      const value = line.slice(idx + 1).trim();
      current.fields[key] = value;
    }
  }
  return { blocks, otherLines: lines.filter((l) => !l.startsWith('task ') && !l.startsWith('  ')) };
}

function assertDefinitionFields(fields, name, rosterPath, envFilePath) {
  const action = fields['action'];
  assert.ok(action.includes(`-Name ${name} `) || action.endsWith(`-Name ${name}`), `action names -Name ${name}: ${action}`);
  assert.ok(action.includes('Start-Persona.ps1'), `action names Start-Persona.ps1: ${action}`);
  assert.ok(action.includes(`"${resolve(rosterPath)}"`), `action carries the absolute roster path: ${action}`);
  assert.ok(action.includes(`"${resolve(envFilePath)}"`), `action carries the absolute env path: ${action}`);
  assert.equal(fields['trigger'], 'MSFT_TaskBootTrigger', 'trigger class');
  assert.equal(fields['logon'], 'S4U', 'logon');
  assert.equal(fields['runlevel'], 'Limited', 'runlevel');
  assert.equal(fields['restartCount'], '999', 'restartCount');
  assert.equal(fields['restartInterval'], 'PT1M', 'restartInterval');
  assert.equal(fields['executionTimeLimit'], 'PT0S', 'executionTimeLimit');
  assert.equal(fields['multipleInstances'], 'IgnoreNew', 'multipleInstances');
  assert.equal(fields['startWhenAvailable'], 'True', 'startWhenAvailable');
  assert.equal(fields['allowStartIfOnBatteries'], 'True', 'allowStartIfOnBatteries');
  assert.equal(fields['dontStopIfGoingOnBatteries'], 'True', 'dontStopIfGoingOnBatteries');
}

let pass = 0;
let fail = 0;
function record(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + name + ': ' + e.message);
    fail++;
  }
}

// Control: the instrument reads the scheduler and returns a nonzero count for a task known to
// exist on this box, before it is trusted to return zero for AgentPersona-*.
const cswapCount = countScheduledTasks('CswapAuto');
record('control: Get-ScheduledTask finds the known CswapAuto task', () => {
  assert.equal(cswapCount, 1, 'CswapAuto count');
});

const beforeCount = countScheduledTasks('AgentPersona-*');
record('baseline: no AgentPersona-* task exists before the suite runs', () => {
  assert.equal(beforeCount, 0, 'AgentPersona-* count before');
});

// Case 1: real -WhatIf run against the fixture roster.
{
  const result = runPowerShell([
    '-File', scriptPath,
    '-Roster', fixtureRoster,
    '-EnvFile', scratchEnvFile,
    '-RepoRoot', repoRoot,
    '-WhatIf',
  ]);
  record('case 1: -WhatIf exits 0', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
  });
  const { blocks, otherLines } = parseTaskBlocks(result.stdout);
  record('case 1: prints exactly two task blocks (alpha, beta)', () => {
    assert.equal(blocks.length, 2, 'block count');
    assert.equal(blocks[0].taskLine, 'task AgentPersona-alpha');
    assert.equal(blocks[1].taskLine, 'task AgentPersona-beta');
  });
  record('case 1: alpha block carries all twelve fields at the expected values', () => {
    assertDefinitionFields(blocks[0].fields, 'alpha', fixtureRoster, scratchEnvFile);
  });
  record('case 1: beta block carries all twelve fields at the expected values', () => {
    assertDefinitionFields(blocks[1].fields, 'beta', fixtureRoster, scratchEnvFile);
  });
  record('case 1: prints one "no task for disabled entry gamma" line', () => {
    assert.deepEqual(otherLines, ['no task for disabled entry gamma']);
  });
}

// Case 2: the real script run without -WhatIf from this unelevated session.
{
  const result = runPowerShell([
    '-File', scriptPath,
    '-Roster', fixtureRoster,
    '-EnvFile', scratchEnvFile,
    '-RepoRoot', repoRoot,
  ]);
  record('case 2: exits 1 unelevated without -WhatIf', () => {
    assert.equal(result.status, 1, 'exit code');
  });
  record('case 2: stderr names the elevation requirement', () => {
    // powershell.exe wraps Write-Error text at its console width when the host is redirected, so
    // the match runs against whitespace-collapsed stderr rather than a literal phrase.
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(
      /elevated PowerShell session/.test(collapsed),
      'stderr: ' + result.stderr
    );
  });
  record('case 2: prints no task block', () => {
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
}

// Cases 3 and 4: dot-source the script and call Register-PersonaTasks directly, through a scratch
// .ps1 file, so the elevation state and the existing-task list are injected with no scheduler read
// and no shell-quoted PowerShell array literal.
function runFunctionCase(prune) {
  const caseScript = join(scratchDir, `functions-${prune ? 'prune' : 'noprune'}.ps1`);
  const pruneFlag = prune ? '-Prune' : '';
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @(',
    '    [pscustomobject]@{name="alpha";enabled=$true},',
    '    [pscustomobject]@{name="gamma";enabled=$false}',
    ')',
    'Write-Output "=== THROW_CASE ==="',
    'try {',
    `    Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "D:/x.json" -EnvFile "D:/y.env" -User "u" -IsElevated $false`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
    'Write-Output "=== WHATIF_CASE ==="',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "D:/x.json" -EnvFile "D:/y.env" -User "u" -IsElevated $true -WhatIf ${pruneFlag} -ExistingTaskNames @("AgentPersona-gamma","AgentPersona-zeta")`,
  ];
  writeFileSync(caseScript, lines.join('\n'), 'utf8');
  return runPowerShell(['-File', caseScript]);
}

{
  const result = runFunctionCase(false);
  record('case 3: exits 0', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
  });
  const stdout = result.stdout;
  record('case 3: -IsElevated $false throws naming elevation', () => {
    const collapsed = stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*elevated PowerShell session/.test(collapsed), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf prints the alpha task block', () => {
    assert.ok(stdout.includes('task AgentPersona-alpha'), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf reports "disable AgentPersona-gamma"', () => {
    assert.ok(stdout.includes('disable AgentPersona-gamma'), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf reports the zeta orphan left in place', () => {
    assert.ok(
      stdout.includes('orphan AgentPersona-zeta: left in place; pass -Prune to unregister'),
      'stdout: ' + stdout
    );
  });
  record('case 3: registers, updates and unregisters nothing', () => {
    assert.ok(!/registered|updated|unregistered/.test(stdout), 'stdout: ' + stdout);
  });
}

// Case 4: same as case 3, but with -Prune, still under -WhatIf.
{
  const result = runFunctionCase(true);
  record('case 4: exits 0', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
  });
  const stdout = result.stdout;
  record('case 4: -Prune -WhatIf reports the zeta orphan as would-unregister', () => {
    assert.ok(
      stdout.includes('orphan AgentPersona-zeta: would unregister under -Prune'),
      'stdout: ' + stdout
    );
  });
  record('case 4: -Prune -WhatIf still registers, updates and unregisters nothing', () => {
    assert.ok(!/registered|updated|unregistered/.test(stdout), 'stdout: ' + stdout);
  });
}

// Case 5: an unknown flag exits 1 ([CmdletBinding()] turns it into a binding error).
{
  const result = runPowerShell(['-File', scriptPath, '-Bogus']);
  record('case 5: an unknown flag exits 1', () => {
    assert.equal(result.status, 1, 'exit code');
  });
}

// Extension beyond the section's Tests floor: the hostile-boundary guards the brief's Error and
// delete semantics section requires (a roster name outside letters, digits, underscore and hyphen,
// and a path carrying a double quote) are security-relevant and get their own durable pin, since a
// roster name reaches a scheduled task's command line as an unquoted argument.
{
  const badNameRoster = join(scratchDir, 'bad-name.json');
  writeFileSync(badNameRoster, JSON.stringify([{ name: 'al pha"&calc', workdir: 'x', permissionMode: 'y', enabled: true }]), 'utf8');
  const result = runPowerShell(['-File', scriptPath, '-Roster', badNameRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster name outside the safe character class is refused', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(collapsed.includes(badNameRoster), 'stderr names the roster path: ' + result.stderr);
  });
}

{
  const quotedEnvFile = join(scratchDir, 'quo"ted.env');
  const result = runPowerShell(['-File', scriptPath, '-Roster', fixtureRoster, '-EnvFile', quotedEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a path carrying a double quote is refused rather than reaching the action string', () => {
    assert.equal(result.status, 1, 'exit code');
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
}

const afterCount = countScheduledTasks('AgentPersona-*');
record('no AgentPersona-* task was left behind by the suite', () => {
  assert.equal(afterCount, 0, 'AgentPersona-* count after');
});

rmSync(scratchDir, { recursive: true, force: true });

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
