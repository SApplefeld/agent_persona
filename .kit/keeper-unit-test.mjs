#!/usr/bin/env node
// Unit test for the process keeper: bin/keeper-functions.ps1 (the pure functions) and
// bin/Start-Persona.ps1 (the wrapper a scheduled task runs).
// Run: node .kit/keeper-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure. Prints one line per case.
//
// Every case drives the real powershell.exe (Windows PowerShell 5.1, the engine the task names)
// with an argument array and -File, never a -Command string. The supervisor is a stub: a .cmd
// that runs a bash script through the real Git bash, which pops one planned exit code per run
// from a codes file, prints a marker to stdout and a line to stderr, and echoes the environment
// the case wants read back. All scratch state lives under one temp directory removed at the end.

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const functionsPath = path.join(repoRoot, 'bin', 'keeper-functions.ps1');
const wrapperPath = path.join(repoRoot, 'bin', 'Start-Persona.ps1');
const supervisorPath = (repoRoot + '/bin/supervise.sh').replace(/\\/g, '/');
const bashExe = 'C:/Program Files/Git/bin/bash.exe';
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const authenticatedUsersSid = 'S-1-5-11';
const authenticatedUsersName = 'NT AUTHORITY\\Authenticated Users';

for (const p of [functionsPath, wrapperPath, bashExe]) {
  if (!fs.existsSync(p)) {
    console.error('FAIL: missing ' + p);
    process.exit(1);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-unit-'));
const fwd = (p) => p.replace(/\\/g, '/');
let driverCount = 0;
let scenarioCount = 0;

// The environment the wrapper is spawned with: the test's own, minus anything a case reads back,
// so a value that reaches the stub came from the env file or the roster and nowhere else.
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['KEEPER_BASH_EXE', 'KEEPER_SECRET', 'MODEL', 'EFFORT', 'controllerTickMs', 'COORDINATOR_PERSONA', 'APPDATA_PROBE']) delete env[k];
  return { ...env, ...extra };
}

function runPs(fileArgs, env) {
  return spawnSync('powershell.exe', [...psArgs, '-File', ...fileArgs], { encoding: 'utf8', env: env || childEnv() });
}

// Runs a PowerShell body after dot-sourcing the functions file; the body writes JSON to stdout.
function runFunctions(body) {
  const file = path.join(tmp, 'driver-' + (++driverCount) + '.ps1');
  const text = [
    "$ErrorActionPreference = 'Stop'",
    ". '" + functionsPath + "'",
    body,
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  const r = runPs([file]);
  if (r.status !== 0) throw new Error('driver exited ' + r.status + ': ' + r.stderr);
  return JSON.parse(r.stdout.trim());
}

// A scenario is one scratch persona: roster, env file, stub, codes file and work directory.
function makeScenario({ codes, entry = {}, envLines, envDir }) {
  const dir = path.join(tmp, 'sc' + (++scenarioCount));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const codesFile = path.join(dir, 'codes.txt');
  fs.writeFileSync(codesFile, codes.map(String).join('\n') + '\n');
  const stubSh = path.join(dir, 'stub.sh');
  fs.writeFileSync(stubSh, [
    '#!/bin/bash',
    'codes="' + fwd(codesFile) + '"',
    'code=$(head -n1 "$codes")',
    'tail -n +2 "$codes" > "$codes.tmp" && mv "$codes.tmp" "$codes"',
    'echo "STUB_ARGS=$*"',
    'echo "STUB_APPDATA=$APPDATA"',
    'echo "STUB_USERPROFILE=$USERPROFILE"',
    'echo "STUB_KEEPER_SECRET=${KEEPER_SECRET-<unset>}"',
    'echo "STUB_MODEL=${MODEL-<unset>}"',
    'echo "STUB_LOGIN_SHELL=$(shopt -q login_shell && echo yes || echo no)"',
    'echo "STUB_STDERR code=$code" >&2',
    'exit ${code:-130}',
    '',
  ].join('\n'));
  const stubCmd = path.join(dir, 'stub.cmd');
  fs.writeFileSync(stubCmd, '@echo off\r\n"' + bashExe.replace(/\//g, '\\') + '" "' + stubSh + '" %*\r\nexit /b %ERRORLEVEL%\r\n');
  const roster = path.join(dir, 'fleet.json');
  const full = { name: 'alpha', workdir: fwd(work), permissionMode: 'bypassPermissions', enabled: true, ...entry };
  fs.writeFileSync(roster, JSON.stringify([full, { name: 'off', workdir: fwd(work), permissionMode: 'acceptEdits', enabled: false }], null, 2));
  const envFileDir = envDir ? path.join(dir, envDir) : dir;
  fs.mkdirSync(envFileDir, { recursive: true });
  const envFile = path.join(envFileDir, 'keeper.env');
  const lines = envLines || ['# scratch keeper env', 'KEEPER_BASH_EXE=' + fwd(stubCmd)];
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
  const runDir = full.rundir ? full.rundir : path.join(work, 'run');
  return {
    dir, work, codesFile, stubCmd, roster, envFile, runDir,
    log: path.join(runDir, 'keeper.log'),
    state: path.join(runDir, 'keeper.json'),
    out: path.join(runDir, 'supervisor.out'),
    hold: path.join(runDir, 'keeper.hold'),
  };
}

function runWrapper(sc, extra = [], env) {
  return runPs([wrapperPath, '-Name', 'alpha', '-Roster', sc.roster, '-EnvFile', sc.envFile, '-DelayScale', '0.0001', ...extra], env);
}

function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function logLines(sc) {
  return readText(sc.log).split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.replace(/^\S+ /, ''));
}

function decideLines(sc) {
  return logLines(sc).filter((l) => l.startsWith('DECIDE ')).map((l) => {
    const m = /^DECIDE exit=(-?\d+) uptime=(\d+) action=(\w+) delay=(\d+) reason=(.*)$/.exec(l);
    assert.ok(m, 'DECIDE line has the contract shape: ' + l);
    return { exit: Number(m[1]), uptime: Number(m[2]), action: m[3], delay: Number(m[4]), reason: m[5] };
  });
}

function assertNoBom(p) {
  const bytes = fs.readFileSync(p);
  assert.ok(bytes.length > 0, p + ' is not empty');
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), p + ' has no UTF-8 BOM');
  assert.ok(!(bytes[0] === 0xff && bytes[1] === 0xfe), p + ' is not UTF-16');
}

function icacls(args) {
  const r = spawnSync('icacls', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('icacls ' + args.join(' ') + ' exited ' + r.status + ': ' + r.stdout + r.stderr);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + name + ': ' + e.message);
    fail++;
  }
}

// ---------------------------------------------------------------------------------------------
// Get-KeeperDecision: the policy table, both directions for every row, the ladder, the cap, the
// reset on uptime. One powershell spawn evaluates every case.
// ---------------------------------------------------------------------------------------------
const decisionCases = [
  { name: 'exit 0 holds (row 0)', in: [0, 5, 300, 0], action: 'hold' },
  { name: 'exit 0 holds even after a long run', in: [0, 7200, 4800, 0], action: 'hold' },
  { name: 'exit 1 first short run relaunches after 300', in: [1, 5, 300, 0], action: 'relaunch', delay: 300, nextExit1: 1 },
  { name: 'exit 1 second short run relaunches, count 2', in: [1, 5, 300, 1], action: 'relaunch', delay: 300, nextExit1: 2 },
  { name: 'exit 1 third short run holds', in: [1, 59, 300, 2], action: 'hold', nextExit1: 3 },
  { name: 'exit 1 at 60 seconds breaks the chain and relaunches', in: [1, 60, 300, 2], action: 'relaunch', delay: 300, nextExit1: 0 },
  { name: 'exit 1 leaves the crash ladder where it stands', in: [1, 5, 1200, 0], action: 'relaunch', delay: 300, next: 1200 },
  { name: 'exit 2 relaunches after 300 with the ladder unchanged', in: [2, 5, 1200, 0], action: 'relaunch', delay: 300, next: 1200, nextExit1: 0 },
  { name: 'exit 3 relaunches after the current delay and doubles it', in: [3, 5, 300, 0], action: 'relaunch', delay: 300, next: 600 },
  { name: 'exit 4 doubles 600 to 1200', in: [4, 5, 600, 0], action: 'relaunch', delay: 600, next: 1200 },
  { name: 'exit 5 doubles 7200 to the 14400 cap', in: [5, 5, 7200, 0], action: 'relaunch', delay: 7200, next: 14400 },
  { name: 'unknown exit 99 stays at the cap', in: [99, 5, 14400, 0], action: 'relaunch', delay: 14400, next: 14400 },
  { name: 'exit 3 after 3600 seconds resets the ladder to 300', in: [3, 3600, 9600, 0], action: 'relaunch', delay: 300, next: 600 },
  { name: 'exit 3 after 3599 seconds does not reset', in: [3, 3599, 9600, 0], action: 'relaunch', delay: 9600, next: 14400 },
  { name: 'exit 3 resets the exit-1 count', in: [3, 5, 300, 2], action: 'relaunch', nextExit1: 0 },
  { name: 'exit 130 exits without relaunching', in: [130, 5, 300, 0], action: 'exit', delay: 0 },
  { name: 'exit 143 exits without relaunching', in: [143, 5, 300, 0], action: 'exit', delay: 0 },
  { name: 'a previous delay below the base is raised to the base', in: [3, 5, 0, 0], action: 'relaunch', delay: 300, next: 600 },
];
{
  const casesFile = path.join(tmp, 'decision-cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(decisionCases.map((c) => c.in)));
  let results;
  try {
    results = runFunctions([
      "$cases = Get-Content -LiteralPath '" + casesFile + "' -Raw | ConvertFrom-Json",
      '$out = @()',
      'foreach ($c in $cases) {',
      '  $d = Get-KeeperDecision -ExitCode $c[0] -UptimeSeconds $c[1] -PreviousDelaySeconds $c[2] -ConsecutiveExit1Count $c[3]',
      '  $out += [pscustomobject]$d',
      '}',
      'ConvertTo-Json -InputObject $out -Compress -Depth 3',
    ].join('\n'));
  } catch (e) {
    console.error('FAIL: decision driver: ' + e.message);
    fail++;
    results = [];
  }
  decisionCases.forEach((c, i) => {
    test('decision: ' + c.name, () => {
      const r = results[i];
      assert.ok(r, 'result present');
      assert.equal(r.Action, c.action, 'action');
      if (c.delay !== undefined) assert.equal(r.DelaySeconds, c.delay, 'delay');
      if (c.next !== undefined) assert.equal(r.NextDelaySeconds, c.next, 'next delay');
      if (c.nextExit1 !== undefined) assert.equal(r.NextExit1Count, c.nextExit1, 'next exit-1 count');
      assert.ok(typeof r.Reason === 'string' && r.Reason.length > 0 && !/[\r\n]/.test(r.Reason), 'reason is one line');
      if (c.action === 'hold') assert.equal(r.DelaySeconds, 0, 'a hold never carries a relaunch delay');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Read-KeeperRoster and Build-SupervisorInvocation.
// ---------------------------------------------------------------------------------------------
const rosterFile = path.join(tmp, 'roster.json');
fs.writeFileSync(rosterFile, JSON.stringify([
  { name: 'full', workdir: 'D:/scratch/full work', permissionMode: 'bypassPermissions', rundir: 'D:/scratch/full/run', channelName: 'chan-full', model: 'opus', effort: 'high', controllerTickMs: 60000, coordinatorPersona: 'coordinator', args: ['--no-channel', '--dev'], enabled: true },
  { name: 'minimal', workdir: 'D:/scratch/minimal', permissionMode: 'acceptEdits', enabled: true },
  { name: 'prompted', workdir: 'D:/scratch/p', permissionMode: 'acceptEdits', args: ['--prompt', 'hello'], enabled: true },
  { name: 'prompted-eq', workdir: 'D:/scratch/p', permissionMode: 'acceptEdits', args: ['--prompt=hello'], enabled: true },
  { name: 'noworkdir', permissionMode: 'acceptEdits', enabled: true },
  { name: 'disabled', workdir: 'D:/scratch/d', permissionMode: 'acceptEdits', enabled: false },
]));

function rosterCall(body) {
  return runFunctions('try {\n' + body + '\n} catch { ConvertTo-Json -InputObject @{ error = $_.Exception.Message } -Compress }');
}
const rosterPs = "'" + rosterFile + "'";

test('roster: an enabled entry is returned by name', () => {
  const r = rosterCall("ConvertTo-Json -InputObject (Read-KeeperRoster -Path " + rosterPs + " -Name 'minimal') -Compress");
  assert.equal(r.name, 'minimal');
  assert.equal(r.workdir, 'D:/scratch/minimal');
});
test('roster: a missing name throws naming the roster path and the name', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'nosuch'");
  assert.ok(r.error, 'threw');
  assert.ok(r.error.includes(rosterFile) && r.error.includes("'nosuch'"), r.error);
});
test('roster: a disabled entry throws naming the roster path and the name', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'disabled'");
  assert.ok(r.error, 'threw');
  assert.ok(r.error.includes(rosterFile) && r.error.includes("'disabled'") && r.error.includes('not enabled'), r.error);
});
test('roster: an unreadable roster file throws naming the path and the name', () => {
  const r = rosterCall("Read-KeeperRoster -Path '" + path.join(tmp, 'absent.json') + "' -Name 'alpha'");
  assert.ok(r.error && r.error.includes('absent.json') && r.error.includes("'alpha'"), r.error);
});

function build(name) {
  return rosterCall("$e = Read-KeeperRoster -Path " + rosterPs + " -Name '" + name + "'\nConvertTo-Json -InputObject (Build-SupervisorInvocation -Entry $e -RosterPath " + rosterPs + ") -Compress -Depth 4");
}
test('build: a full entry maps every roster field in the supervisor argument order', () => {
  const r = build('full');
  assert.deepEqual(r.Arguments, ['D:/scratch/full work', 'full', 'bypassPermissions', '--rundir', 'D:/scratch/full/run', '--channel-name', 'chan-full', '--no-channel', '--dev']);
  assert.deepEqual(r.Environment, { MODEL: 'opus', EFFORT: 'high', controllerTickMs: '60000', COORDINATOR_PERSONA: 'coordinator' });
});
test('build: a minimal entry yields the three positional arguments and an empty environment', () => {
  const r = build('minimal');
  assert.deepEqual(r.Arguments, ['D:/scratch/minimal', 'minimal', 'acceptEdits']);
  assert.deepEqual(r.Environment, {});
});
test('build: --prompt in args throws naming the roster path', () => {
  const r = build('prompted');
  assert.ok(r.error && r.error.includes(rosterFile) && r.error.includes('--prompt'), JSON.stringify(r));
});
test('build: --prompt=value in args throws naming the roster path', () => {
  const r = build('prompted-eq');
  assert.ok(r.error && r.error.includes(rosterFile) && r.error.includes('--prompt'), JSON.stringify(r));
});
test('build: a missing required field throws naming the roster path and the field', () => {
  const r = build('noworkdir');
  assert.ok(r.error && r.error.includes(rosterFile) && r.error.includes("'workdir'"), JSON.stringify(r));
});

// ---------------------------------------------------------------------------------------------
// The allowlist and Read-KeeperEnvFile, from the single list in keeper-functions.ps1.
// ---------------------------------------------------------------------------------------------
test('allowlist: the single list carries exactly the eight keys the Approach names', () => {
  const r = runFunctions('ConvertTo-Json -InputObject @($script:KeeperEnvAllowlist) -Compress');
  assert.deepEqual([...r].sort(), ['APPDATA', 'HOME', 'KEEPER_BASH_EXE', 'KEEPER_PATH_PREPEND', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE']);
  assert.ok(!r.includes('KEEPER_SECRET') && !r.includes('PATH'), 'keys outside the list are absent');
});
test('envfile: comments, blank lines, first-= split, trimmed key and duplicates', () => {
  const f = path.join(tmp, 'read.env');
  fs.writeFileSync(f, ['# comment', '', '  HOME = C:/h', 'KEEPER_PATH_PREPEND=a=b;c', 'novalue', '=nokey', 'HOME=C:/second', ''].join('\n'));
  const r = runFunctions("$r = Read-KeeperEnvFile -Path '" + f + "'\nConvertTo-Json -InputObject @{ Values = $r.Values; Duplicates = @($r.Duplicates) } -Compress -Depth 3");
  assert.deepEqual(r.Values, { HOME: 'C:/second', KEEPER_PATH_PREPEND: 'a=b;c' });
  assert.deepEqual(r.Duplicates, ['HOME']);
});
test('envfile: a missing file throws naming the path', () => {
  const f = path.join(tmp, 'absent.env');
  const r = rosterCall("Read-KeeperEnvFile -Path '" + f + "'");
  assert.ok(r.error && r.error.includes('absent.env'), JSON.stringify(r));
});

// ---------------------------------------------------------------------------------------------
// The file-writers predicate: clean accepted, foreign DACL writer refused, foreign owner refused
// (driven through -OwnerSid, since an unelevated test cannot re-own a file), and the directory
// reading counting DeleteSubdirectoriesAndFiles.
// ---------------------------------------------------------------------------------------------
const aclDir = path.join(tmp, 'acl');
fs.mkdirSync(aclDir);
const cleanFile = path.join(aclDir, 'clean.env');
fs.writeFileSync(cleanFile, 'KEEPER_BASH_EXE=x\n');
const foreignFile = path.join(aclDir, 'foreign.env');
fs.writeFileSync(foreignFile, 'KEEPER_BASH_EXE=x\n');
icacls([foreignFile, '/grant', '*' + authenticatedUsersSid + ':(M)']);
const dcDir = path.join(aclDir, 'dc');
fs.mkdirSync(dcDir);
icacls([dcDir, '/grant', '*' + authenticatedUsersSid + ':(DC)']);
const rxDir = path.join(aclDir, 'rx');
fs.mkdirSync(rxDir);
icacls([rxDir, '/grant', '*' + authenticatedUsersSid + ':(RX)']);

function foreignWriters(file, ownerSid) {
  const extra = ownerSid ? " -OwnerSid '" + ownerSid + "'" : '';
  return runFunctions("ConvertTo-Json -InputObject @{ v = [string](Get-ForeignWriters -Path '" + file + "'" + extra + ") } -Compress").v;
}
test('writers: a file granting only the exempt SIDs has no foreign writer', () => {
  assert.equal(foreignWriters(cleanFile), '');
});
test('writers: a file with an Authenticated Users Modify grant names that principal', () => {
  assert.equal(foreignWriters(foreignFile), authenticatedUsersName);
});
test('writers: a clean DACL with an owner outside the exempt set names owner:<sid>', () => {
  assert.equal(foreignWriters(cleanFile, authenticatedUsersSid), 'owner:' + authenticatedUsersSid);
});
test('writers: an owner inside the exempt set (SYSTEM) is not foreign', () => {
  assert.equal(foreignWriters(cleanFile, 'S-1-5-18'), '');
});
test('writers: DeleteSubdirectoriesAndFiles on a directory counts as a write right', () => {
  const r = runFunctions("ConvertTo-Json -InputObject @{ v = [string](Get-FileWriters -Path '" + dcDir + "') } -Compress").v;
  assert.ok(r.split(';').includes(authenticatedUsersName), r);
});
test('writers: a read-only grant on a directory is not a write right (control)', () => {
  const r = runFunctions("ConvertTo-Json -InputObject @{ v = [string](Get-FileWriters -Path '" + rxDir + "') } -Compress").v;
  assert.ok(!r.split(';').includes(authenticatedUsersName), r);
});

// ---------------------------------------------------------------------------------------------
// The wrapper.
// ---------------------------------------------------------------------------------------------
test('wrapper: -Name nosuch exits 1 naming the roster path and the name, before any log exists', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runPs([wrapperPath, '-Name', 'nosuch', '-Roster', sc.roster, '-EnvFile', sc.envFile]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(sc.roster) && r.stderr.includes("'nosuch'"), r.stderr);
  assert.ok(!fs.existsSync(sc.log), 'no log written');
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
});
test('wrapper: a disabled entry exits 1 naming the roster path and the name', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runPs([wrapperPath, '-Name', 'off', '-Roster', sc.roster, '-EnvFile', sc.envFile]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(sc.roster) && r.stderr.includes("'off'"), r.stderr);
});
test('wrapper: an unknown flag is a binding error exiting 1 without launching', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runWrapper(sc, ['-Bogus']);
  assert.equal(r.status, 1);
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
});

// The ladder: eight crashes then a signal. Also the env file's allowlist in both directions, the
// roster's environment map, the launch shape and the state file.
test('wrapper: the delay doubles from 300 to the 14400 cap across consecutive crashes, then exit 130 ends the run', () => {
  const sc = makeScenario({
    codes: [3, 4, 5, 3, 3, 3, 3, 3, 130],
    entry: { model: 'opus', args: ['--no-channel'], channelName: 'chan-alpha' },
  });
  const appdata = fwd(path.join(sc.dir, 'appdata'));
  fs.writeFileSync(sc.envFile, [
    '# scratch env',
    'KEEPER_BASH_EXE=' + fwd(sc.stubCmd),
    'APPDATA=' + appdata,
    'USERPROFILE=' + fwd(path.join(sc.dir, 'profile')),
    'KEEPER_SECRET=leaked',
    'HOME=   ',
    'TEMP=first',
    'TEMP=second',
    '',
  ].join('\n'));
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const decides = decideLines(sc);
  assert.deepEqual(decides.map((d) => [d.exit, d.action, d.delay]), [
    [3, 'relaunch', 300], [4, 'relaunch', 600], [5, 'relaunch', 1200], [3, 'relaunch', 2400],
    [3, 'relaunch', 4800], [3, 'relaunch', 9600], [3, 'relaunch', 14400], [3, 'relaunch', 14400],
    [130, 'exit', 0],
  ]);
  assert.equal(decides.filter((d) => d.action === 'hold').length, 0, 'no crash-class or signal row ever holds');
  assert.ok(!fs.existsSync(sc.hold), 'no hold marker');
  const lines = logLines(sc);
  const launches = lines.filter((l) => l.startsWith('LAUNCH '));
  assert.equal(launches.length, 9);
  assert.equal(launches[0], 'LAUNCH 1 ' + fwd(sc.stubCmd) + ' ' + supervisorPath + ' ' + fwd(sc.work) + ' alpha bypassPermissions --channel-name chan-alpha --no-channel');
  assert.ok(launches.every((l) => !/ -l\b/.test(l)), 'never bash -l');
  assert.equal(lines.filter((l) => /^EXIT \d+ code=\d+ uptime=\d+$/.test(l)).length, 9);
  // Env file: applied keys read back from the stub, the ignored key absent from its environment.
  const out = readText(sc.out);
  assert.equal((out.match(/^STUB_APPDATA=/gm) || []).length, 9, 'stub stdout landed once per run');
  assert.equal((out.match(/^STUB_STDERR code=/gm) || []).length, 9, 'stub stderr landed once per run');
  assert.ok(out.includes('STUB_APPDATA=' + appdata), 'APPDATA from the env file reached the stub (control: the instrument reads the environment)');
  assert.ok(out.includes('STUB_KEEPER_SECRET=<unset>') && !out.includes('leaked'), 'the key outside the allowlist did not reach the stub');
  assert.ok(out.includes('STUB_MODEL=opus'), 'MODEL from the roster reached the stub');
  assert.ok(out.includes('STUB_LOGIN_SHELL=no'), 'the stub ran in a non-login shell');
  assert.ok(out.includes('STUB_ARGS=' + supervisorPath + ' ' + fwd(sc.work) + ' alpha bypassPermissions --channel-name chan-alpha --no-channel'), 'the stub saw the supervisor path and the built arguments');
  assert.ok(lines.includes('ENV ignored: KEEPER_SECRET'), lines.join('\n'));
  assert.ok(lines.includes('ENV empty: HOME'));
  assert.ok(lines.includes('ENV duplicate: TEMP'));
  assert.ok(!lines.some((l) => l.startsWith('ENV refused')), 'a clean file is not refused');
  // State file.
  assertNoBom(sc.state);
  assertNoBom(sc.log);
  assertNoBom(sc.out);
  const state = JSON.parse(readText(sc.state));
  assert.deepEqual(Object.keys(state).sort(), ['currentDelay', 'holdReason', 'lastEnd', 'lastExitCode', 'lastStart', 'launchCount', 'persona']);
  assert.equal(state.persona, 'alpha');
  assert.equal(state.launchCount, 9);
  assert.equal(state.lastExitCode, 130);
  assert.equal(state.currentDelay, 14400);
  assert.equal(state.holdReason, null);
  assert.ok(!Number.isNaN(Date.parse(state.lastStart)) && !Number.isNaN(Date.parse(state.lastEnd)));
});

test('wrapper: exit 0 writes keeper.hold with the reason and exits 0; the marker then holds, -Release removes it', () => {
  const sc = makeScenario({ codes: [0, 130] });
  let r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const d = decideLines(sc);
  assert.equal(d.length, 1);
  assert.equal(d[0].exit, 0);
  assert.equal(d[0].action, 'hold');
  const marker = readText(sc.hold).split(/\r?\n/);
  assert.equal(marker[0], d[0].reason);
  assert.equal(JSON.parse(readText(sc.state)).holdReason, d[0].reason);
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 1);

  // Marker present: HOLD logged, exit 0, no launch.
  r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  let lines = logLines(sc);
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1, 'no LAUNCH after the HOLD');
  assert.equal(lines[lines.length - 1], 'HOLD ' + d[0].reason);
  assert.equal(readText(sc.codesFile), '130\n', 'the stub did not run');

  // -Release: marker removed, logged, no launch.
  r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(sc.hold), 'marker removed');
  lines = logLines(sc);
  assert.equal(lines[lines.length - 1], 'RELEASE ' + sc.hold);
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1, 'no LAUNCH on -Release');

  // -Release with no marker: logged as none, exit 0, no launch.
  r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  lines = logLines(sc);
  assert.equal(lines[lines.length - 1], 'RELEASE none');
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1);
  assert.equal(readText(sc.codesFile), '130\n', 'the stub did not run');

  // After the release a start launches again.
  r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 2, 'launched after release');
  assert.equal(readText(sc.codesFile), '', 'the stub consumed its last code');
});

test('wrapper: a single exit 1 relaunches after 300; three fast exit-1 runs hold with the stderr line and the supervisor.out path', () => {
  const sc = makeScenario({ codes: [1, 1, 1, 130] });
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const d = decideLines(sc);
  assert.deepEqual(d.map((x) => [x.exit, x.action, x.delay]), [[1, 'relaunch', 300], [1, 'relaunch', 300], [1, 'hold', 0]]);
  assert.ok(d.every((x) => x.uptime < 60), 'each run was under 60 seconds');
  const marker = readText(sc.hold).split(/\r?\n/);
  assert.equal(marker[0], d[2].reason);
  assert.equal(marker[1], 'STUB_STDERR code=1');
  assert.equal(marker[2], sc.out);
  assert.equal(readText(sc.codesFile), '130\n', 'no fourth launch after the hold');
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 3);
});

test('wrapper: exit 2 relaunches after 300 and exit 143 exits without a hold', () => {
  const sc = makeScenario({ codes: [2, 143] });
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const d = decideLines(sc);
  assert.deepEqual(d.map((x) => [x.exit, x.action, x.delay]), [[2, 'relaunch', 300], [143, 'exit', 0]]);
  assert.ok(!fs.existsSync(sc.hold));
});

test('wrapper: an args entry carrying --prompt exits 1 naming the roster path before the stub runs', () => {
  const sc = makeScenario({ codes: [130], entry: { args: ['--prompt', 'do things'] } });
  const r = runWrapper(sc);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(sc.roster) && r.stderr.includes('--prompt'), r.stderr);
  const lines = logLines(sc);
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 0, 'no LAUNCH line');
  assert.ok(lines.some((l) => l.startsWith('ERROR ') && l.includes('--prompt')), lines.join('\n'));
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
  assert.ok(!fs.existsSync(sc.out), 'no supervisor.out');
});

test('wrapper: an env file with a foreign DACL writer is refused with the principal named, exit 1, no launch', () => {
  const sc = makeScenario({ codes: [130] });
  icacls([sc.envFile, '/grant', '*' + authenticatedUsersSid + ':(M)']);
  const r = runWrapper(sc);
  assert.equal(r.status, 1);
  const lines = logLines(sc);
  assert.ok(lines.includes('ENV refused: ' + authenticatedUsersName), lines.join('\n'));
  assert.ok(r.stderr.includes(authenticatedUsersName), r.stderr);
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 0, 'no LAUNCH line');
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
});

test('wrapper: a directory writable by a foreign principal is logged as a warning and the run proceeds', () => {
  const sc = makeScenario({ codes: [130], envDir: 'envdir' });
  // A grant with no inheritance flags applies to the directory only, so the file inside stays clean.
  icacls([path.dirname(sc.envFile), '/grant', '*' + authenticatedUsersSid + ':(M)']);
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const lines = logLines(sc);
  assert.ok(lines.includes('ENV dir-writers: ' + authenticatedUsersName), lines.join('\n'));
  assert.ok(!lines.some((l) => l.startsWith('ENV refused')));
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1);
});

test('wrapper: a missing env file with no KEEPER_BASH_EXE in the process environment exits 1', () => {
  const sc = makeScenario({ codes: [130] });
  fs.unlinkSync(sc.envFile);
  const r = runWrapper(sc);
  assert.equal(r.status, 1);
  const lines = logLines(sc);
  assert.ok(lines.includes('ENV missing: ' + sc.envFile), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('ERROR ') && l.includes('KEEPER_BASH_EXE')));
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
});

test('wrapper: a missing env file with KEEPER_BASH_EXE on the process environment launches', () => {
  const sc = makeScenario({ codes: [130] });
  fs.unlinkSync(sc.envFile);
  const r = runWrapper(sc, [], childEnv({ KEEPER_BASH_EXE: fwd(sc.stubCmd) }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 1);
  assert.equal(readText(sc.codesFile), '');
});

test('wrapper: a bash executable that does not exist is a wrapper fault, exit 1, logged', () => {
  const sc = makeScenario({ codes: [130], envLines: ['KEEPER_BASH_EXE=' + fwd(path.join(tmp, 'nosuch-bash.exe'))] });
  const r = runWrapper(sc);
  assert.equal(r.status, 1);
  assert.ok(logLines(sc).some((l) => l.startsWith('ERROR launch failed:')), readText(sc.log));
});

test('wrapper: keeper.log past 5 MB rotates to keeper.log.1 before the append', () => {
  const sc = makeScenario({ codes: [130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
  fs.writeFileSync(sc.log, big);
  const r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(sc.log + '.1').size, big.length, 'the old generation is the renamed file');
  assert.ok(fs.statSync(sc.log).size < 1024, 'the live log holds only the new line');
  assert.deepEqual(logLines(sc), ['RELEASE none']);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (fs.existsSync(tmp)) {
  console.error('FAIL: scratch directory not removed: ' + tmp);
  fail++;
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
