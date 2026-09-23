#!/usr/bin/env node
// Unit test for the process keeper: bin/keeper-functions.ps1 (the pure functions),
// bin/Start-Persona.ps1 (the wrapper a scheduled task runs) and bin/keeper-probe.ps1
// (the environment recorder), which this suite requires to be present.
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
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const functionsPath = path.join(repoRoot, 'bin', 'keeper-functions.ps1');
const wrapperPath = path.join(repoRoot, 'bin', 'Start-Persona.ps1');
const probePath = path.join(repoRoot, 'bin', 'keeper-probe.ps1');
// The form every argument reaches bash in: Git bash mounts D:/ at /d, and bin/supervise.sh reads
// anything not starting with / as relative to the directory it was started in.
const toBash = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):(?=\/|$)/, (m, d) => '/' + d.toLowerCase());
const supervisorPath = toBash(repoRoot + '/bin/supervise.sh');
const bashExe = 'C:/Program Files/Git/bin/bash.exe';
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

for (const p of [functionsPath, wrapperPath, probePath, bashExe]) {
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

// options carries stdio: a run whose supervisor leaves a descendant behind is spawned with the
// streams ignored, because .NET hands the child every inheritable handle this process holds, the
// pipes node made among them, so spawnSync would otherwise wait for the descendant to close them
// and report that wait as the wrapper's own.
function runPs(fileArgs, env, options = {}) {
  return spawnSync('powershell.exe', [...psArgs, '-File', ...fileArgs], { encoding: 'utf8', env: env || childEnv(), ...options });
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
// orphanSeconds makes the stub spawn a background child that inherits the stub's stdout and stderr
// and outlives it by that many seconds, which is what a supervisor exit 5 leaves behind.
function makeScenario({ codes, entry = {}, envLines, orphanSeconds, rundirName, chatterLines }) {
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
    ...(orphanSeconds ? [
      // The marker names this launch's descendant, so the test can wait for it rather than sleep.
      'marker="' + fwd(dir) + '/orphan-$$.done"',
      'echo "ORPHAN_MARKER=$marker"',
      'bash -c "sleep ' + orphanSeconds + '; touch \'$marker\'" &',
    ] : []),
    'echo "STUB_ARGS=$*"',
    // What bash makes of the --rundir it was handed: the directory it resolves to, and a file
    // written there, so the test can compare it with where the wrapper writes its own state.
    'rundir=""; prev=""',
    'for a in "$@"; do if [ "$prev" = "--rundir" ]; then rundir="$a"; fi; prev="$a"; done',
    'if [ -n "$rundir" ]; then mkdir -p "$rundir" && touch "$rundir/from-stub.txt"; echo "STUB_RUNDIR_PWD=$(cd "$rundir" && pwd)"; fi',
    'echo "STUB_APPDATA=$APPDATA"',
    'echo "STUB_USERPROFILE=$USERPROFILE"',
    'echo "STUB_KEEPER_SECRET=${KEEPER_SECRET-<unset>}"',
    'echo "STUB_MODEL=${MODEL-<unset>}"',
    'echo "STUB_LOGIN_SHELL=$(shopt -q login_shell && echo yes || echo no)"',
    // More than one flush size on each stream, so the capture is exercised past its buffer.
    ...(chatterLines ? [
      'pad="0123456789012345678901234567890123456789"',
      'for i in $(seq 1 ' + chatterLines + '); do printf "OUT %05d %s\\n" "$i" "$pad"; printf "ERR %05d %s\\n" "$i" "$pad" >&2; done',
    ] : []),
    'echo "STUB_STDERR code=$code" >&2',
    'exit ${code:-130}',
    '',
  ].join('\n'));
  const stubCmd = path.join(dir, 'stub.cmd');
  fs.writeFileSync(stubCmd, '@echo off\r\n"' + bashExe.replace(/\//g, '\\') + '" "' + stubSh + '" %*\r\nexit /b %ERRORLEVEL%\r\n');
  const roster = path.join(dir, 'fleet.json');
  const full = { name: 'alpha', workdir: fwd(work), permissionMode: 'bypassPermissions', enabled: true, ...entry };
  // A rundir the roster spells the Windows way, which is what an operator writes.
  if (rundirName) full.rundir = fwd(path.join(dir, rundirName));
  fs.writeFileSync(roster, JSON.stringify([full, { name: 'off', workdir: fwd(work), permissionMode: 'acceptEdits', enabled: false }], null, 2));
  const envFile = path.join(dir, 'keeper.env');
  const lines = envLines || ['# scratch keeper env', 'KEEPER_BASH_EXE=' + fwd(stubCmd)];
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
  const runDir = full.rundir ? full.rundir : path.join(work, 'run');
  return {
    dir, work, codesFile, stubCmd, roster, envFile, runDir,
    log: path.join(runDir, 'keeper.log'),
    state: path.join(runDir, 'keeper.json'),
    out: path.join(runDir, 'supervisor.out'),
    hold: path.join(runDir, 'keeper.hold'),
    park: path.join(runDir, 'keeper.park'),
  };
}

function runWrapper(sc, extra = [], env, options) {
  return runPs([wrapperPath, '-Name', 'alpha', '-Roster', sc.roster, '-EnvFile', sc.envFile, '-DelayScale', '0.0001', ...extra], env, options);
}

function readText(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// The files a launch redirects the supervisor's two streams into, named for the wrapper's capture
// id (its process id and its start time) and the launch number, which the wrapper appends to
// supervisor.out and then removes.
function captureFiles(sc) {
  if (!fs.existsSync(sc.runDir)) return [];
  return fs.readdirSync(sc.runDir).filter((n) => /^supervisor\.out\.\d+-\d+\.\d+\.(stdout|stderr)$/.test(n)).sort();
}

// The wrapper's own clock: the stamp on its last log line, in milliseconds.
function lastLogTime(sc) {
  const lines = readText(sc.log).split(/\r?\n/).filter((l) => l.length > 0);
  return Date.parse(lines[lines.length - 1].split(' ')[0]);
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
  { name: 'exit 6 parks with no delay, the ladder unchanged and the exit-1 count reset', in: [6, 5, 1200, 2], action: 'park', delay: 0, next: 1200, nextExit1: 0, reasonTokens: [/exited 6:/, /park/, /next start/] },
  { name: 'exit 6 after a long run still parks rather than relaunching', in: [6, 7200, 4800, 0], action: 'park', delay: 0 },
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
      if (c.reasonTokens !== undefined) for (const t of c.reasonTokens) assert.match(r.Reason, t, 'reason names ' + t);
      if (c.action === 'hold' || c.action === 'park') assert.equal(r.DelaySeconds, 0, 'a hold or a park never carries a relaunch delay');
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Read-KeeperRoster and Build-SupervisorInvocation.
// ---------------------------------------------------------------------------------------------
const rosterFile = path.join(tmp, 'roster.json');
fs.writeFileSync(rosterFile, JSON.stringify([
  { name: 'full', workdir: 'D:/scratch/full work', permissionMode: 'bypassPermissions', rundir: 'D:/scratch/full/run', channelName: 'chan-full', model: 'opus', effort: 'high', controllerTickMs: 60000, coordinatorPersona: 'coordinator', architectPersona: 'architect', fleetRoster: 'D:/scratch/fleet.json', jevMode: 'shadow', args: ['--no-channel', '--dev'], enabled: true },
  { name: 'minimal', workdir: 'D:/scratch/minimal', permissionMode: 'acceptEdits', enabled: true },
  { name: 'partial', workdir: 'D:/scratch/partial', permissionMode: 'acceptEdits', coordinatorPersona: 'steward', enabled: true },
  { name: 'prompted', workdir: 'D:/scratch/p', permissionMode: 'acceptEdits', args: ['--prompt', 'hello'], enabled: true },
  { name: 'prompted-eq', workdir: 'D:/scratch/p', permissionMode: 'acceptEdits', args: ['--prompt=hello'], enabled: true },
  { name: 'noworkdir', permissionMode: 'acceptEdits', enabled: true },
  { name: 'disabled', workdir: 'D:/scratch/d', permissionMode: 'acceptEdits', enabled: false },
  { name: 'stringfalse', workdir: 'D:/scratch/sf', permissionMode: 'acceptEdits', enabled: 'false' },
  { name: 'stringtrue', workdir: 'D:/scratch/st', permissionMode: 'acceptEdits', enabled: 'true' },
  { name: 'noenabled', workdir: 'D:/scratch/ne', permissionMode: 'acceptEdits' },
  { name: 'nullenabled', workdir: 'D:/scratch/nu', permissionMode: 'acceptEdits', enabled: null },
  { name: 'posix', workdir: '/d/scratch/posix', permissionMode: 'acceptEdits', rundir: '/d/scratch/posix/run', enabled: true },
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
test('roster: an enabled field that is the string "false" throws rather than reading as disabled', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'stringfalse'");
  assert.ok(r.error, 'threw');
  assert.ok(r.error.includes(rosterFile) && r.error.includes("'stringfalse'") && r.error.includes('boolean'), r.error);
});
test('roster: an enabled field that is the string "true" throws too, since only a JSON boolean enables', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'stringtrue'");
  assert.ok(r.error && r.error.includes('boolean'), JSON.stringify(r));
});
test('roster: an entry carrying no enabled field is told the field is missing, not that it has the wrong type', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'noenabled'");
  assert.ok(r.error, 'threw');
  assert.ok(r.error.includes(rosterFile) && r.error.includes("'noenabled'"), r.error);
  assert.ok(r.error.includes("no 'enabled' field"), r.error);
  assert.ok(!r.error.includes('is not a JSON boolean'), 'no field it does not carry is named: ' + r.error);
});
test('roster: an entry whose enabled field is JSON null is told the type is wrong, since it does carry the field', () => {
  const r = rosterCall("Read-KeeperRoster -Path " + rosterPs + " -Name 'nullenabled'");
  assert.ok(r.error && r.error.includes('is not a JSON boolean'), JSON.stringify(r));
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
  assert.deepEqual(r.Arguments, ['/d/scratch/full work', 'full', 'bypassPermissions', '--rundir', '/d/scratch/full/run', '--channel-name', 'chan-full', '--no-channel', '--dev']);
  // This leg pins the variable name and the value of every mapped field the
  // fixture carries, so a renamed target or an unconditional emit fails here. It
  // does not catch a row added to $map alone: the fixture would then not carry
  // that field, the builder skips a field the entry lacks, and this expectation
  // stays green. A new row means a new fixture field and a new key here too.
  assert.deepEqual(r.Environment, { MODEL: 'opus', EFFORT: 'high', controllerTickMs: '60000', COORDINATOR_PERSONA: 'coordinator', ARCHITECT_PERSONA: 'architect', FLEET_ROSTER: 'D:/scratch/fleet.json', JEV_MODE: 'shadow' });
});
test('build: a minimal entry yields the three positional arguments and an empty environment', () => {
  const r = build('minimal');
  assert.deepEqual(r.Arguments, ['/d/scratch/minimal', 'minimal', 'acceptEdits']);
  assert.deepEqual(r.Environment, {}, 'an entry carrying none of the mapped fields yields no environment key at all');
});
test('build: an entry carrying some mapped fields yields those keys and no others', () => {
  // The two legs above pin the extremes, all seven fields and none. The docstring's
  // and the README's claim is about the middle, "each set only where the entry
  // carries the field", which is the shape the shipped roster's worker entries have.
  const r = build('partial');
  assert.deepEqual(r.Environment, { COORDINATOR_PERSONA: 'steward' });
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
test('build: a rundir and workdir already spelled the bash way are passed through unchanged', () => {
  const r = build('posix');
  assert.deepEqual(r.Arguments, ['/d/scratch/posix', 'posix', 'acceptEdits', '--rundir', '/d/scratch/posix/run']);
});
test('build: every path argument is absolute to bash, which is what bin/supervise.sh lines 109 to 114 require of a rundir', () => {
  for (const name of ['full', 'minimal', 'posix']) {
    const r = build(name);
    assert.ok(r.Arguments[0].startsWith('/'), name + ' workdir: ' + r.Arguments[0]);
    const i = r.Arguments.indexOf('--rundir');
    if (i >= 0) assert.ok(r.Arguments[i + 1].startsWith('/'), name + ' rundir: ' + r.Arguments[i + 1]);
  }
});
test('bashpath: a backslash path, a bare drive and a UNC path each keep naming the same place', () => {
  const r = runFunctions("ConvertTo-Json -InputObject @(@('D:\\personas\\dev\\run','C:/x','E:','//host/share/x','/d/already','') | ForEach-Object { [string](ConvertTo-BashPath $_) }) -Compress");
  assert.deepEqual(r, ['/d/personas/dev/run', '/c/x', '/e', '//host/share/x', '/d/already', '']);
});

// ---------------------------------------------------------------------------------------------
// Find-KeeperLiveSupervisor: records built here, in the shape Get-CimInstance Win32_Process
// returns, so no case reads the machine's process list. One powershell spawn evaluates every case.
// The command lines are the live shapes: Git bash's launcher, then the inner bash it starts under
// the ..\usr\bin spelling and a long-lived fork of that inner one, each carrying the supervisor's
// arguments as the keeper quoted them. Each case names the launcher the wrapper would pass.
// ---------------------------------------------------------------------------------------------
{
  const sup = '/d/agent_persona/bin/supervise.sh';
  const work = '/d/personas/dev-plugin/repo';
  const launcher = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const outerExe = '"' + launcher + '"';
  const innerExe = '"C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe"';
  const tail = ' bypassPermissions --rundir /d/personas/dev-plugin/run --channel-name dev-plugin';
  const rec = (pid, ppid, cmd, created = '2026-09-21T00:00:00Z') => ({ ProcessId: pid, ParentProcessId: ppid, CommandLine: cmd, CreationDate: created });
  // The inner process and a forked grandchild come first and started later, so a rule that took
  // the first match, or the youngest, would return one of them rather than the outer.
  const pair = [
    rec(4, 0, null),
    rec(101, 100, innerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail, '2026-09-21T00:00:01Z'),
    rec(102, 101, innerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail, '2026-09-21T00:00:03Z'),
    rec(100, 50, outerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail),
    rec(50, 1, '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -File "D:\\agent_persona\\bin\\Start-Persona.ps1" -Name dev-plugin'),
  ];
  const argsFor = (w, name) => [sup, w, name, 'bypassPermissions', '--rundir', '/d/personas/' + name + '/run', '--channel-name', name];
  const matchCases = [
    { name: 'an outer and an inner bash.exe for dev-plugin, asked for dev-plugin, return the outer', records: pair, args: argsFor(work, 'dev-plugin'), pid: 100 },
    // Two launchers for the persona, the child listed first and started later, so only the rule
    // that the returned record's parent is not itself a match returns the outer.
    { name: 'a launcher started from another launcher for the same persona yields the outer one', records: [rec(501, 500, outerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail, '2026-09-21T00:00:05Z'), rec(500, 50, outerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail)], args: argsFor(work, 'dev-plugin'), pid: 500 },
    // What a supervisor that exited 5 leaves: the MSYS fork, its parents gone, still carrying the
    // persona's arguments. Its parent id names no record, so only the executable rules it out.
    { name: 'an orphaned usr\\bin bash.exe fork for this persona, its parent gone, returns nothing', records: [rec(102, 101, innerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail)], args: argsFor(work, 'dev-plugin'), pid: null },
    { name: 'another executable carrying the three tokens returns nothing', records: [rec(600, 50, 'notepad.exe ' + sup + ' ' + work + ' dev-plugin' + tail)], args: argsFor(work, 'dev-plugin'), pid: null },
    { name: 'the launcher spelled with forward slashes and in another case still matches', records: [rec(700, 50, '"c:/program files/GIT/bin/BASH.exe" ' + sup + ' ' + work + ' dev-plugin' + tail)], args: argsFor(work, 'dev-plugin'), pid: 700 },
    { name: 'a launcher the wrapper spells with forward slashes matches the backslash command line', records: [rec(701, 50, outerExe + ' ' + sup + ' ' + work + ' dev-plugin' + tail)], exe: 'C:/Program Files/Git/bin/bash.exe', args: argsFor(work, 'dev-plugin'), pid: 701 },
    // Same working directory, so only the persona token differs: a prefix, substring or
    // whole-line pattern over the command line would return dev-plugin's supervisor here.
    { name: 'the same list asked for dev returns nothing, since dev is a prefix of dev-plugin and not its name', records: pair, args: argsFor(work, 'dev'), pid: null },
    { name: 'a supervisor for the same persona under another working directory is not returned', records: [rec(200, 50, outerExe + ' ' + sup + ' /d/personas/other/repo dev-plugin' + tail)], args: argsFor(work, 'dev-plugin'), pid: null },
    { name: 'a supervisor for this persona with another channel name and an extra trailing argument is returned', records: [rec(300, 50, outerExe + ' ' + sup + ' ' + work + ' dev-plugin bypassPermissions --rundir /d/personas/dev-plugin/run --channel-name old-channel --dev')], args: argsFor(work, 'dev-plugin'), pid: 300 },
    { name: 'an empty list returns nothing', records: [], args: argsFor(work, 'dev-plugin'), pid: null },
    // The tokenizer at the boundary: an unquoted executable, a quoted working directory carrying a
    // space, and a quoted token carrying an escaped quote and backslashes before it. The unquoted
    // executable is a launcher installed where its path has no space.
    { name: 'a quoted working directory with a space matches its unquoted argument', records: [rec(400, 50, 'C:\\Git\\bin\\bash.exe ' + sup + ' "/d/scratch/full work" full' + tail)], exe: 'C:\\Git\\bin\\bash.exe', args: argsFor('/d/scratch/full work', 'full'), pid: 400 },
    { name: 'the quoted directory is one token, so its first word alone does not match', records: [rec(401, 50, 'C:\\Git\\bin\\bash.exe ' + sup + ' "/d/scratch/full work" full' + tail)], exe: 'C:\\Git\\bin\\bash.exe', args: argsFor('/d/scratch/full', 'work'), pid: null },
    { name: 'backslashes and an escaped quote inside a quoted token come back as the argument was written', records: [rec(402, 50, outerExe + ' ' + sup + ' "/d/a b\\\\\\"c" q' + tail)], args: argsFor('/d/a b\\"c', 'q'), pid: 402 },
  ];
  const casesFile = path.join(tmp, 'match-cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(matchCases.map((c) => ({ records: c.records, exe: c.exe || launcher, args: c.args }))));
  let results;
  try {
    results = runFunctions([
      "$cases = @((Get-Content -LiteralPath '" + casesFile + "' -Raw | ConvertFrom-Json) | ForEach-Object { $_ })",
      '$out = @()',
      'foreach ($c in $cases) {',
      '  $r = Find-KeeperLiveSupervisor -Processes @($c.records | ForEach-Object { $_ }) -Executable $c.exe -Arguments @($c.args)',
      '  if ($null -eq $r) { $out += [pscustomobject]@{ pid = $null } } else { $out += [pscustomobject]@{ pid = [int]$r.ProcessId } }',
      '}',
      'ConvertTo-Json -InputObject $out -Compress -Depth 3',
    ].join('\n'));
  } catch (e) {
    console.error('FAIL: match driver: ' + e.message);
    fail++;
    results = [];
  }
  matchCases.forEach((c, i) => {
    test('match: ' + c.name, () => {
      const r = results[i];
      assert.ok(r, 'result present');
      assert.equal(r.pid, c.pid, 'the process id returned, or null for nothing');
    });
  });
}

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
test('envfile: a matching pair of quotes is stripped and named, an unmatched quote is kept, and either way the value is trimmed', () => {
  const f = path.join(tmp, 'quoted.env');
  fs.writeFileSync(f, [
    'KEEPER_BASH_EXE=  "C:/Program Files/Git/bin/bash.exe"  ',
    "HOME='C:/single'",
    'APPDATA="C:/half',
    'TEMP="mixed\'',
    'TMP=  C:/plain  ',
    'LOCALAPPDATA=""',
    'USERPROFILE=" C:/kept "',
    '',
  ].join('\n'));
  const r = runFunctions("$r = Read-KeeperEnvFile -Path '" + f + "'\nConvertTo-Json -InputObject @{ Values = $r.Values; Unquoted = @($r.Unquoted) } -Compress -Depth 3");
  assert.equal(r.Values.KEEPER_BASH_EXE, 'C:/Program Files/Git/bin/bash.exe');
  assert.equal(r.Values.HOME, 'C:/single');
  assert.equal(r.Values.APPDATA, '"C:/half', 'one quote is part of the value');
  assert.equal(r.Values.TEMP, '"mixed\'', 'two quotes that do not match are part of the value');
  assert.equal(r.Values.TMP, 'C:/plain', 'an unquoted value is trimmed, so it reaches a launch as a name that exists');
  assert.equal(r.Values.LOCALAPPDATA, '', 'an empty pair of quotes leaves an empty value');
  assert.equal(r.Values.USERPROFILE, ' C:/kept ', 'inside the quotes the spacing is the value and is kept');
  assert.deepEqual([...r.Unquoted].sort(), ['HOME', 'KEEPER_BASH_EXE', 'LOCALAPPDATA', 'USERPROFILE']);
});
test('envfile: a missing file throws naming the path', () => {
  const f = path.join(tmp, 'absent.env');
  const r = rosterCall("Read-KeeperEnvFile -Path '" + f + "'");
  assert.ok(r.error && r.error.includes('absent.env'), JSON.stringify(r));
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
  assert.equal(launches[0], 'LAUNCH 1 ' + fwd(sc.stubCmd) + ' ' + supervisorPath + ' ' + toBash(sc.work) + ' alpha bypassPermissions --channel-name chan-alpha --no-channel');
  assert.ok(launches.every((l) => !/ -l\b/.test(l)), 'never bash -l');
  assert.equal(lines.filter((l) => /^EXIT \d+ code=\d+ uptime=\d+$/.test(l)).length, 9);
  // Env file: applied keys read back from the stub, the ignored key absent from its environment.
  const out = readText(sc.out);
  assert.equal((out.match(/^STUB_APPDATA=/gm) || []).length, 9, 'stub stdout landed once per run');
  assert.equal((out.match(/^STUB_STDERR code=/gm) || []).length, 9, 'stub stderr landed once per run');
  // Nine launches, none of which left a survivor holding a capture file open, so every one of the
  // eighteen was appended and removed and supervisor.out is the only copy.
  assert.deepEqual(captureFiles(sc), [], 'no capture file left in the run directory');
  assert.ok(out.includes('STUB_APPDATA=' + appdata), 'APPDATA from the env file reached the stub (control: the instrument reads the environment)');
  assert.ok(out.includes('STUB_KEEPER_SECRET=<unset>') && !out.includes('leaked'), 'the key outside the allowlist did not reach the stub');
  assert.ok(out.includes('STUB_MODEL=opus'), 'MODEL from the roster reached the stub');
  assert.ok(out.includes('STUB_LOGIN_SHELL=no'), 'the stub ran in a non-login shell');
  assert.ok(out.includes('STUB_ARGS=' + supervisorPath + ' ' + toBash(sc.work) + ' alpha bypassPermissions --channel-name chan-alpha --no-channel'), 'the stub saw the supervisor path and the built arguments');
  assert.ok(lines.includes('ENV ignored: KEEPER_SECRET'), lines.join('\n'));
  assert.ok(lines.includes('ENV empty: HOME'));
  assert.ok(lines.includes('ENV duplicate: TEMP'));
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

// Waits for each marker file a launch's descendant will create, so the scratch tree is free before
// it is removed. Bounded: bash returns non-zero when the marker never arrives.
function waitForMarkers(markers) {
  for (const marker of markers) {
    const r = spawnSync(bashExe, ['-c', 'for i in $(seq 1 600); do [ -f "$1" ] && exit 0; sleep 0.1; done; exit 1', '-', fwd(marker)], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'descendant marker never appeared: ' + marker);
  }
}

// The descendant's life, and the bounds read against it. Every bound below has to sit far enough
// under it that a busy box cannot cross one without a defect: the wall clock being measured holds
// a powershell start, the dot-source, the stub's own run through cmd and bash, and the wrapper's
// drain.
const orphanSeconds = 12;
test('wrapper: a descendant that outlives the supervisor neither delays the return nor inflates the uptime, and the next launch still captures', () => {
  const sc = makeScenario({ codes: [130, 130, 130], orphanSeconds });
  const markersOf = () => [...readText(sc.out).matchAll(/^ORPHAN_MARKER=(.+?)\r?$/gm)].map((m) => m[1]);
  const started = Date.now();
  let r = runWrapper(sc, [], undefined, { stdio: 'ignore' });
  const elapsedMs = Date.now() - started;
  assert.equal(r.status, 0);
  assert.equal(markersOf().length, 1, 'the stub named its descendant');
  assert.ok(elapsedMs < 7000, 'the wrapper returned at the supervisor exit, not at the descendant exit: ' + elapsedMs + ' ms');
  const exits = logLines(sc).filter((l) => l.startsWith('EXIT '));
  assert.equal(exits.length, 1, exits.join('\n'));
  const uptime = Number(/uptime=(\d+)$/.exec(exits[0])[1]);
  assert.ok(uptime <= 5, 'the recorded uptime is the supervisor own run, not the descendant: ' + uptime);
  assert.equal(decideLines(sc)[0].uptime, uptime, 'the DECIDE line carries that same uptime');
  assert.ok(readText(sc.out).includes('STUB_STDERR code=130'), 'the first run output was captured while the descendant held the stream open');
  // The descendant holds both capture files of that run open, so Windows refuses their removal and
  // the wrapper records that it could not take them. The output itself was already appended.
  assert.equal(logLines(sc).filter((l) => l.startsWith('CAPTURE held: ')).length, 2, readText(sc.log));
  assert.equal(captureFiles(sc).length, 2, 'the pair the survivor holds is still in the run directory');
  const endedAt = lastLogTime(sc);

  // A second launch while the first descendant is still alive: its capture is not broken by it,
  // which is what a name no launch reuses buys.
  r = runWrapper(sc, [], undefined, { stdio: 'ignore' });
  assert.equal(r.status, 0);
  const out = readText(sc.out);
  assert.equal((out.match(/^STUB_ARGS=/gm) || []).length, 2, 'both runs landed in supervisor.out');
  assert.ok(!logLines(sc).some((l) => l.startsWith('CAPTURE failed')), readText(sc.log));
  assert.deepEqual(captureFiles(sc).length, 4, 'two launches, each leaving a survivor holding its own pair');

  // The control on the whole case: the descendant of the first run finished well after that run's
  // last log line, so the wrapper did return while it was alive. Had it already finished, every
  // assertion above would hold for a supervisor that left no survivor at all.
  const markers = markersOf();
  waitForMarkers(markers);
  const aliveForMs = fs.statSync(markers[0]).mtimeMs - endedAt;
  assert.ok(aliveForMs > 3000, 'the descendant outlived the wrapper by ' + Math.round(aliveForMs) + ' ms');

  // Both survivors are gone, and a third wrapper run still leaves their four files alone: a sweep
  // takes only what this wrapper's own earlier launches wrote, and these belong to two earlier
  // wrapper processes. The run adds the pair its own survivor holds open.
  r = runWrapper(sc, [], undefined, { stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.equal(captureFiles(sc).length, 6, 'no other incarnation file was swept: ' + captureFiles(sc).join(','));
  waitForMarkers(markersOf());
});

test('wrapper: a later launch of the same wrapper sweeps the pair its own earlier launch left held', () => {
  // The first launch's descendant holds that launch's pair open, so the launch cannot remove it.
  // The descendant's two seconds are over well before the relaunch six seconds later, so the
  // second launch's sweep takes the pair. This is the same-incarnation half of the case above.
  const sc = makeScenario({ codes: [3, 130], orphanSeconds: 2 });
  const r = runPs([wrapperPath, '-Name', 'alpha', '-Roster', sc.roster, '-EnvFile', sc.envFile, '-DelayScale', '0.02'], undefined, { stdio: 'ignore' });
  assert.equal(r.status, 0);
  assert.equal(logLines(sc).filter((l) => l.startsWith('CAPTURE held: ')).length, 4, readText(sc.log));
  const left = captureFiles(sc);
  assert.equal(left.length, 2, 'only the second launch pair is left: ' + left.join(','));
  assert.ok(left.every((n) => /\.2\.(stdout|stderr)$/.test(n)), 'and it is the second launch pair: ' + left.join(','));
  assert.equal((readText(sc.out).match(/^STUB_ARGS=/gm) || []).length, 2, 'both launches were appended before the sweep');
  waitForMarkers([...readText(sc.out).matchAll(/^ORPHAN_MARKER=(.+?)\r?$/gm)].map((m) => m[1]));
});

test('wrapper: capture files another wrapper incarnation left are not swept, since that wrapper has still to append them', () => {
  const sc = makeScenario({ codes: [130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  // A capture id no live wrapper can hold: the second component is a process start time.
  const peers = ['supervisor.out.999999-19700101000000000.1.stdout', 'supervisor.out.999999-19700101000000000.1.stderr'];
  for (const n of peers) fs.writeFileSync(path.join(sc.runDir, n), 'PEER OUTPUT\n');
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  for (const n of peers) assert.ok(fs.existsSync(path.join(sc.runDir, n)), 'left where it is: ' + n);
  assert.ok(!readText(sc.out).includes('PEER OUTPUT'), "and not appended to this wrapper's supervisor.out");
});

test('wrapper: a supervisor that writes a great deal on both streams loses none of it, and the hold marker still names the last stderr line', () => {
  const chatterLines = 3000;
  const sc = makeScenario({ codes: [1, 1, 1], chatterLines });
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const out = readText(sc.out);
  // Named first, because a failed append is the one way the capture loses text quietly and a bare
  // count that came up short would otherwise say nothing about why.
  assert.ok(!logLines(sc).some((l) => l.startsWith('CAPTURE failed')), readText(sc.log));
  assert.equal((out.match(/^OUT \d{5} /gm) || []).length, chatterLines * 3, 'every stdout line of every run');
  assert.equal((out.match(/^ERR \d{5} /gm) || []).length, chatterLines * 3, 'every stderr line of every run');
  assert.ok(out.includes('OUT ' + String(chatterLines).padStart(5, '0') + ' '), 'including the last one');
  // The last stderr line of the run that held, written after all that padding, so the line the
  // marker names is the last non-blank line of the whole stderr capture and not an early one.
  assert.equal(readText(sc.hold).split(/\r?\n/)[1], 'STUB_STDERR code=1');
});

test('wrapper: a rundir the roster spells the Windows way reaches bash as a path resolving to the directory the wrapper writes to', () => {
  // bin/supervise.sh lines 109 to 114 prefix any rundir that does not start with / with the
  // directory bash was started in, so the two consumers, bash and the wrapper's own .NET calls,
  // have to be handed the same directory in the spelling each resolves.
  const sc = makeScenario({ codes: [130], rundirName: 'state dir' });
  assert.ok(/^[A-Za-z]:\//.test(sc.runDir.replace(/\\/g, '/')), 'the roster carries a Windows path: ' + sc.runDir);
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const launch = logLines(sc).find((l) => l.startsWith('LAUNCH '));
  assert.ok(launch.includes('--rundir ' + toBash(sc.runDir)), launch);
  assert.ok(toBash(sc.runDir).startsWith('/'), 'absolute to bash, so supervise.sh leaves it alone');
  // Both consumers, read from the artifacts: the wrapper's own files and the file the stub wrote
  // into the --rundir it was handed are in one directory.
  assert.ok(fs.existsSync(sc.log) && fs.existsSync(sc.state), 'the wrapper wrote its state there');
  assert.ok(fs.existsSync(path.join(sc.runDir, 'from-stub.txt')), 'bash resolved --rundir to that same directory');
  const resolved = /^STUB_RUNDIR_PWD=(.*)$/m.exec(readText(sc.out))[1].trim();
  assert.equal(resolved.toLowerCase(), toBash(sc.runDir).toLowerCase(), 'and bash reports it as that directory');
});

// A roster refusal happens before the roster names a run directory, so it has no keeper.log to
// reach. Under a scheduled task it has no console either, which is why it lands beside the roster
// file.
const refusedLog = (sc) => path.join(path.dirname(sc.roster), 'keeper-refused.log');

test('wrapper: a roster that names the persona is launched, and nothing is written beside it', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 1);
  assert.ok(!fs.existsSync(refusedLog(sc)), 'no fallback log on a roster that reads');
});

test('wrapper: a roster naming no such persona is refused into the fallback log as well as stderr', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runPs([wrapperPath, '-Name', 'nosuch', '-Roster', sc.roster, '-EnvFile', sc.envFile]);
  assert.equal(r.status, 1);
  const refused = readText(refusedLog(sc));
  assert.ok(refused.includes('ROSTER error: ') && refused.includes("'nosuch'"), refused);
  assertNoBom(refusedLog(sc));
});

test('wrapper: an entry whose enabled field is the string "false" is refused rather than launched', () => {
  const sc = makeScenario({ codes: [130], entry: { enabled: 'false' } });
  const r = runWrapper(sc);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(sc.roster) && r.stderr.includes('boolean'), r.stderr);
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
});

test('wrapper: a hold marker that cannot be written still exits 0, so the scheduler does not relaunch a persona the policy stopped', () => {
  const sc = makeScenario({ codes: [0] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  // A directory where the marker file goes: the write fails, the decision does not change.
  fs.mkdirSync(sc.hold);
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const lines = logLines(sc);
  assert.equal(decideLines(sc)[0].action, 'hold');
  assert.ok(lines.some((l) => l.startsWith('ERROR ') && l.includes('hold marker')), lines.join('\n'));
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1, 'no relaunch');
});

// A park is a hold the next start clears. The start that clears it is the keeper's own start, never
// a timer, so these cases drive the wrapper twice over one run directory.
test('wrapper: exit 6 writes keeper.park with the reason alone and exits 0; the next start removes it, logs UNPARK and launches', () => {
  const sc = makeScenario({ codes: [6, 130] });
  let r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const d = decideLines(sc);
  assert.deepEqual(d.map((x) => [x.exit, x.action, x.delay]), [[6, 'park', 0]]);
  assert.deepEqual(readText(sc.park).split(/\r?\n/).filter((l) => l.length > 0), [d[0].reason], 'the reason is the only line');
  assertNoBom(sc.park);
  const state = JSON.parse(readText(sc.state));
  assert.equal(state.holdReason, d[0].reason);
  assert.equal(state.lastExitCode, 6);
  assert.ok(!fs.existsSync(sc.hold), 'a park writes no hold marker');
  assert.equal(logLines(sc).filter((l) => l.startsWith('LAUNCH ')).length, 1, 'no relaunch after the park');
  assert.equal(readText(sc.codesFile), '130\n', 'the stub did not run again');

  // The next start: the park marker is removed and logged, then the stub is launched.
  r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(sc.park), 'the start removed the park marker');
  const lines = logLines(sc);
  const unparkAt = lines.indexOf('UNPARK ' + sc.park);
  assert.ok(unparkAt >= 0, lines.join('\n'));
  assert.ok(!lines.some((l) => l.startsWith('HOLD ')), 'a park marker is never read as a hold');
  const launches = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('LAUNCH '));
  assert.equal(launches.length, 2, 'launched at the next start');
  assert.ok(launches[1][1] > unparkAt, 'the launch follows the UNPARK line');
  assert.equal(readText(sc.codesFile), '', 'the stub consumed its last code');
});

test('wrapper: a hold marker outranks a park marker, so the start logs HOLD, launches nothing and leaves both', () => {
  const sc = makeScenario({ codes: [130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  fs.writeFileSync(sc.hold, 'held by the operator\n');
  fs.writeFileSync(sc.park, 'parked earlier\n');
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const lines = logLines(sc);
  assert.deepEqual(lines, ['HOLD held by the operator'], 'one HOLD line and nothing else');
  assert.equal(readText(sc.hold), 'held by the operator\n', 'the hold marker is left as it was');
  assert.equal(readText(sc.park), 'parked earlier\n', 'the park marker is left as it was');
  assert.equal(readText(sc.codesFile), '130\n', 'the stub never ran');
});

test('wrapper: -Release removes a hold and a park marker with one RELEASE line each, a park alone with one, and neither as RELEASE none', () => {
  const sc = makeScenario({ codes: [130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  fs.writeFileSync(sc.hold, 'held\n');
  fs.writeFileSync(sc.park, 'parked\n');
  let r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(sc.hold) && !fs.existsSync(sc.park), 'both markers removed');
  assert.deepEqual(logLines(sc), ['RELEASE ' + sc.hold, 'RELEASE ' + sc.park]);

  fs.writeFileSync(sc.park, 'parked\n');
  r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(sc.park), 'the park marker removed');
  assert.deepEqual(logLines(sc).slice(2), ['RELEASE ' + sc.park]);

  r = runWrapper(sc, ['-Release']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(logLines(sc).slice(3), ['RELEASE none']);
  assert.equal(readText(sc.codesFile), '130\n', 'no -Release launches');
});

test('wrapper: a park marker that cannot be written still exits 0 without relaunching', () => {
  const sc = makeScenario({ codes: [6, 130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  // A directory where the marker file goes: the write fails, the decision does not change.
  fs.mkdirSync(sc.park);
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const lines = logLines(sc);
  assert.equal(decideLines(sc)[0].action, 'park');
  assert.ok(lines.some((l) => l.startsWith("ERROR park marker '" + sc.park + "' could not be written: ")), lines.join('\n'));
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1, 'no relaunch');
  assert.ok(!fs.existsSync(sc.hold), 'no hold marker in its place');
});

test('wrapper: a park marker the start cannot remove is logged as an ERROR and the start launches anyway', () => {
  const sc = makeScenario({ codes: [130] });
  fs.mkdirSync(sc.runDir, { recursive: true });
  fs.writeFileSync(sc.park, 'parked earlier\n');
  // A second process holds the marker open without delete sharing, so Windows refuses its removal
  // until that handle closes. The holder signals once the handle is open and closes it on request.
  const ready = path.join(sc.dir, 'lock-ready');
  const release = path.join(sc.dir, 'lock-release');
  const closed = path.join(sc.dir, 'lock-closed');
  const locker = path.join(sc.dir, 'lock.ps1');
  fs.writeFileSync(locker, [
    "$f = [System.IO.File]::Open('" + sc.park + "', 'Open', 'Read', 'Read')",
    'try {',
    "  [System.IO.File]::WriteAllText('" + ready + "', 'ready')",
    "  for ($i = 0; $i -lt 600 -and -not (Test-Path -LiteralPath '" + release + "'); $i++) { Start-Sleep -Milliseconds 100 }",
    '} finally { $f.Dispose() }',
    "[System.IO.File]::WriteAllText('" + closed + "', 'closed')",
    '',
  ].join('\n'));
  const holder = spawn('powershell.exe', [...psArgs, '-File', locker], { stdio: 'ignore' });
  try {
    waitForMarkers([ready]);
    const r = runWrapper(sc);
    assert.equal(r.status, 0, r.stderr);
    const lines = logLines(sc);
    assert.ok(lines.some((l) => l.startsWith("ERROR park marker '" + sc.park + "' could not be removed: ")), lines.join('\n'));
    assert.ok(!lines.some((l) => l.startsWith('UNPARK ')), 'no UNPARK for a marker still there');
    assert.ok(fs.existsSync(sc.park), 'the marker is still there, so the removal really failed');
    assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1, 'launched anyway');
    assert.equal(readText(sc.codesFile), '', 'the stub ran');
  } finally {
    fs.writeFileSync(release, 'go');
    try {
      waitForMarkers([closed]);
    } finally {
      let alive = true;
      try { process.kill(holder.pid, 0); } catch { alive = false; }
      if (alive) spawnSync('taskkill', ['/T', '/F', '/PID', String(holder.pid)]);
    }
  }
});

test('wrapper: a KEEPER_BASH_EXE written inside quotes launches, and the log says the quotes were taken off', () => {
  const sc = makeScenario({ codes: [130] });
  fs.writeFileSync(sc.envFile, ['KEEPER_BASH_EXE="' + fwd(sc.stubCmd) + '"', ''].join('\n'));
  const r = runWrapper(sc);
  assert.equal(r.status, 0, r.stderr);
  const lines = logLines(sc);
  assert.ok(lines.includes('ENV unquoted: KEEPER_BASH_EXE'), lines.join('\n'));
  assert.equal(lines.filter((l) => l.startsWith('LAUNCH ')).length, 1);
  assert.equal(readText(sc.codesFile), '', 'the stub ran, so the quotes were not part of the file name');
});

test('wrapper: a negative -DelayScale is a binding error exiting 1 without launching', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runPs([wrapperPath, '-Name', 'alpha', '-Roster', sc.roster, '-EnvFile', sc.envFile, '-DelayScale', '-1']);
  assert.equal(r.status, 1);
  // The parameter name is the stable token; the sentence around it is PowerShell's own prose and
  // is localized under a non-English UI culture.
  assert.ok(r.stderr.includes('DelayScale'), r.stderr);
  assert.equal(readText(sc.codesFile), '130\n', 'stub never ran');
  assert.ok(!fs.existsSync(sc.log), 'the binding error comes before any log line');
});

test('wrapper: keeper.json names the persona the roster spells, not the case the command line used', () => {
  const sc = makeScenario({ codes: [130] });
  const r = runPs([wrapperPath, '-Name', 'ALPHA', '-Roster', sc.roster, '-EnvFile', sc.envFile, '-DelayScale', '0.0001']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readText(sc.state)).persona, 'alpha');
  const launch = logLines(sc).find((l) => l.startsWith('LAUNCH '));
  assert.ok(/ alpha bypassPermissions/.test(launch), launch);
});

// A live supervisor for the wrapper's persona, which the wrapper must wait on rather than launch
// beside. The wrapper names its supervisor from its own location, and in this checkout that is the
// real bin/supervise.sh, which no case may run. So the two scripts are copied into a scratch tree
// whose bin/supervise.sh is a stub, and the stub is started through the real Git bash with the
// tokens the copied wrapper builds, under a test-only persona name and a scratch working directory
// no live supervisor carries. The match reads the executable too, so the env file names the same
// Git bash, and the stub tells the two runs apart by the channel name only the live one carries.
// The live run exits 1 once keeper.log shows the wrapper adopted it, and gives up after a bound so
// a wrapper that never adopts cannot leave it running. A run the wrapper launches writes a marker
// and exits 130 so the wrapper's run ends.
test('wrapper: a live supervisor for its persona is adopted, nothing is launched beside it, and its exit 1 gets the exit-1 DECIDE line', () => {
  const tree = path.join(tmp, 'adopt-tree');
  fs.mkdirSync(path.join(tree, 'bin'), { recursive: true });
  fs.copyFileSync(wrapperPath, path.join(tree, 'bin', 'Start-Persona.ps1'));
  fs.copyFileSync(functionsPath, path.join(tree, 'bin', 'keeper-functions.ps1'));
  const persona = 'keeper-adopt-probe-' + process.pid;
  const work = path.join(tree, 'work');
  const runDir = path.join(work, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  const log = path.join(runDir, 'keeper.log');
  const startedMarker = path.join(tree, 'stub-started');
  const launchMarker = path.join(tree, 'launched.txt');
  fs.writeFileSync(path.join(tree, 'bin', 'supervise.sh'), [
    '#!/bin/bash',
    'case " $* " in',
    '  *" --channel-name earlier-roster "*) ;;',
    '  *) echo launched >> "' + fwd(launchMarker) + '"; exit 130 ;;',
    'esac',
    'touch "' + fwd(startedMarker) + '"',
    'for i in $(seq 1 300); do',
    '  grep -q "ADOPT pid=" "' + fwd(log) + '" 2>/dev/null && exit 1',
    '  sleep 0.1',
    'done',
    'exit 99',
    '',
  ].join('\n'));
  const roster = path.join(tree, 'fleet.json');
  fs.writeFileSync(roster, JSON.stringify([{ name: persona, workdir: fwd(work), permissionMode: 'bypassPermissions', enabled: true }]));
  const envFile = path.join(tree, 'keeper.env');
  fs.writeFileSync(envFile, 'KEEPER_BASH_EXE=' + bashExe + '\n');

  // The live supervisor, spelled as the copied wrapper spells its launch, with a different channel
  // name after the three tokens the match reads.
  const stubPath = toBash(tree + '/bin/supervise.sh');
  const live = spawn(bashExe, [stubPath, toBash(work), persona, 'bypassPermissions', '--channel-name', 'earlier-roster'], { stdio: 'ignore' });
  try {
    waitForMarkers([startedMarker]);
    const r = runPs([path.join(tree, 'bin', 'Start-Persona.ps1'), '-Name', persona, '-Roster', roster, '-EnvFile', envFile, '-DelayScale', '0.0001']);
    assert.equal(r.status, 0, r.stderr);
    const lines = readText(log).split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.replace(/^\S+ /, ''));
    const adoptAt = lines.findIndex((l) => /^ADOPT pid=\d+$/.test(l));
    assert.ok(adoptAt >= 0, 'an ADOPT line: ' + lines.join('\n'));
    const decideAt = lines.findIndex((l) => l.startsWith('DECIDE '));
    assert.ok(decideAt > adoptAt, 'the DECIDE line follows the ADOPT line: ' + lines.join('\n'));
    // The adopted run's EXIT line names the process it waited on rather than a launch number.
    const adoptedPid = lines[adoptAt].slice('ADOPT pid='.length);
    assert.match(lines[decideAt - 1], new RegExp('^EXIT adopted pid=' + adoptedPid + ' code=1 uptime=\\d+$'), 'the EXIT line before the DECIDE: ' + lines.join('\n'));
    // Nothing was launched while the adopted supervisor lived: no LAUNCH line before its DECIDE.
    assert.equal(lines.slice(0, decideAt).filter((l) => l.startsWith('LAUNCH ')).length, 0, 'no LAUNCH before the DECIDE: ' + lines.join('\n'));
    const m = /^DECIDE exit=(-?\d+) uptime=(\d+) action=(\w+) delay=(\d+) reason=(.*)$/.exec(lines[decideAt]);
    assert.ok(m, 'DECIDE line has the contract shape: ' + lines[decideAt]);
    assert.equal(Number(m[1]), 1, 'the stub exit code reached the policy');
    const expected = runFunctions('ConvertTo-Json -InputObject ([pscustomobject](Get-KeeperDecision -ExitCode 1 -UptimeSeconds ' + m[2] + ' -PreviousDelaySeconds $script:KeeperBaseDelaySeconds -ConsecutiveExit1Count 0)) -Compress');
    assert.equal(m[3], expected.Action, 'action');
    assert.equal(Number(m[4]), expected.DelaySeconds, 'delay');
    assert.equal(m[5], expected.Reason, 'reason');
    // The exit-1 row relaunches, so exactly one launch follows, and it is launch 1: the adopted run
    // did not count as one.
    assert.equal(readText(launchMarker).split(/\r?\n/).filter((l) => l === 'launched').length, 1, 'one launch, after the DECIDE');
    assert.deepEqual(lines.filter((l) => l.startsWith('LAUNCH ')).map((l) => l.split(' ')[1]), ['1']);
    assert.equal(JSON.parse(readText(path.join(runDir, 'keeper.json'))).launchCount, 1, 'keeper.json counts the one launch');
  } finally {
    // A wrapper that adopted has already waited the stub out. One that did not leaves it running
    // toward its bound, and it is this suite's own process, so it is ended here.
    let alive = true;
    try { process.kill(live.pid, 0); } catch { alive = false; }
    if (alive) spawnSync('taskkill', ['/T', '/F', '/PID', String(live.pid)]);
  }
});

// ---------------------------------------------------------------------------------------------
// Open-KeeperLiveSupervisor's refusals, driven through the wrapper's own function text. The
// wrapper runs its loop when invoked, so the functions and the constants they read are lifted out
// of it by the PowerShell parser rather than dot-sourced. Get-CimInstance and Start-Sleep are
// replaced by functions that serve records built here and count the calls, so no case reads the
// machine's process list or waits the watch interval out. Each filtered read serves the next entry
// of filterDates, where 'throw' is a read that fails and a read past the list finds no record. A
// handle that cannot be opened is a process id no process holds, which GetProcessById refuses. A
// handle that opens is this driver's own process, whose start time the case knows.
// ---------------------------------------------------------------------------------------------
function runOpenCase(recordDate, filterDates, pid) {
  const log = path.join(tmp, 'open-' + (driverCount + 1) + '.log');
  return runFunctions(`
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${wrapperPath}', [ref]$null, [ref]$null)
foreach ($s in $ast.EndBlock.Statements) {
  if ($s -is [System.Management.Automation.Language.AssignmentStatementAst] -and @('$script:AdoptStartToleranceSeconds', '$script:AdoptWatchSeconds', '$script:Utf8NoBom', '$script:LogCapBytes') -contains $s.Left.Extent.Text) { . ([scriptblock]::Create($s.Extent.Text)) }
}
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if (@('Write-KeeperLog', 'Open-KeeperLiveSupervisor', 'Watch-KeeperUnopenedSupervisor', 'Test-KeeperSupervisorRecord') -contains $f.Name) { . ([scriptblock]::Create($f.Extent.Text)) }
}
$script:LogPath = '${log}'
$self = (Get-Process -Id $PID).StartTime
$targetId = ${pid === 'self' ? '$PID' : pid}
$dateOf = { param($offset) if ($null -eq $offset) { $null } elseif ($offset -eq 'self') { $self } else { $self.AddSeconds([double]$offset) } }
$script:recordDate = & $dateOf ${recordDate === null ? '$null' : "'" + recordDate + "'"}
$script:filterDates = @(${filterDates.map((d) => (d === null ? '$null' : "'" + d + "'")).join(', ')})
$script:scans = 0; $script:filters = 0; $script:sleeps = @()
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$ClassName, [string[]]$Property, [string]$Filter)
  if ($Filter) {
    $n = $script:filters; $script:filters++
    if ($Filter -ne "ProcessId=$targetId") { throw "unexpected filter $Filter" }
    if ($n -lt $script:filterDates.Count -and $script:filterDates[$n] -eq 'throw') { throw 'stub filtered read failed' }
    if ($n -lt $script:filterDates.Count) { [pscustomobject]@{ ProcessId = $targetId; CreationDate = (& $dateOf $script:filterDates[$n]) } }
    return
  }
  $n = $script:scans; $script:scans++
  if ($n -eq 0) {
    [pscustomobject]@{ ProcessId = $targetId; ParentProcessId = 1; CreationDate = $script:recordDate; CommandLine = '"C:\\Program Files\\Git\\bin\\bash.exe" /x/sup.sh /x/work open-probe bypassPermissions' }
  }
}
function Start-Sleep { param([double]$Seconds) $script:sleeps += $Seconds }
$r = Open-KeeperLiveSupervisor -Executable 'C:/Program Files/Git/bin/bash.exe' -Arguments @('/x/sup.sh', '/x/work', 'open-probe', 'bypassPermissions')
$got = $null
if ($null -ne $r) { $got = $r.ProcessId; $r.Process.Dispose() }
$lines = @()
if (Test-Path -LiteralPath $script:LogPath) { $lines = @(Get-Content -LiteralPath $script:LogPath | ForEach-Object { $_ -replace '^\\S+ ', '' }) }
ConvertTo-Json -InputObject @{ pid = $got; self = $PID; target = $targetId; log = $lines; sleeps = @($script:sleeps); scans = $script:scans; filters = $script:filters } -Compress -Depth 3
`);
}

test('adopt: a matching record with no start time is no match, in one line, and the wrapper launches', () => {
  const r = runOpenCase(null, [], 'self');
  assert.equal(r.pid, null, 'nothing opened');
  assert.deepEqual(r.log, ['ADOPT skipped pid=' + r.self + ': its process record carries no start time']);
});

test('adopt: an opened match whose record carries another start time on the second read is another process under the id, and no match', () => {
  const r = runOpenCase('self', ['3600'], 'self');
  assert.equal(r.pid, null, 'nothing opened');
  assert.equal(r.log.length, 1, 'one line: ' + r.log.join('\n'));
  assert.match(r.log[0], new RegExp('^ADOPT skipped pid=' + r.self + ': its process record changed after the scan'));
  assert.equal(r.filters, 1, 'one second read');
  assert.equal(r.scans, 1, 'no second scan');
});

test('adopt: an opened match whose record is gone on the second read is no match', () => {
  const r = runOpenCase('self', [], 'self');
  assert.equal(r.pid, null, 'nothing opened');
  assert.equal(r.log.length, 1, 'one line: ' + r.log.join('\n'));
  assert.match(r.log[0], new RegExp('^ADOPT skipped pid=' + r.self + ': its process record changed after the scan'));
});

test('adopt: an opened match whose second read carries no start time is no match', () => {
  const r = runOpenCase('self', [null], 'self');
  assert.equal(r.pid, null, 'nothing opened');
  assert.equal(r.log.length, 1, 'one line: ' + r.log.join('\n'));
  assert.match(r.log[0], new RegExp('^ADOPT skipped pid=' + r.self + ': its process record changed after the scan'));
  assert.equal(r.filters, 1, 'one second read');
});

test('adopt: the same live process with its record\'s start time on both reads is opened, the control for the start-time cases', () => {
  const r = runOpenCase('self', ['self'], 'self');
  assert.equal(r.pid, r.self, 'this driver\'s own process opened: ' + r.log.join('\n'));
  assert.deepEqual(r.log, []);
  assert.equal(r.filters, 1, 'one second read');
});

test('adopt: a process whose own start time is an hour off two agreeing reads of its record is adopted, as across a daylight-saving change', () => {
  const r = runOpenCase('3600', ['3600'], 'self');
  assert.equal(r.pid, r.self, 'opened, since only the two record reads are compared: ' + r.log.join('\n'));
  assert.deepEqual(r.log, []);
});

test('adopt: an opened match whose second read fails is adopted rather than launched beside, with one SCAN failed line', () => {
  const r = runOpenCase('self', ['throw'], 'self');
  assert.equal(r.pid, r.self, 'opened: ' + r.log.join('\n'));
  assert.deepEqual(r.log, ['SCAN failed: stub filtered read failed']);
  assert.equal(r.filters, 1, 'the second read was made');
});

test('adopt: a live match whose handle cannot be opened is watched until its record goes, then the list is scanned again', () => {
  const r = runOpenCase('0', ['0', '0'], 2147483644);
  assert.equal(r.pid, null, 'nothing opened, so the wrapper launches');
  assert.equal(r.log.length, 2, 'two lines: ' + r.log.join('\n'));
  assert.match(r.log[0], /^ADOPT watching pid=2147483644 without a handle: .+/);
  assert.equal(r.log[1], 'ADOPT ended pid=2147483644, exit code unreadable');
  assert.deepEqual(r.sleeps, [10, 10], 'the record is read again every ten seconds');
  assert.equal(r.filters, 3, 'the confirming read, the read still present, the read gone');
  assert.equal(r.scans, 2, 'the list is scanned again after the watch');
});

test('adopt: an unopenable match whose record carries another start time on the second read is no match, and nothing is watched', () => {
  const r = runOpenCase('0', ['3600'], 2147483644);
  assert.equal(r.pid, null, 'nothing opened');
  assert.equal(r.log.length, 1, 'one line: ' + r.log.join('\n'));
  assert.match(r.log[0], /^ADOPT failed pid=2147483644: .+/);
  assert.deepEqual(r.sleeps, []);
  assert.equal(r.scans, 1, 'no second scan');
});

test('adopt: an unopenable match whose second read fails is watched rather than launched beside', () => {
  const r = runOpenCase('0', ['throw'], 2147483644);
  assert.equal(r.pid, null, 'nothing opened, so the wrapper launches once the watch ends');
  assert.equal(r.log.length, 3, 'three lines: ' + r.log.join('\n'));
  assert.equal(r.log[0], 'SCAN failed: stub filtered read failed');
  assert.match(r.log[1], /^ADOPT watching pid=2147483644 without a handle: .+/);
  assert.equal(r.log[2], 'ADOPT ended pid=2147483644, exit code unreadable');
  assert.ok(!r.log.some((l) => l.startsWith('ADOPT failed')), 'no ADOPT failed line');
  assert.deepEqual(r.sleeps, [10], 'one sleep, then the read showing the record gone');
  assert.equal(r.filters, 2);
  assert.equal(r.scans, 2, 'the list is scanned again after the watch');
});

test('adopt: a read that fails during the watch keeps the watch going, and it ends on the next read showing the record gone', () => {
  const r = runOpenCase('0', ['0', 'throw'], 2147483644);
  assert.equal(r.pid, null, 'nothing opened');
  assert.equal(r.log.length, 3, 'three lines: ' + r.log.join('\n'));
  assert.match(r.log[0], /^ADOPT watching pid=2147483644 without a handle: .+/);
  assert.equal(r.log[1], 'SCAN failed: stub filtered read failed');
  assert.equal(r.log[2], 'ADOPT ended pid=2147483644, exit code unreadable');
  assert.deepEqual(r.sleeps, [10, 10], 'the watch slept again after the failed read');
  assert.equal(r.filters, 3, 'the confirming read, the failed read, the read gone');
  assert.equal(r.scans, 2);
});

// ---------------------------------------------------------------------------------------------
// The probe runs the executable the env file names.
// ---------------------------------------------------------------------------------------------
function probeLines(outFile) {
  const lines = readText(outFile).split(/\r?\n/).filter((l) => l.length > 0);
  return (key) => lines.filter((l) => l.startsWith(key + '=')).map((l) => l.slice(key.length + 1));
}

test("probe: the env file's bash runs the toolchain probes", () => {
  const sc = makeScenario({ codes: [5] });
  const outFile = path.join(sc.dir, 'probe.txt');
  const r = runPs([probePath, '-OutFile', outFile, '-EnvFile', sc.envFile]);
  assert.equal(r.status, 0, r.stderr);
  const get = probeLines(outFile);
  assert.equal(get('bash.exit')[0], '5', 'the stub ran and its planned code was recorded');
  assert.equal(readText(sc.codesFile), '', 'the stub consumed its code');
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
