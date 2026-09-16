#!/usr/bin/env node
// Test for bin/Register-PersonaTasks.ps1.
// Run: node .kit/keeper-register-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Drives the real powershell.exe with spawnSync, always on a .ps1 file this suite composes in a
// temp directory and runs with -File, so no -Command string ever carries a double quote through a
// shell. A run of the registration script is composed as that script run with & and its arguments
// as PowerShell literals. The elevation, disabled, absent and -Prune cases dot-source the script
// and call Register-PersonaTasks or Get-PersonaTaskDefinitions directly, so a hashtable or a
// PowerShell array literal never has to cross a command line.
//
// Nothing in this suite may write to the Task Scheduler service, which on this box holds real
// state. The guard is keyed on the hazard's own source of truth, the ScheduledTasks module's export
// list, rather than on any text this suite or the registration script carries, so an export the
// module gains is covered without anyone naming it:
//
//   1. At suite start the export list is read from the real Windows PowerShell 5.1, and every
//      export is classified by its verb: New builds in memory and stays real, Get and Export read
//      the service, and every other listed verb writes to it. An export whose verb no class lists
//      fails the classification pin.
//   2. runPowerShell is the only spawner, and it composes every file it spawns itself: the shadow
//      prefix first, then the caller's lines or the registration script run with &. The prefix
//      defines a recording stub for every export that reaches the service (the reads stay real only
//      in a spawn that declares realReads), then checks inside the spawned engine that each stub is
//      what command resolution returns, and exits 97 before any caller line runs if one is not.
//      Shadowing is therefore a property of every spawn, whatever the spawn names or calls.
//   3. runPowerShell refuses, before spawning, a request whose text or the registration script's
//      text calls an export module-qualified or defines or removes a function named for one, since
//      either would route past a stub, and a registration run carrying neither -WhatIf nor a scratch
//      -Roster and -EnvFile pair. The refusals and the self-check failures are asserted empty at the
//      end.
//
// Case 2 (the real script run without -WhatIf) reads the session's own elevation state at run
// time and only runs when that session is unelevated, and points at a roster whose every entry is
// disabled, so the path past a regressed elevation guard builds no definition to register. The
// suite's own control proves the wildcard-read instrument functions:
// Get-ScheduledTask, read through the same AgentPersona-*-shaped wildcard form the suite trusts,
// returns at least one object for a real task's own name, read off this box's live scheduler by
// the same picker, so the pattern's own literal names the instance it is tested against. It says
// nothing about whether an AgentPersona-* task this suite failed to clean up would be seen: the
// before/after counts are scoped to -TaskPath '\', so a task filed in another folder reads as a
// clean zero.

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
// The bare-drive-root case below needs a drive that exists on this box, since Join-Path on a
// nonexistent drive throws before the trailing-separator guard it targets ever runs; the
// repository's own drive letter is always mounted here.
const repoRootDrive = repoRoot.match(/^[A-Za-z]:/)[0];
const scriptPath = join(repoRoot, 'bin', 'Register-PersonaTasks.ps1');
// The spawn guard matches on this as well as on the full path, so a spawn or a scratch script that
// names the script through another spelling of its path is still classified as reaching it.
const scriptFileName = 'Register-PersonaTasks.ps1';
const fixtureRoster = join(repoRoot, '.kit', 'fixtures', 'fleet.fixture.json');

const scratchDir = mkdtempSync(join(tmpdir(), 'keeper-register-test-'));
// A setup abort (process.exit(1)) or an uncaught throw outside record() would otherwise skip a
// cleanup call placed at the bottom of this file, leaving the scratch directory on disk.
// Registering the removal on 'exit' instead means it runs on every exit path node has: a normal
// fall-through to the bottom of the file, an explicit process.exit() anywhere above, and node's
// own default handling of an exception nothing here caught.
process.on('exit', () => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch (e) {
    console.error('cleanup: could not remove ' + scratchDir + ': ' + e.message);
  }
});
const scratchEnvFile = join(scratchDir, 'keeper.env');
// Register-PersonaTasks.ps1 refuses to build a definition whose env file does not exist, so every
// case below that only cares about the roster or the path-safety guards needs a real, if empty,
// file at this path.
writeFileSync(scratchEnvFile, '', 'utf8');

// The hazard's source of truth is the ScheduledTasks module's own export list, read from the real
// Windows PowerShell 5.1 at suite start (MODULE_EXPORT_READ_LINES below), never written here and
// never derived from the registration script's text. Each export is classified by its verb alone,
// under one rule:
//
//   New                         builds a CIM object in memory and contacts no service. Left real,
//                               so the definitions the suite reads back field by field are the
//                               module's own objects rather than the suite's literals.
//   Get, Export                 read the Task Scheduler service and change nothing. Shadowed by
//                               default; left real only in a spawn that declares realReads, which
//                               is how the before-and-after count reads the live scheduler.
//   Register, Unregister, Set,  change registered task state. Shadowed in every spawn, and no
//   Enable, Disable, Start,     request option leaves one real.
//   Stop
//
// An export whose verb none of the three lists is shadowed in every spawn exactly like a write, and
// the classification pin fails the suite naming it, so a verb the module gains gets a decision
// rather than a silent default.
const SCHEDULER_MODULE = 'ScheduledTasks';
const IN_MEMORY_BUILDER_VERBS = ['New'];
const SERVICE_READ_VERBS = ['Get', 'Export'];
const SERVICE_WRITE_VERBS = ['Register', 'Unregister', 'Set', 'Enable', 'Disable', 'Start', 'Stop'];

function classifySchedulerExport(name) {
  const verb = name.slice(0, name.indexOf('-'));
  if (IN_MEMORY_BUILDER_VERBS.includes(verb)) return 'in-memory builder';
  if (SERVICE_READ_VERBS.includes(verb)) return 'service read';
  if (SERVICE_WRITE_VERBS.includes(verb)) return 'service write';
  return 'unclassified';
}

// The exports a spawn shadows: every one but the in-memory builders, less the service reads when
// the spawn declares realReads. An unclassified export is always in this set.
function shadowedSchedulerExports(exports, realReads) {
  return exports.filter((name) => {
    const verdict = classifySchedulerExport(name);
    if (verdict === 'in-memory builder') return false;
    return !(verdict === 'service read' && realReads);
  });
}

// The one spawn that carries no shadow prefix, because its output is what the prefix is built
// from. It lists the exports and invokes none of them.
const MODULE_EXPORT_READ_LINES = [
  "$ErrorActionPreference = 'Stop'",
  `Import-Module ${SCHEDULER_MODULE}`,
  "Write-Output ('PSVERSION=' + $PSVersionTable.PSVersion.Major)",
  `Get-Command -Module ${SCHEDULER_MODULE} | ForEach-Object { Write-Output ('EXPORT=' + $_.Name) }`,
];

// Every stub's body carries this comment, and the self-check below tells a stub from any other
// function of the same name by it.
const STUB_MARKER = 'keeper-suite-stub';

// The lines every spawn but the export read begins with, composed from an export list.
//
// Import-Module runs first, so no auto-import happens partway through a case. Each stub is a
// function in the spawned file's script scope, which command resolution reaches before the module's
// own global-scope function. Each records its call into one global list rather than a `$script:`
// one, because `$script:` inside a stub called from a script run with `&` names that script's scope
// and reads as null there; `$script:Calls` in the spawned file is bound to the same list, so a case
// reads what was called rather than what was printed. The stubs declare no [CmdletBinding()], so a
// named argument a stub does not declare lands in $args and still reaches nothing.
//
// The self-check closes the prefix. Every shadowed export must resolve, from the spawned file's own
// scope, to a function carrying the stub marker, and every export left real must resolve to the
// module itself. A spawn where either fails names the export on stderr and exits 97 before any
// caller line runs.
function schedulerShadowLines(exports, { realReads = false, getScheduledTaskReturn = ['    return @()'] } = {}) {
  const shadowed = shadowedSchedulerExports(exports, realReads);
  const real = exports.filter((name) => !shadowed.includes(name));
  const quotedList = (names) => '@(' + names.map((name) => `'${name}'`).join(', ') + ')';
  const lines = [
    `Import-Module ${SCHEDULER_MODULE} -ErrorAction Stop`,
    '$global:KeeperSuiteCalls = New-Object System.Collections.Generic.List[string]',
    '$script:Calls = $global:KeeperSuiteCalls',
  ];
  for (const name of shadowed) {
    const noun = name.slice(name.indexOf('-') + 1);
    // The bare verb for the ScheduledTask noun, which the cases assert on; the whole name for any
    // other noun, so Register-ClusteredScheduledTask never records as REGISTER.
    const label = noun === 'ScheduledTask' ? name.slice(0, name.indexOf('-')).toUpperCase() : name.toUpperCase();
    lines.push(`function ${name} {`, `    # ${STUB_MARKER}`);
    if (name === 'Get-ScheduledTask') {
      lines.push(
        '    param($TaskName, $TaskPath, $ErrorAction)',
        `    $global:KeeperSuiteCalls.Add("${label} TaskName=$TaskName TaskPath=$TaskPath")`,
        ...getScheduledTaskReturn
      );
    } else {
      lines.push(
        '    param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, [switch]$Confirm)',
        `    $global:KeeperSuiteCalls.Add("${label} TaskName=$TaskName TaskPath=$TaskPath")`
      );
    }
    lines.push('}');
  }
  lines.push(
    `foreach ($name in ${quotedList(shadowed)}) {`,
    "    $resolved = $ExecutionContext.InvokeCommand.GetCommand($name, 'All')",
    `    if ($null -eq $resolved -or $resolved.CommandType -ne 'Function' -or $resolved.Definition -notmatch '${STUB_MARKER}') {`,
    '        [Console]::Error.WriteLine("keeper suite shadow check: $name does not resolve to a suite stub")',
    '        exit 97',
    '    }',
    '}',
    `foreach ($name in ${quotedList(real)}) {`,
    "    $resolved = $ExecutionContext.InvokeCommand.GetCommand($name, 'All')",
    `    if ($null -eq $resolved -or $resolved.ModuleName -ne '${SCHEDULER_MODULE}') {`,
    `        [Console]::Error.WriteLine("keeper suite shadow check: $name does not resolve to the ${SCHEDULER_MODULE} module")`,
    '        exit 97',
    '    }',
    '}'
  );
  return lines;
}

// A path is scratch when it sits under the suite's own temp directory or under the repository's
// fixtures directory. Those are the two roots the suite writes and owns; the roster and env file
// the script's param block defaults to are the operator's real fleet paths and are neither.
const scratchPathRoots = [scratchDir, join(repoRoot, '.kit', 'fixtures')].map((root) => resolve(root).toLowerCase());
function isScratchPath(value) {
  const full = resolve(value).toLowerCase();
  return scratchPathRoots.some((root) => full.startsWith(root));
}

function namedArgValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

// Every spawn this suite makes, with what the guard classified it as. The list is the evidence the
// guard visited the whole family, and the pin at the end of the file asserts it holds no refusal.
const qualifiedPowerShellExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The shape the qualified-path pin matches: spawnSync called with a quoted string as its
// executable. Built from parts so this line is not itself an instance of what it searches for.
const SPAWN_LITERAL_SHAPE = new RegExp('spawnSync' + '\\(\\s*([\'"`])([^\'"`]*)\\1', 'g');
const spawnClassifications = [];

// The module's export list, filled from the export read below before any other spawn is made. A
// request that arrives while it is empty is refused, since nothing could be shadowed.
let schedulerExports = [];

// Every spawn is one of three requests, and runPowerShell composes the file it spawns from the
// request, so no caller hands it a file or an argument list to run as given:
//
//   { kind: 'module export read' }   MODULE_EXPORT_READ_LINES, the one spawn with no shadow prefix.
//   { kind: 'script', lines }        the shadow prefix, then the caller's lines.
//   { kind: 'registration', args }   the shadow prefix, then the registration script run with & and
//                                    args, so its own top-level body runs as it does for an operator.
//
// A script or registration request may also carry realReads (the service reads stay real),
// getScheduledTaskReturn (the Get-ScheduledTask stub's return lines) and exports (a superset of the
// module's list, which the derivation's own control uses to add a name the module does not export).

// A module-qualified call resolves to the module's own function and never to a stub.
const MODULE_QUALIFIED_SHAPE = new RegExp('\\b' + SCHEDULER_MODULE + '\\\\', 'i');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Decides whether a request may be spawned at all. Two things route past a stub whatever the prefix
// does, so each is refused in the caller's text and in the registration script's own text: a
// module-qualified call, and a function defined, or a function: drive item named, for an export.
// A registration run also keeps the rule it carried before shadowing existed: it runs the script's
// top-level body, so it must carry -WhatIf or a scratch -Roster and -EnvFile pair, which keeps the
// fleet paths its param block defaults to out of reach.
function classifySpawnRequest(request) {
  if (request.kind === 'module export read') {
    return { family: 'module export read', allowed: true, reason: 'fixed lines that list the module exports and invoke none' };
  }
  const family = request.kind === 'registration' ? 'registration script' : 'script';
  const exports = request.exports || schedulerExports;
  if (schedulerExports.length === 0) {
    return { family, allowed: false, reason: 'the module export list was not read, so no export could be shadowed' };
  }
  const droppedExports = schedulerExports.filter((name) => !exports.includes(name));
  if (droppedExports.length > 0) {
    return { family, allowed: false, reason: 'the request\'s export list drops module exports: ' + droppedExports.join(', ') };
  }
  const callerText = request.kind === 'registration' ? request.args.join(' ') : request.lines.join('\n');
  for (const [where, text] of [['the request', callerText], [scriptFileName, readFileSync(scriptPath, 'utf8')]]) {
    if (MODULE_QUALIFIED_SHAPE.test(text)) {
      return { family, allowed: false, reason: `${where} calls a ${SCHEDULER_MODULE} command module-qualified, which resolves past any stub` };
    }
    const redefined = exports.filter((name) =>
      new RegExp('(\\bfunction\\s+(global:|script:|local:)?|function:\\\\?)' + escapeRegExp(name) + '\\b', 'i').test(text)
    );
    if (redefined.length > 0) {
      return { family, allowed: false, reason: `${where} defines or names a function: item for ${redefined.join(', ')}, which would unshadow it` };
    }
  }
  const shadowCount = shadowedSchedulerExports(exports, request.realReads).length;
  const shadowReason = `shadows ${shadowCount} of ${exports.length} module exports` + (request.realReads ? ', service reads left real' : '');
  if (request.kind === 'registration') {
    if (request.args.includes('-WhatIf')) {
      return { family, allowed: true, reason: shadowReason + '; carries -WhatIf' };
    }
    const roster = namedArgValue(request.args, '-Roster');
    const envFile = namedArgValue(request.args, '-EnvFile');
    if (!(roster && envFile && isScratchPath(roster) && isScratchPath(envFile))) {
      return {
        family,
        allowed: false,
        reason:
          'carries neither -WhatIf nor a scratch -Roster and -EnvFile pair, so its registration ' +
          'path would run against the fleet paths the param block defaults to',
      };
    }
    return { family, allowed: true, reason: shadowReason + '; carries a scratch -Roster and -EnvFile pair' };
  }
  return { family, allowed: true, reason: shadowReason };
}

// Shortens a request for the classification report: the two long absolute roots the suite works
// under become tokens, so a reader sees which flags a spawn carried.
function describeSpawnRequest(request) {
  let text;
  if (request.kind === 'registration') {
    text = request.args.join(' ');
  } else if (request.kind === 'script') {
    const body = request.lines.join('\n');
    text = `${request.lines.length} caller lines` + (body.includes(scriptFileName) ? ', dot-sourcing the registration script' : '');
  } else {
    text = 'fixed lines';
  }
  return text.split(scratchDir).join('<scratch>').split(repoRoot).join('<repo>');
}

// The registration script run with &, which is how an operator runs it from a console. Stop makes a
// binding error at the & call terminating, so the catch turns it into exit 1 with the message on
// stderr, as a -File run would, rather than a reported error and exit 0. The script's own exit code
// reaches the process through $LASTEXITCODE. A value is passed as a double-quoted literal; a
// parameter name is passed bare.
function registrationLines(args) {
  const tokens = args.map((arg) => (/^-[A-Za-z][A-Za-z0-9]*$/.test(arg) ? arg : psStringLiteral(arg)));
  return [
    "$ErrorActionPreference = 'Stop'",
    '$global:LASTEXITCODE = 0',
    'try {',
    `    & ${psStringLiteral(scriptPath)} ${tokens.join(' ')}`,
    '} catch {',
    '    [Console]::Error.WriteLine($_.Exception.Message)',
    '    exit 1',
    '}',
    'exit $LASTEXITCODE',
  ];
}

let spawnCounter = 0;
function runPowerShell(request) {
  const classification = classifySpawnRequest(request);
  const entry = { description: describeSpawnRequest(request), ...classification, status: null, shadowCheckFailed: false };
  spawnClassifications.push(entry);
  if (!classification.allowed) {
    // Refused rather than reported: a spawn the guard cannot clear never runs, so the guard
    // prevents the scheduler write instead of noticing it afterward. The synthetic result fails
    // whichever case made the call, and the pin at the end of the file names every refusal.
    return {
      status: 99,
      stdout: '',
      stderr: 'the suite spawn guard refused this spawn: ' + classification.reason,
      signal: null,
    };
  }
  let body;
  if (request.kind === 'module export read') {
    body = MODULE_EXPORT_READ_LINES;
  } else {
    const prefix = schedulerShadowLines(request.exports || schedulerExports, request);
    body = [...prefix, ...(request.kind === 'registration' ? registrationLines(request.args) : request.lines)];
  }
  const file = join(scratchDir, `spawn-${spawnCounter++}.ps1`);
  writeFileSync(file, body.join('\n'), 'utf8');
  // Spawned by its fully qualified path rather than by bare name. On Windows a bare command name
  // is resolved against the spawning process's working directory before the system PATH, and the
  // variable that suppresses that is read from the spawning process rather than from the child, so
  // passing it in the child environment would not help. The script under test pins the same
  // qualified path into the task action for the same reason.
  const result = spawnSync(qualifiedPowerShellExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
    encoding: 'utf8',
  });
  entry.status = result.status;
  entry.shadowCheckFailed = result.status === 97 && /keeper suite shadow check:/.test(result.stderr || '');
  entry.expectShadowCheckFailure = Boolean(request.expectShadowCheckFailure);
  return result;
}

let scratchCounter = 0;
function runScratchScript(lines, options = {}) {
  return runPowerShell({ kind: 'script', lines, ...options });
}

function runRegistrationScript(args) {
  return runPowerShell({ kind: 'registration', args });
}

// The export list is read before anything else is spawned, and the suite stops here when it cannot
// be read cleanly from Windows PowerShell 5.1, because every later spawn is shadowed from it.
const exportReadResult = runPowerShell({ kind: 'module export read' });
const exportReadLines = (exportReadResult.stdout || '').split(/\r?\n/).map((l) => l.trim());
const schedulerModulePsMajor = (exportReadLines.find((l) => l.startsWith('PSVERSION=')) || '').slice('PSVERSION='.length);
const exportsRead = exportReadLines.filter((l) => l.startsWith('EXPORT=')).map((l) => l.slice('EXPORT='.length));
const malformedExports = exportsRead.filter((name) => !/^[A-Za-z][A-Za-z0-9]*-[A-Za-z][A-Za-z0-9]*$/.test(name));
if (exportReadResult.status !== 0 || schedulerModulePsMajor !== '5' || exportsRead.length === 0 || malformedExports.length > 0) {
  console.error(
    'setup: the ' + SCHEDULER_MODULE + ' export list could not be read cleanly from Windows PowerShell 5.1. exit=' +
      exportReadResult.status + ' psMajor=' + JSON.stringify(schedulerModulePsMajor) + ' exports=' + JSON.stringify(exportsRead) +
      ' stderr=' + JSON.stringify(exportReadResult.stderr)
  );
  process.exit(1);
}
schedulerExports = exportsRead;

// A scratch checkout the cases below point -RepoRoot at: Register-PersonaTasks needs
// bin/Start-Persona.ps1 to exist under -RepoRoot, since that path is embedded in the task action
// and its absence is refused before a task is built.
const stubRepoRoot = join(scratchDir, 'stub-repo');
const stubRepoBin = join(stubRepoRoot, 'bin');
mkdirSync(stubRepoBin, { recursive: true });
writeFileSync(join(stubRepoBin, 'Start-Persona.ps1'), '# stub', 'utf8');

// A roster-shaped file at a path outside the repository tree: it parses to valid entries so a
// case that runs the full script gets past Read-PersonaRoster, and no case below asserts on which
// entries it holds.
const stubRoster = join(scratchDir, 'stub-fleet.json');
writeFileSync(stubRoster, readFileSync(fixtureRoster, 'utf8'), 'utf8');

// Builds a PowerShell double-quoted string literal for a value that may itself carry a character
// special to a double-quoted string, or to the line-based .ps1 file it gets embedded in: a literal
// newline becomes the backtick-n escape so the file's own line structure survives, and a literal
// double quote, backtick or dollar sign is escaped with a backtick.
function psStringLiteral(value) {
  const escaped = value
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\r/g, '`r')
    .replace(/\n/g, '`n');
  return '"' + escaped + '"';
}

// -TaskPath '\' matches the scope the script itself pins on every scheduler read and write, so
// this instrument reads the same universe the script does rather than a superset that would hide
// a TaskPath regression in the script from every count taken through this function. It declares
// realReads, since a count read through the Get-ScheduledTask stub would be zero on every box; the
// service writes stay shadowed in this spawn as in every other.
function countScheduledTasks(namePattern) {
  const result = runScratchScript(
    [`Write-Output @(Get-ScheduledTask -TaskName ${psStringLiteral(namePattern)} -TaskPath '\\' -ErrorAction SilentlyContinue).Count`],
    { realReads: true }
  );
  return parseInt(result.stdout.trim(), 10);
}

// Reads one real root-level task name off this box's own scheduler at run time, rather than
// naming one, so the control travels with whatever machine the suite runs on. Restricted to a
// safe character class (no '*', '?', '[' or ']') so the wildcard built from it below by appending
// '*' cannot have a metacharacter of the picked name's own collide with the appended one; a name
// carrying one of those, matched against the wildcard count above (also scoped to TaskPath '\'),
// would otherwise make the control read a false zero on an otherwise healthy box.
function pickExistingTaskName() {
  const result = runScratchScript(
    [
      "Write-Output (Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -match '^[A-Za-z0-9_.-]+$' } | " +
        'Select-Object -First 1 -ExpandProperty TaskName)',
    ],
    { realReads: true }
  );
  return result.stdout.trim();
}

function isSessionElevated() {
  const result = runScratchScript([`. "${scriptPath}"`, 'Write-Output (Test-IsElevated)']);
  const stdout = result.stdout.trim();
  if (result.status !== 0 || (stdout !== 'True' && stdout !== 'False')) {
    // A failed probe (a dot-source error, empty or garbled stdout) must never fall through to
    // "unelevated": in an actually elevated session that fallthrough would run case 2's real
    // script without -WhatIf, registering real AgentPersona-* tasks against the fixture roster.
    // An unrequested registration is the destructive failure this section's own Tests line names,
    // so a probe that cannot be read cleanly aborts the whole suite instead of guessing.
    console.error(
      'isSessionElevated: the elevation probe did not return a clean True/False. exit=' +
        result.status + ' stdout=' + JSON.stringify(result.stdout) + ' stderr=' + JSON.stringify(result.stderr)
    );
    process.exit(1);
  }
  return stdout === 'True';
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

// The qualified path the script pins -Execute to, so the task engine resolves the exact binary
// at every boot rather than searching PATH for a bare 'powershell.exe'.

// The default -User value, read the same way the script's own param block computes it
// ([Security.Principal.WindowsIdentity]::GetCurrent().Name), so a case that never overrides -User
// carries the account this session actually runs as rather than a guessed or hardcoded name.
function currentIdentityName() {
  const result = runScratchScript(['Write-Output ([Security.Principal.WindowsIdentity]::GetCurrent().Name)']);
  return result.stdout.trim();
}
const defaultUser = currentIdentityName();

function assertDefinitionFields(fields, name, rosterPath, envFilePath) {
  const action = fields['action'];
  assert.ok(action.startsWith(qualifiedPowerShellExe + ' '), `action's Execute is the qualified powershell.exe path: ${action}`);
  assert.ok(action.includes(`-Name ${name} `) || action.endsWith(`-Name ${name}`), `action names -Name ${name}: ${action}`);
  assert.ok(action.includes('Start-Persona.ps1'), `action names Start-Persona.ps1: ${action}`);
  assert.ok(action.includes(`"${resolve(rosterPath)}"`), `action carries the absolute roster path: ${action}`);
  assert.ok(action.includes(`"${resolve(envFilePath)}"`), `action carries the absolute env path: ${action}`);
  assert.equal(fields['trigger'], 'MSFT_TaskBootTrigger', 'trigger class');
  assert.equal(fields['account'], defaultUser, 'account');
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
let skipped = 0;
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
function skip(name, reason) {
  console.log('SKIP: ' + name + ': ' + reason);
  skipped++;
}

record('the ScheduledTasks export list was read from Windows PowerShell 5.1 before any other spawn', () => {
  assert.equal(schedulerModulePsMajor, '5', 'PowerShell major version of the export read');
  assert.ok(schedulerExports.length > 0, 'exports read: ' + JSON.stringify(schedulerExports));
  assert.equal(spawnClassifications[0].family, 'module export read', 'the first spawn this suite made');
});

function unclassifiedExports(exports) {
  return exports.filter((name) => classifySchedulerExport(name) === 'unclassified');
}

// Structural pin: every export the module has on this box falls in a verb class. An unclassified
// export is still shadowed in every spawn, and this is what makes it loud rather than silent.
record('structural pin: every ScheduledTasks module export is classified by its verb', () => {
  const unclassified = unclassifiedExports(schedulerExports);
  assert.deepEqual(unclassified, [], 'module exports whose verb no class lists: ' + unclassified.join(', '));
});

// Structural pin, measured inside the engine rather than read off the composed text: in a spawned
// PowerShell, every module export resolves to where its class says. The service exports resolve to
// a suite stub and the in-memory builders to the module, and under realReads the service reads
// resolve to the module while the writes stay stubs.
function readExportResolutions(options) {
  const quoted = '@(' + schedulerExports.map((name) => `'${name}'`).join(', ') + ')';
  const result = runScratchScript(
    [
      `foreach ($name in ${quoted}) {`,
      "    $resolved = $ExecutionContext.InvokeCommand.GetCommand($name, 'All')",
      "    $where = 'other'",
      "    if ($null -eq $resolved) { $where = 'unresolved' }",
      `    elseif ($resolved.Definition -match '${STUB_MARKER}') { $where = 'stub' }`,
      `    elseif ($resolved.ModuleName -eq '${SCHEDULER_MODULE}') { $where = 'module' }`,
      '    Write-Output ("RESOLVES " + $name + " " + $where)',
      '}',
    ],
    options
  );
  const resolutions = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^RESOLVES (\S+) (\S+)$/);
    if (match) resolutions.set(match[1], match[2]);
  }
  return { result, resolutions };
}

for (const [label, options] of [['by default', {}], ['under realReads', { realReads: true }]]) {
  const { result, resolutions } = readExportResolutions(options);
  record(`structural pin: in a spawned PowerShell, every module export resolves where its class says, ${label}`, () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const shadowed = shadowedSchedulerExports(schedulerExports, Boolean(options.realReads));
    const wrong = schedulerExports
      .map((name) => [name, shadowed.includes(name) ? 'stub' : 'module', resolutions.get(name)])
      .filter(([, expected, actual]) => expected !== actual)
      .map(([name, expected, actual]) => `${name} expected ${expected}, resolved ${actual}`);
    assert.deepEqual(wrong, [], 'exports resolving outside their class');
  });
}

// Controls for the derivation, each built on export names generated at run time, so no literal in
// this file names them and neither the classifier nor the composer can have been handed them. One
// carries a verb a class lists and a noun the module has never exported; the other carries a verb
// no class lists.
{
  const withheldSuffix = randomBytes(4).toString('hex');
  const writeVerb = SERVICE_WRITE_VERBS[randomBytes(1)[0] % SERVICE_WRITE_VERBS.length];
  const withheldWrite = `${writeVerb}-Withheld${withheldSuffix}Task`;
  const withheldUnclassified = `Qz${withheldSuffix}-Withheld${withheldSuffix}Task`;
  const augmentedExports = [...schedulerExports, withheldWrite, withheldUnclassified];

  record('control: the classification pin names an export whose verb no class lists', () => {
    assert.deepEqual(unclassifiedExports(augmentedExports), [withheldUnclassified]);
  });

  // Spawned with the augmented list, so the prefix is composed from it. The self-check exits 97
  // unless both generated names resolve to a stub, and each call is then read back off the record.
  const result = runScratchScript(
    [
      `${withheldWrite} -TaskName 'AgentPersona-suite-withheld-control' -TaskPath '\\'`,
      `${withheldUnclassified} -TaskName 'AgentPersona-suite-withheld-control' -TaskPath '\\'`,
      'Write-Output ("CALLS=" + ($script:Calls -join ";"))',
    ],
    { exports: augmentedExports }
  );
  record('control: an export named nowhere in this file is shadowed by the derivation inside a spawned PowerShell', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes(`${withheldWrite.toUpperCase()} TaskName=AgentPersona-suite-withheld-control`), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes(`${withheldUnclassified.toUpperCase()} TaskName=AgentPersona-suite-withheld-control`), 'stdout: ' + result.stdout);
  });

  // The self-check's own control: under realReads a generated service-read name is left unshadowed,
  // and since the module exports no such function it resolves nowhere, which the self-check must
  // refuse with exit 97 before the caller line runs.
  const withheldRead = `Get-Withheld${withheldSuffix}Task`;
  const checkResult = runPowerShell({
    kind: 'script',
    lines: ['Write-Output "CALLER_LINE_RAN"'],
    realReads: true,
    exports: [...schedulerExports, withheldRead],
    expectShadowCheckFailure: true,
  });
  record('control: the shadow self-check exits 97 before any caller line when an export does not resolve where its class says', () => {
    assert.equal(checkResult.status, 97, 'exit code; stderr: ' + checkResult.stderr);
    assert.ok(checkResult.stderr.includes(withheldRead), 'stderr names the export: ' + checkResult.stderr);
    assert.ok(!checkResult.stdout.includes('CALLER_LINE_RAN'), 'stdout: ' + checkResult.stdout);
  });
}

// A spawn that never names the registration script and calls service writes directly, one of them
// on the ClusteredScheduledTask noun, reaches the stubs rather than the service. The task name
// exists on no box.
{
  const result = runScratchScript([
    "Unregister-ScheduledTask -TaskName 'AgentPersona-suite-shadow-control' -TaskPath '\\' -Confirm:$false",
    "Register-ClusteredScheduledTask -TaskName 'AgentPersona-suite-shadow-control' -Cluster 'suite-shadow-control'",
    'Write-Output ("CALLS=" + ($script:Calls -join ";"))',
  ]);
  record('a spawn that calls service writes directly, naming no registration script, reaches only the stubs', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('UNREGISTER TaskName=AgentPersona-suite-shadow-control'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('REGISTER-CLUSTEREDSCHEDULEDTASK TaskName=AgentPersona-suite-shadow-control'), 'stdout: ' + result.stdout);
  });
}

// Control: the instrument reads the scheduler through the same wildcard form the suite trusts
// (AgentPersona-*'s own shape, a literal prefix plus *) and returns a nonzero count for a task
// whose name was read off this box's live scheduler, before it is trusted to return zero for
// AgentPersona-*. A literal-name lookup, or one hard-coded to a task specific to this box, would
// read exactly like a clean sweep if the wildcard form itself silently matched nothing.
const pickedTaskName = pickExistingTaskName();
record('control: the scheduler holds at least one real task to test the wildcard read against', () => {
  assert.ok(pickedTaskName.length > 0, 'no scheduled task found on this box to use as the control target');
});
const pickedWildcard = (pickedTaskName.length > 0 ? pickedTaskName : '__no-task-found__') + '*';
const pickedCount = countScheduledTasks(pickedWildcard);
record('control: Get-ScheduledTask via the same wildcard form the suite trusts finds a known task', () => {
  assert.ok(pickedCount >= 1, `wildcard '${pickedWildcard}' count: ${pickedCount}`);
});

// The invariant this suite owns is that it leaves the machine's AgentPersona-* task count where it
// found it, not that the count is zero: an installed fleet carries one task per enabled roster
// entry, and a suite asserting zero would be red on exactly the machines the keeper is working on.
// The closing assertion reads the count again and compares it against this one.
const beforeCount = countScheduledTasks('AgentPersona-*');
record('baseline: the AgentPersona-* task count is readable before the suite runs', () => {
  assert.ok(Number.isInteger(beforeCount) && beforeCount >= 0, 'AgentPersona-* count before: ' + beforeCount);
});

// Case 1: real -WhatIf run against the fixture roster.
{
  const result = runRegistrationScript([
    '-Roster', fixtureRoster,
    '-EnvFile', scratchEnvFile,
    '-RepoRoot', repoRoot,
    '-WhatIf',
  ]);
  record('case 1: -WhatIf exits 0', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
  });
  const { blocks } = parseTaskBlocks(result.stdout);
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
}

// Case 1's verdict lines, driven with the existing-task list injected. Every line the -WhatIf
// branch prints is chosen off that list ("would register" against "would update", "would disable"
// against "no task for disabled entry"), so a case reading those lines out of a real-script spawn
// reads the machine's own scheduler contents instead of the script's logic. Injecting an empty
// list is what makes the exact line set a function of the roster alone. The blocks above stay on
// the real-script spawn, since a definition's fields depend on no scheduler state at all.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    `$entries = Read-PersonaRoster -Path "${fixtureRoster}"`,
    `Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -WhatIf -ExistingTaskNames @()`,
  ];
  const result = runScratchScript(lines);
  record('case 1: prints "would register" for each enabled entry and one "no task for disabled entry gamma" line', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const { otherLines } = parseTaskBlocks(result.stdout);
    assert.deepEqual(otherLines, [
      'would register AgentPersona-alpha',
      'would register AgentPersona-beta',
      'no task for disabled entry gamma',
    ]);
  });
}

// Case 2: the real script run without -WhatIf, the one registration run in this suite that takes
// the registration path. Its spawn shadows every service export like every other spawn, and two
// further things keep its safety off the guard it exists to test. It runs only when the session is
// confirmed unelevated, so the elevation guard refuses it. And its roster disables every entry, so
// the path a regressed guard opens builds no definition and reaches no Register-ScheduledTask: the
// case still goes red on the exit code and the stderr assertions below. The entry names are ones no
// fleet roster carries, so the disable branch has no existing task to act on either.
const allDisabledRoster = join(scratchDir, 'all-disabled-fleet.json');
writeFileSync(
  allDisabledRoster,
  JSON.stringify([
    { name: 'suite-disabled-one', workdir: 'x', permissionMode: 'y', enabled: false },
    { name: 'suite-disabled-two', workdir: 'x', permissionMode: 'y', enabled: false },
  ]),
  'utf8'
);
const sessionElevated = isSessionElevated();
if (sessionElevated) {
  skip('case 2: real script without -WhatIf', 'this session is elevated; run the suite unelevated to exercise the real elevation guard without registering real tasks');
} else {
  const result = runRegistrationScript([
    '-Roster', allDisabledRoster,
    '-EnvFile', scratchEnvFile,
    '-RepoRoot', repoRoot,
  ]);
  record('case 2: exits 1 unelevated without -WhatIf', () => {
    assert.equal(result.status, 1, 'exit code');
  });
  record('case 2: stderr names the elevation requirement', () => {
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(
      /elevated PowerShell session/.test(collapsed),
      'stderr: ' + result.stderr
    );
  });
  record('case 2: the top-level catch does not double the throw\'s own function prefix', () => {
    // The elevation guard's own throw already starts "Register-PersonaTasks: ...", so a stray
    // outer prefix in the top-level catch would read "Register-PersonaTasks: Register-PersonaTasks: ...".
    assert.ok(!result.stderr.includes('Register-PersonaTasks: Register-PersonaTasks:'), 'stderr: ' + result.stderr);
  });
  record('case 2: prints no task block', () => {
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
  // This is the only run in the suite that drives the real script's registration path with no
  // -WhatIf, so the count is read again here rather than only at the end of the suite: a
  // registration that slipped past both the shadowing and the guard is named by the case that
  // caused it instead of by a sweep sixty cases later.
  const afterCase2Count = countScheduledTasks('AgentPersona-*');
  record('case 2: the run left the AgentPersona-* task count where it found it', () => {
    assert.equal(afterCase2Count, beforeCount, 'AgentPersona-* count after the unelevated run');
  });
}

// Cases 3 and 4: dot-source the script and call Register-PersonaTasks directly, through a scratch
// .ps1 file, so the elevation state and the existing-task list are injected with no shell-quoted
// PowerShell array literal. runPowerShell composes the shadow prefix in ahead of these lines, so
// every service export is shadowed before the dot-source and neither call can reach the real
// scheduler whatever branch it takes.
//
// The THROW_CASE call, which case 3 runs, is the one that needs them: it passes an enabled entry,
// no -WhatIf and no -ExistingTaskNames, so with the elevation guard as its only barrier a guard
// that stopped refusing would run a real Get-ScheduledTask and then a real Register-ScheduledTask
// for AgentPersona-alpha on this box. The recorded call list is asserted empty immediately after
// that call, which also pins the ordering the script's own header states: the elevation check runs
// before the read that lists existing AgentPersona-* tasks, so a guard moved below that read would
// leave a GET in the list.
function runFunctionCase(prune) {
  const pruneFlag = prune ? '-Prune' : '';
  const entryLines = [
    '$entries = @(',
    '    [pscustomobject]@{name="alpha";enabled=$true},',
    '    [pscustomobject]@{name="gamma";enabled=$false}',
    ')',
  ];
  // The refused-call block runs in the no-prune case alone. -Prune varies no axis of it: the
  // elevation guard throws before the switch is read, so running it under both flags would give
  // two byte-identical refusals and one of them would catch nothing the other missed.
  const throwCaseLines = prune
    ? []
    : [
        'Write-Output "=== THROW_CASE ==="',
        'try {',
        `    Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "D:/x.json" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $false`,
        '    Write-Output "NO_THROW"',
        '} catch {',
        '    Write-Output ("THREW: " + $_.Exception.Message)',
        '}',
        'Write-Output ("THROW_CASE_CALLS=" + ($script:Calls -join ","))',
        'Write-Output ("THROW_CASE_CALL_COUNT=" + $script:Calls.Count)',
      ];
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    ...entryLines,
    ...throwCaseLines,
    'Write-Output "=== WHATIF_CASE ==="',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "D:/x.json" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -WhatIf ${pruneFlag} -ExistingTaskNames @("AgentPersona-gamma","AgentPersona-zeta")`,
    'Write-Output ("FINAL_CALLS=" + ($script:Calls -join ","))',
    'Write-Output ("FINAL_CALL_COUNT=" + $script:Calls.Count)',
  ];
  return runScratchScript(lines);
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
  record('case 3: the refused call reaches no ScheduledTasks cmdlet at all, not even the existing-task read', () => {
    // An enabled entry, no -WhatIf and no -ExistingTaskNames: every scheduler call the function
    // can make is stubbed and recorded, so an empty list is the evidence that the elevation guard
    // stopped the call before the Get-ScheduledTask read and before any write.
    assert.ok(stdout.includes('THROW_CASE_CALL_COUNT=0'), 'stdout: ' + stdout);
    assert.ok(stdout.includes('THROW_CASE_CALLS='), 'the call list was printed at all: ' + stdout);
  });
  record('case 3: -WhatIf prints the alpha task block', () => {
    assert.ok(stdout.includes('task AgentPersona-alpha'), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf reports "would register AgentPersona-alpha" for an entry with no existing task', () => {
    assert.ok(stdout.includes('would register AgentPersona-alpha'), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf reports "would disable AgentPersona-gamma"', () => {
    assert.ok(stdout.includes('would disable AgentPersona-gamma'), 'stdout: ' + stdout);
  });
  record('case 3: -WhatIf reports the zeta orphan left in place', () => {
    // The distinguishing tokens are the orphan's name and the left-in-place verb; the rest of the
    // advisory sentence is prose, not contract.
    assert.ok(stdout.includes('orphan AgentPersona-zeta'), 'stdout: ' + stdout);
    assert.ok(stdout.includes('left in place'), 'stdout: ' + stdout);
  });
  record('case 3: registers, updates and unregisters nothing', () => {
    assert.ok(!/registered|updated|unregistered/.test(stdout), 'stdout: ' + stdout);
    // Read off the stub call record rather than off the printed words, so a branch that called a
    // scheduler cmdlet without printing anything is caught too.
    assert.ok(stdout.includes('FINAL_CALL_COUNT=0'), 'stdout: ' + stdout);
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
    assert.ok(stdout.includes('orphan AgentPersona-zeta'), 'stdout: ' + stdout);
    assert.ok(stdout.includes('would unregister under -Prune'), 'stdout: ' + stdout);
  });
  record('case 4: -Prune -WhatIf still registers, updates and unregisters nothing', () => {
    assert.ok(!/registered|updated|unregistered/.test(stdout), 'stdout: ' + stdout);
    assert.ok(stdout.includes('FINAL_CALL_COUNT=0'), 'stdout: ' + stdout);
  });
}

// The elevation guard's own wiring. Every case above reaches the guard through an injected
// -IsElevated, which exercises the guard's logic and says nothing about the script's own parameter
// default being wired to Test-IsElevated. This call passes no -IsElevated at all and stubs
// Test-IsElevated to report unelevated, so the refusal can only have come from that default
// evaluating that function, and the probe counter is what says it was called.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$script:ElevationProbes = 0',
    'function Test-IsElevated { $script:ElevationProbes++; return $false }',
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Register-PersonaTasks -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u"`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
    'Write-Output ("ELEVATION_PROBES=" + $script:ElevationProbes)',
    'Write-Output ("SCHEDULER_CALLS=" + $script:Calls.Count)',
  ];
  const result = runScratchScript(lines);
  record('the elevation guard reads its own Test-IsElevated default when no -IsElevated is injected', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*elevated PowerShell session/.test(collapsed), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('ELEVATION_PROBES=1'), 'the parameter default called Test-IsElevated once: ' + result.stdout);
    assert.ok(result.stdout.includes('SCHEDULER_CALLS=0'), 'the refused call reached no service cmdlet: ' + result.stdout);
  });
}

// Case 5: an unknown flag is a binding error ([CmdletBinding()] is what makes it one rather than a
// value landing in $args while the body runs). The case carries scratch -Roster, -EnvFile and
// -RepoRoot and -WhatIf so that the body, if it ever did run, would run against the suite's own
// paths and take no branch that writes. It asserts the binding error's own text rather than the
// bare exit code, because the elevation throw also exits 1: an exit-code assertion alone stays
// green on a script whose param block lost [CmdletBinding()] and ran its whole body.
{
  const result = runRegistrationScript([
    '-Bogus',
    '-Roster', fixtureRoster,
    '-EnvFile', scratchEnvFile,
    '-RepoRoot', stubRepoRoot,
    '-WhatIf',
  ]);
  record('case 5: an unknown flag exits 1', () => {
    assert.equal(result.status, 1, 'exit code; stderr: ' + result.stderr);
  });
  record('case 5: an unknown flag is refused as a binding error naming the parameter', () => {
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(
      /A parameter cannot be found that matches parameter name 'Bogus'/.test(collapsed),
      'stderr: ' + result.stderr
    );
  });
  record('case 5: the binding error fires before the body, which prints no task block', () => {
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
}

// Every case above and below that dot-sources the script relies on its top-level registration
// path never running when it is dot-sourced rather than run; that boundary is a single
// `if ($MyInvocation.InvocationName -ne '.')` guard around the whole body. This case dot-sources
// the script with none of -Roster, -EnvFile or -RepoRoot overridden, so a guard that fails to hold
// runs the top-level body against the param block's own defaults, the operator's real fleet paths.
// runPowerShell composes the shadow prefix in ahead of these lines, so every service export is
// shadowed before the dot-source and a guard failure here cannot reach a real one. A correctly gated dot-source runs none of that body at all: it calls no stubbed cmdlet,
// prints no line naming a task, and writes nothing to stderr, since the body's own try block is
// what would resolve the roster and env file paths and read the roster.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    'Write-Output "=== DOT_SOURCE_COMPLETE ==="',
    'Write-Output ("CALLS_COUNT=" + $script:Calls.Count)',
  ];
  const result = runScratchScript(lines);
  record('dot-sourcing the script calls no ScheduledTasks cmdlet and prints no task line', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('DOT_SOURCE_COMPLETE'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('CALLS_COUNT=0'), 'stdout: ' + result.stdout);
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
  record('dot-sourcing the script runs none of its own top-level body, leaving stderr empty', () => {
    assert.equal(result.stderr, '', 'stderr: ' + result.stderr);
  });
}

// Extension beyond the section's Tests floor: a roster name outside letters, digits, underscore
// and hyphen, and a path carrying a double quote, are refused before either can reach a scheduled
// task's command line as an unquoted argument, and each gets its own durable pin here.
{
  const badNameRoster = join(scratchDir, 'bad-name.json');
  writeFileSync(badNameRoster, JSON.stringify([{ name: 'al pha"&calc', workdir: 'x', permissionMode: 'y', enabled: true }]), 'utf8');
  const result = runRegistrationScript(['-Roster', badNameRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster name outside the safe character class is refused', () => {
    assert.equal(result.status, 1, 'exit code');
    // A long temp path can wrap at console width when the error host formats it; the basename is
    // the distinguishing token and is never split by that wrap.
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(collapsed.includes('bad-name.json'), 'stderr names the roster file: ' + result.stderr);
  });
}

{
  const quotedEnvFile = join(scratchDir, 'quo"ted.env');
  const result = runRegistrationScript(['-Roster', fixtureRoster, '-EnvFile', quotedEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a path carrying a double quote is refused rather than reaching the action string', () => {
    assert.equal(result.status, 1, 'exit code');
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
}

// Extension: run with no -RepoRoot, the script body resolves $RepoRoot itself from $PSScriptRoot,
// and this pins that such a run still succeeds and registers against the real checkout.
{
  const result = runRegistrationScript(['-Roster', fixtureRoster, '-EnvFile', scratchEnvFile, '-WhatIf']);
  record('extension: a run with no -RepoRoot resolves the repo root and exits 0', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
  });
  record('extension: a run with no -RepoRoot prints both task blocks', () => {
    assert.ok(result.stdout.includes('task AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('task AgentPersona-beta'), 'stdout: ' + result.stdout);
  });
}

// Extension: a leading-hyphen name and a trailing-newline name are both refused, at
// Read-PersonaRoster (the roster-file path every real invocation takes) and at
// Get-PersonaTaskDefinitions (the composition boundary a caller can reach directly, as this suite
// itself does in cases 3 and 4). A leading-underscore name is refused by neither: it is accepted,
// matching the character class bin/agentic-common.sh's own valid_persona_name accepts, since a
// leading underscore carries none of the command-line risk a leading hyphen does.
function assertNameRefused(name, label) {
  const roster = join(scratchDir, `bad-name-${scratchCounter++}.json`);
  writeFileSync(roster, JSON.stringify([{ name, workdir: 'x', permissionMode: 'y', enabled: true }]), 'utf8');
  const rosterResult = runRegistrationScript(['-Roster', roster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record(`extension: Read-PersonaRoster refuses a ${label} name`, () => {
    assert.equal(rosterResult.status, 1, 'exit code');
    assert.ok(/must start with a letter, digit or underscore/.test(rosterResult.stderr.replace(/\s+/g, ' ')), 'stderr: ' + rosterResult.stderr);
  });

  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    `$entries = @([pscustomobject]@{name=${psStringLiteral(name)};enabled=$true})`,
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const fnResult = runScratchScript(lines);
  record(`extension: Get-PersonaTaskDefinitions refuses a ${label} name independently of Read-PersonaRoster`, () => {
    assert.equal(fnResult.status, 0, 'exit code; stderr: ' + fnResult.stderr);
    // The refused name itself may carry the newline under test, so the exception message can span
    // lines; collapse whitespace before matching rather than relying on "." to cross a line break.
    const collapsed = fnResult.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*must start with a letter, digit or underscore/.test(collapsed), 'stdout: ' + fnResult.stdout);
  });
}
assertNameRefused('-Release', 'leading-hyphen');
assertNameRefused('alpha\n', 'trailing-newline');

// Extension: a leading-underscore name is accepted rather than refused, at both boundaries a
// leading-hyphen name is refused at. bin/agentic-common.sh's own valid_persona_name places no
// restriction on the first character, and the command-line risk a leading hyphen carries (it
// would compose as a second flag rather than a value) has no counterpart for an underscore, so
// this script's own character class matches valid_persona_name's exactly at the first character.
{
  const underscoreRoster = join(scratchDir, 'leading-underscore.json');
  writeFileSync(underscoreRoster, JSON.stringify([{ name: '_persona', workdir: 'x', permissionMode: 'y', enabled: true }]), 'utf8');
  const result = runRegistrationScript(['-Roster', underscoreRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a leading-underscore roster name is accepted, not refused', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('task AgentPersona-_persona'), 'stdout: ' + result.stdout);
  });
}

// Extension: the double-quote guard is unreachable from the top-level script under Windows
// PowerShell 5.1, since Resolve-AbsolutePath's GetFullPath throws its own "Illegal characters in
// path" error first; this pins the guard's own message by calling Get-PersonaTaskDefinitions
// directly, bypassing Resolve-AbsolutePath entirely.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile 'D:/quo"ted.env' -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('extension: Get-PersonaTaskDefinitions refuses a quoted path with its own message, reached directly', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(/THREW: .*cannot sit inside a quoted task argument/.test(result.stdout), 'stdout: ' + result.stdout);
  });
}

// Extension: a path ending in \ or / is refused alongside the quote check, since a trailing
// backslash before the closing quote escapes that quote on the task's command line.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}\\" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('extension: a trailing backslash on a path is refused alongside the quote check', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(/THREW: .*ends in a path separator/.test(result.stdout), 'stdout: ' + result.stdout);
  });
}

// Extension: an `enabled` field that is present but not a JSON boolean (PowerShell truthiness
// reads the string "false" as true) is refused rather than silently registering, and under
// -Start launching, a persona the operator meant to disable.
{
  const stringEnabledRoster = join(scratchDir, 'string-enabled.json');
  writeFileSync(stringEnabledRoster, JSON.stringify([{ name: 'alpha', workdir: 'x', permissionMode: 'y', enabled: 'false' }]), 'utf8');
  const result = runRegistrationScript(['-Roster', stringEnabledRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster entry whose enabled field is a string, not a boolean, is refused', () => {
    assert.equal(result.status, 1, 'exit code');
    assert.ok(/must be a JSON boolean/.test(result.stderr.replace(/\s+/g, ' ')), 'stderr: ' + result.stderr);
  });
}

// The same `enabled` type check at the composition boundary a caller reaches directly, never
// through Read-PersonaRoster: `if (-not $entry.enabled)` reads the string "false" as true, so an
// entry carrying it would otherwise build a definition for a persona its own roster field
// disables. A JSON null, which is what a missing field reads as here, is refused by name too.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled="false"})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
    '$nullEntries = @([pscustomobject]@{name="alpha";enabled=$null})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $nullEntries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NULL_NO_THROW"',
    '} catch {',
    '    Write-Output ("NULL_THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('Get-PersonaTaskDefinitions refuses a string enabled field independently of Read-PersonaRoster', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*must be a JSON boolean, not String/.test(collapsed), 'stdout: ' + result.stdout);
  });
  record('Get-PersonaTaskDefinitions refuses a null enabled field by name', () => {
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/NULL_THREW: .*must be a JSON boolean, not null/.test(collapsed), 'stdout: ' + result.stdout);
    assert.ok(!/cannot call a method on a null-valued expression/i.test(collapsed), 'stdout: ' + result.stdout);
  });
}

// Extension: an `enabled` field that is a JSON null is refused by name rather than by a
// null-valued-expression error from the engine itself: `$entry.enabled.GetType()` would throw
// PowerShell's own generic message instead of the script's "must be a JSON boolean" sentence.
{
  const nullEnabledRoster = join(scratchDir, 'null-enabled.json');
  writeFileSync(nullEnabledRoster, '[{"name":"alpha","workdir":"x","permissionMode":"y","enabled":null}]', 'utf8');
  const result = runRegistrationScript(['-Roster', nullEnabledRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster entry whose enabled field is a JSON null is refused by name, not by an engine error', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/must be a JSON boolean, not null/.test(collapsed), 'stderr: ' + result.stderr);
    assert.ok(!/cannot call a method on a null-valued expression/i.test(collapsed), 'stderr: ' + result.stderr);
  });
}

// Extension: a repeated roster name is refused rather than throwing mid-pass after some tasks
// are already written.
{
  const dupRoster = join(scratchDir, 'dup-name.json');
  writeFileSync(dupRoster, JSON.stringify([
    { name: 'alpha', workdir: 'x', permissionMode: 'y', enabled: true },
    { name: 'alpha', workdir: 'x2', permissionMode: 'y2', enabled: true },
  ]), 'utf8');
  const result = runRegistrationScript(['-Roster', dupRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster name repeated across two entries is refused', () => {
    assert.equal(result.status, 1, 'exit code');
    assert.ok(/more than one entry named/.test(result.stderr.replace(/\s+/g, ' ')), 'stderr: ' + result.stderr);
  });
}

// Two roster entries differing only in case are the same task name to Windows
// Task Scheduler and to $definitionsByTaskName's own case-insensitive hashtable in
// Get-PersonaTaskDefinitions, so they must be refused as a repeat here, before either definition
// is built. Read-PersonaRoster's own $seenNames HashSet must therefore compare names
// case-insensitively too: a case-sensitive HashSet would let both 'alpha' and 'Alpha' through, and
// the survivor in $definitionsByTaskName would silently be whichever entry's definition was
// written to that key last.
{
  const caseDupRoster = join(scratchDir, 'case-dup-name.json');
  writeFileSync(caseDupRoster, JSON.stringify([
    { name: 'alpha', workdir: 'x', permissionMode: 'y', enabled: true },
    { name: 'Alpha', workdir: 'x2', permissionMode: 'y2', enabled: true },
  ]), 'utf8');
  const result = runRegistrationScript(['-Roster', caseDupRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('a roster name repeated with different case is refused, not silently collapsed', () => {
    assert.equal(result.status, 1, 'exit code; stdout: ' + result.stdout);
    assert.ok(/more than one entry named 'Alpha'/.test(result.stderr.replace(/\s+/g, ' ')), 'stderr: ' + result.stderr);
  });
}

// A caller reaching Get-PersonaTaskDefinitions directly, never through Read-PersonaRoster, gets
// the same duplicate-name refusal a roster file would: two entries sharing a name once case is
// ignored would otherwise collapse to one key in $definitionsByTaskName with no record of which
// was dropped.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true},[pscustomobject]@{name="Alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('Get-PersonaTaskDefinitions refuses a case-variant duplicate name independently of Read-PersonaRoster', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*more than one entry named 'Alpha'/.test(collapsed), 'stdout: ' + result.stdout);
  });
}

// Extension: the target script and -EnvFile are both checked for existence, since a missing
// bin/Start-Persona.ps1 is the worktree-removed hazard -RepoRoot exists to avoid, and a missing
// -EnvFile is a task that refuses to start at boot with nothing to say why until then.
{
  const missingEnvFile = join(scratchDir, 'does-not-exist.env');
  const result = runRegistrationScript(['-Roster', fixtureRoster, '-EnvFile', missingEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a missing -EnvFile is refused rather than registering a task that fails at boot', () => {
    assert.equal(result.status, 1, 'exit code');
    assert.ok(result.stderr.includes('does-not-exist.env'), 'stderr: ' + result.stderr);
  });
}

// Extension: a -RepoRoot whose bin directory exists but does not contain Start-Persona.ps1 is
// refused by Get-PersonaTaskDefinitions's own existence check, naming the file and saying it does
// not exist.
{
  const noEntryRoot = join(scratchDir, 'no-entry-script');
  const noEntryBin = join(noEntryRoot, 'bin');
  mkdirSync(noEntryBin, { recursive: true });
  const result = runRegistrationScript(['-Roster', fixtureRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', noEntryRoot, '-WhatIf']);
  record('extension: a -RepoRoot whose bin exists with no Start-Persona.ps1 is refused by name', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/Start-Persona\.ps1.*does not exist/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

// Extension: a -RepoRoot whose bin directory itself does not exist at all is refused by name,
// naming Start-Persona.ps1 as missing, by Get-PersonaTaskDefinitions's own existence check on the
// joined bin/Start-Persona.ps1 path.
{
  const fakeRepoRoot = join(scratchDir, 'fake-repo');
  mkdirSync(fakeRepoRoot, { recursive: true });
  const result = runRegistrationScript(['-Roster', stubRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', fakeRepoRoot, '-WhatIf']);
  record('extension: a -RepoRoot with no bin directory at all is refused, naming Start-Persona.ps1 as missing', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/Start-Persona\.ps1.*does not exist/.test(collapsed), 'stderr: ' + result.stderr);
    assert.ok(!/CategoryInfo|FullyQualifiedErrorId/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

// Extension: the elevation guard's positive direction, isolated. -IsElevated is the only axis that
// differs from case 3's refused call: there is one enabled entry, no -WhatIf, and an injected
// empty existing-task list, so a guard that passes must carry the call all the way into the real
// registration branch. The recorded REGISTER call is what says it did, which a run against an
// empty entries list could not distinguish from a guard that silently returned. Every
// ScheduledTasks cmdlet is shadowed so nothing here reaches a real one.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -ExistingTaskNames @()`,
    'Write-Output "NO_THROW"',
    'Write-Output "=== CALLS ==="',
    '$script:Calls | ForEach-Object { Write-Output $_ }',
  ];
  const result = runScratchScript(lines);
  record('extension: the elevation guard passes in isolation when only IsElevated varies, with no -WhatIf', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('NO_THROW'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('registered AgentPersona-alpha'), 'stdout: ' + result.stdout);
  });
  record('extension: a passing elevation guard carries the call into the registration branch, recorded on the stub', () => {
    assert.ok(result.stdout.includes('REGISTER TaskName=AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('ENABLE TaskName=AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(!result.stdout.includes('UNREGISTER'), 'stdout: ' + result.stdout);
    assert.ok(!result.stdout.includes('START'), 'no -Start was passed: ' + result.stdout);
  });
}

// Extension: an empty roster returns a real, bindable empty array from Read-PersonaRoster (not
// $null, which PowerShell's own pipeline unwrapping would otherwise produce for a 0-element
// return), and -Prune still runs the orphan pass against it.
{
  const emptyRoster = join(scratchDir, 'empty-roster.json');
  writeFileSync(emptyRoster, '[]', 'utf8');
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    `$entries = Read-PersonaRoster -Path "${emptyRoster}"`,
    'Write-Output "ENTRIES_COUNT=$(@($entries).Count)"',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "${emptyRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -Prune -WhatIf -ExistingTaskNames @("AgentPersona-orphan2")`,
  ];
  const result = runScratchScript(lines);
  record('extension: an empty roster binds to Register-PersonaTasks without a null-argument error', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('ENTRIES_COUNT=0'), 'stdout: ' + result.stdout);
  });
  record('extension: an empty roster with -Prune still runs the orphan pass', () => {
    assert.ok(result.stdout.includes('orphan AgentPersona-orphan2'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('would unregister under -Prune'), 'stdout: ' + result.stdout);
  });
}

// Extension: driven together against one roster shape. Every ScheduledTasks cmdlet is shadowed
// by a stub function recording its own name and its -TaskPath argument, so this never touches the
// real scheduler regardless of the session's actual elevation, while still proving -TaskPath '\'
// reaches every read and write, that -Start reports under -WhatIf, that the real prune path names
// the orphan count before removing anything, and that Enable-ScheduledTask runs for every enabled
// entry actually registered or updated.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @(',
    '    [pscustomobject]@{ name = "alpha"; enabled = $true },',
    '    [pscustomobject]@{ name = "beta"; enabled = $true },',
    '    [pscustomobject]@{ name = "gamma"; enabled = $false },',
    '    [pscustomobject]@{ name = "delta"; enabled = $false }',
    ')',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -Prune -Start`,
    'Write-Output "=== CALLS ==="',
    '$script:Calls | ForEach-Object { Write-Output $_ }',
  ];
  // The Get-ScheduledTask stub returns three task objects here, which is what drives the update,
  // disable and orphan branches together in one call.
  const result = runScratchScript(lines, {
    getScheduledTaskReturn: [
      '    return @(',
      "        [pscustomobject]@{ TaskName = 'AgentPersona-alpha' },",
      "        [pscustomobject]@{ TaskName = 'AgentPersona-gamma' },",
      "        [pscustomobject]@{ TaskName = 'AgentPersona-orphan1' }",
      '    )',
    ],
  });
  record('extension: -TaskPath \'\\\' is passed to every scheduler read and write', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const stdout = result.stdout;
    for (const expected of [
      'GET TaskName=AgentPersona-* TaskPath=\\',
      'SET TaskName=AgentPersona-alpha TaskPath=\\',
      'ENABLE TaskName=AgentPersona-alpha TaskPath=\\',
      'START TaskName=AgentPersona-alpha TaskPath=\\',
      'REGISTER TaskName=AgentPersona-beta TaskPath=\\',
      'ENABLE TaskName=AgentPersona-beta TaskPath=\\',
      'START TaskName=AgentPersona-beta TaskPath=\\',
      'DISABLE TaskName=AgentPersona-gamma TaskPath=\\',
      'UNREGISTER TaskName=AgentPersona-orphan1 TaskPath=\\',
    ]) {
      assert.ok(stdout.includes(expected), `missing "${expected}" in stdout: ${stdout}`);
    }
  });
  record('extension: the orphan count is printed before the real prune removes anything', () => {
    assert.ok(result.stdout.includes('pruning 1 orphan task(s): AgentPersona-orphan1'), 'stdout: ' + result.stdout);
  });
  record('extension: -Start reports "started" for each enabled entry actually registered or updated', () => {
    const stdout = result.stdout;
    assert.ok(stdout.includes('updated AgentPersona-alpha'), stdout);
    assert.ok(stdout.includes('started AgentPersona-alpha'), stdout);
    assert.ok(stdout.includes('registered AgentPersona-beta'), stdout);
    assert.ok(stdout.includes('started AgentPersona-beta'), stdout);
    assert.ok(stdout.includes('disabled AgentPersona-gamma'), stdout);
    assert.ok(stdout.includes('no task for disabled entry delta'), stdout);
    assert.ok(stdout.includes('unregistered AgentPersona-orphan1'), stdout);
  });
  record('extension: Enable-ScheduledTask runs for every enabled entry actually registered or updated, not for a disabled or absent one', () => {
    const calls = result.stdout;
    assert.ok(calls.includes('ENABLE TaskName=AgentPersona-alpha TaskPath=\\'), calls);
    assert.ok(calls.includes('ENABLE TaskName=AgentPersona-beta TaskPath=\\'), calls);
    assert.ok(!calls.includes('ENABLE TaskName=AgentPersona-gamma'), calls);
    assert.ok(!calls.includes('ENABLE TaskName=AgentPersona-delta'), calls);
  });
}

// Extension: Resolve-AbsolutePath trims the trailing separator GetFullPath leaves on an input
// like "D:/agent_persona/", and restores it on a bare drive root the trim would otherwise reduce
// to "D:" (the current directory on that drive to .NET, not the root). The input is the drive root
// spelled with its separator, "<drive>/": a bare "<drive>:" is drive-relative, resolves to the
// current directory on that drive, and so never reaches the restore at all.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    `Write-Output "TRAILING=$(Resolve-AbsolutePath -Path '${repoRoot.replace(/\\/g, '/')}/')"`,
    `Write-Output "BAREDRIVE=$(Resolve-AbsolutePath -Path '${repoRootDrive}/')"`,
  ];
  const result = runScratchScript(lines);
  record('extension: a trailing separator on -RepoRoot is trimmed rather than carried into the resolved path', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    // An exact line match, not a substring check: 'TRAILING=' + repoRoot is itself a prefix of
    // 'TRAILING=' + repoRoot + '\', so a substring check would pass even on the untrimmed value
    // this case exists to catch.
    const lines = result.stdout.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('TRAILING=' + repoRoot), 'stdout: ' + result.stdout);
  });
  record('extension: a bare drive root keeps its trailing separator rather than naming a relative directory', () => {
    // An exact line match for the same reason as the trailing case: a prefix check accepts
    // "<drive>:\agent_persona", the value a drive-relative input resolves to.
    const lines = result.stdout.split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('BAREDRIVE=' + repoRootDrive + '\\'), 'stdout: ' + result.stdout);
  });
}

// Extension: a -RepoRoot typed with a trailing slash is accepted end to end, through the real
// path-separator guard that would otherwise refuse it (a path ending in \ or / is refused because
// a trailing backslash before the closing quote would escape the task action's own quote).
{
  const trailingSlashRoot = repoRoot.replace(/\\/g, '/') + '/';
  const result = runRegistrationScript(['-Roster', fixtureRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', trailingSlashRoot, '-WhatIf']);
  record('extension: -RepoRoot with a trailing slash resolves and registers rather than being refused as an unsafe path', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('task AgentPersona-alpha'), 'stdout: ' + result.stdout);
  });
}

// Extension: -Start under -WhatIf prints a "would start" line rather than staying silent about
// what a real run would do, and the dry run distinguishes an entry whose task already exists from
// one whose task does not, off the same existing-task test the real registration branch takes.
// Both directions run in one call: alpha is in the injected existing-task list and beta is not.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @(',
    '    [pscustomobject]@{name="alpha";enabled=$true},',
    '    [pscustomobject]@{name="beta";enabled=$true}',
    ')',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -WhatIf -Start -ExistingTaskNames @("AgentPersona-alpha")`,
  ];
  const result = runScratchScript(lines);
  record('extension: -WhatIf -Start prints "would start" for each enabled entry', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('would start AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('would start AgentPersona-beta'), 'stdout: ' + result.stdout);
  });
  record('extension: -WhatIf prints "would update" for an entry whose task exists and "would register" for one whose task does not', () => {
    assert.ok(result.stdout.includes('would update AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('would register AgentPersona-beta'), 'stdout: ' + result.stdout);
    assert.ok(!result.stdout.includes('would register AgentPersona-alpha'), 'stdout: ' + result.stdout);
    assert.ok(!result.stdout.includes('would update AgentPersona-beta'), 'stdout: ' + result.stdout);
  });
}

// The one destructive act, Unregister-ScheduledTask, is proven to never run when -Prune is absent
// from the real registration path, not only shown withheld under -WhatIf where nothing is removed
// by construction whatever the branch does.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @()',
    `Register-PersonaTasks -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "u" -IsElevated $true -ExistingTaskNames @("AgentPersona-orphan3")`,
    'Write-Output "=== CALLS ==="',
    '$script:Calls | ForEach-Object { Write-Output $_ }',
  ];
  const result = runScratchScript(lines);
  record('the real registration path never unregisters an orphan when -Prune is absent', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(!result.stdout.includes('UNREGISTER'), 'no unregister call was recorded: ' + result.stdout);
    assert.ok(result.stdout.includes('orphan AgentPersona-orphan3'), 'the orphan is still reported: ' + result.stdout);
  });
}

// A wrong $env:SystemRoot fails the definition build, at registration time, rather than only
// surfacing as a boot-time failure with nothing to say why.
{
  const badSystemRoot = join(scratchDir, 'no-such-system-root');
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    `$env:SystemRoot = ${psStringLiteral(badSystemRoot)}`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('a wrong $env:SystemRoot fails the definition build rather than only at boot', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('THREW:'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('powershell.exe') && result.stdout.includes('does not exist'), 'stdout: ' + result.stdout);
  });
}

// An empty or absent $env:SystemRoot is refused by this function's own message rather than by
// Join-Path's engine-level "Cannot bind argument" error, since Join-Path throws that error on both
// an empty string and a $null first argument.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$env:SystemRoot = ""',
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('an empty $env:SystemRoot is refused by name, not by Join-Path\'s own binding error', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*SystemRoot is empty or unset/.test(collapsed), 'stdout: ' + result.stdout);
    assert.ok(!/Cannot bind argument/i.test(collapsed), 'stdout: ' + result.stdout);
  });
}

{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    'Remove-Item Env:\\SystemRoot',
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${repoRoot}" -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('a removed $env:SystemRoot, read as $null, is refused by the same message', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    assert.ok(/THREW: .*SystemRoot is empty or unset/.test(collapsed), 'stdout: ' + result.stdout);
    assert.ok(!/Cannot bind argument/i.test(collapsed), 'stdout: ' + result.stdout);
  });
}

// A bare drive root for -RepoRoot (the exact spelling Resolve-AbsolutePath
// produces for a bare "D:") is exempt from the trailing-separator refusal, since it is not embedded
// in the action string directly and so cannot escape a closing quote the way a deeper trailing
// backslash can. The repository's own drive is used, since a nonexistent one raises
// DriveNotFoundException out of Join-Path before the separator loop this case targets ever runs;
// this case reads a Test-Path result off that drive and writes nothing to it. It still fails, on
// the unrelated and expected reason that no bin\Start-Persona.ps1 exists at that drive's root.
{
  const bareDriveRoot = repoRootDrive + '\\';
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot ${psStringLiteral(bareDriveRoot)} -Roster "${fixtureRoster}" -EnvFile "${scratchEnvFile}" -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record('a bare drive root for -RepoRoot is not refused by the trailing-separator guard', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(!result.stdout.includes('ends in a path separator'), 'the separator refusal does not fire: ' + result.stdout);
    assert.ok(result.stdout.includes('THREW:'), 'still throws for a different, expected reason: ' + result.stdout);
    assert.ok(result.stdout.includes('does not exist'), 'fails on the missing entry script instead: ' + result.stdout);
  });
}

// The bare-drive-root exemption belongs to -RepoRoot alone. -Roster and -EnvFile are interpolated
// into the task action's quoted arguments verbatim, so a bare drive root on either would put a
// backslash immediately before a closing quote, escape it, and merge the following argument into
// the value: exactly the failure the refusal's own message describes. -RepoRoot carries no such
// risk, because it reaches the action only as the root of the Start-Persona.ps1 path built from
// it, which composes a further segment onto it. The repository's own drive is used, since a
// nonexistent one raises DriveNotFoundException out of Join-Path before the separator loop runs;
// these cases read a Test-Path result off that drive and write nothing to it.
function assertBareDriveRootRefused(paramName) {
  const bareDriveRoot = repoRootDrive + '\\';
  const args = {
    RepoRoot: `"${repoRoot}"`,
    Roster: `"${fixtureRoster}"`,
    EnvFile: `"${scratchEnvFile}"`,
  };
  args[paramName] = psStringLiteral(bareDriveRoot);
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    'try {',
    `    Get-PersonaTaskDefinitions -Entries $entries -RepoRoot ${args.RepoRoot} -Roster ${args.Roster} -EnvFile ${args.EnvFile} -User "u" | Out-Null`,
    '    Write-Output "NO_THROW"',
    '} catch {',
    '    Write-Output ("THREW: " + $_.Exception.Message)',
    '}',
  ];
  const result = runScratchScript(lines);
  record(`a bare drive root for -${paramName} is refused by the trailing-separator guard`, () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('THREW:'), 'stdout: ' + result.stdout);
    assert.ok(result.stdout.includes('ends in a path separator'), 'the separator refusal is what fired: ' + result.stdout);
    assert.ok(result.stdout.includes(bareDriveRoot), 'the refusal names the offending path: ' + result.stdout);
  });
}
assertBareDriveRootRefused('Roster');
assertBareDriveRootRefused('EnvFile');

// The same refusal driven end to end through the real script, so the wiring from the param block
// through Resolve-AbsolutePath into Get-PersonaTaskDefinitions's path loop is pinned rather than
// only the loop itself. Resolve-AbsolutePath puts the trailing separator back on a bare drive
// root, and the loop refuses it for -EnvFile, which lands inside the action's quoted argument
// verbatim. The repository's own drive is used, since a drive this box has not mounted fails
// earlier at path resolution; this case reads a Test-Path result off that drive and writes
// nothing to it.
{
  const result = runRegistrationScript([
    '-Roster', fixtureRoster,
    '-EnvFile', repoRootDrive + '\\',
    '-RepoRoot', repoRoot,
    '-WhatIf',
  ]);
  record('a bare drive root on -EnvFile is refused through the real script, not only through a direct call', () => {
    assert.equal(result.status, 1, 'exit code; stdout: ' + result.stdout);
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/ends in a path separator/.test(collapsed), 'stderr: ' + result.stderr);
    assert.ok(!result.stdout.includes('task AgentPersona-'), 'stdout: ' + result.stdout);
  });
}

// Extension: -User reaches New-ScheduledTaskPrincipal's own -UserId, driven with a -User value
// that is not the session's own identity. The cases that read the account field off the -WhatIf
// print take the param block's default, which is that same identity, so they cannot tell a
// principal built from -User apart from one built from any other source of the current account.
// This case is the one that varies -User off the default, so the value it asserts can only have
// come from the parameter.
{
  const lines = [
    '$ErrorActionPreference = "Stop"',
    `. "${scriptPath}"`,
    '$entries = @([pscustomobject]@{name="alpha";enabled=$true})',
    `$definitions = Get-PersonaTaskDefinitions -Entries $entries -RepoRoot "${stubRepoRoot}" -Roster "${stubRoster}" -EnvFile "${scratchEnvFile}" -User "keeper-probe-user"`,
    'Write-Output ("USERID=" + $definitions[0].Principal.UserId)',
  ];
  const result = runScratchScript(lines);
  record('extension: -User reaches New-ScheduledTaskPrincipal -UserId on the built definition', () => {
    assert.equal(result.status, 0, 'exit code; stderr: ' + result.stderr);
    assert.ok(result.stdout.includes('USERID=keeper-probe-user'), 'stdout: ' + result.stdout);
  });
}

// Read-PersonaRoster's six refusal legs, each driven through the real script under -WhatIf against
// a fixture written under the OS temp root, so a leg removed from the function leaves its own case
// red rather than only proven reachable through an injected call.
{
  const missingRoster = join(scratchDir, 'does-not-exist-roster.json');
  const result = runRegistrationScript(['-Roster', missingRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster path that does not exist is refused by the not-found leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/roster not found at/.test(collapsed), 'stderr: ' + result.stderr);
    assert.ok(collapsed.includes('does-not-exist-roster.json'), 'stderr: ' + result.stderr);
  });
}

{
  // Test-Path reports a directory as present, so this reaches Get-Content rather than the
  // not-found leg above; Get-Content on a directory throws UnauthorizedAccessException on Windows,
  // which the unreadable leg's own catch turns into its named refusal.
  const rosterDir = join(scratchDir, 'roster-is-a-directory');
  mkdirSync(rosterDir, { recursive: true });
  const result = runRegistrationScript(['-Roster', rosterDir, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a roster path that is a directory is refused by the unreadable leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/could not read roster/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

{
  const invalidJsonRoster = join(scratchDir, 'invalid-json.json');
  writeFileSync(invalidJsonRoster, '[this is not json', 'utf8');
  const result = runRegistrationScript(['-Roster', invalidJsonRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: text that opens with [ but does not parse as JSON is refused by the invalid-JSON leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/is not valid JSON/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

{
  const objectRoster = join(scratchDir, 'object-roster.json');
  writeFileSync(objectRoster, '{"name":"alpha","enabled":true}', 'utf8');
  const result = runRegistrationScript(['-Roster', objectRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a top-level JSON object is refused by the not-an-array leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/must be a top-level JSON array/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

{
  const noNameRoster = join(scratchDir, 'no-name.json');
  writeFileSync(noNameRoster, JSON.stringify([{ enabled: true }]), 'utf8');
  const result = runRegistrationScript(['-Roster', noNameRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: an entry missing name is refused by the missing-name leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/is missing 'name'/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

{
  const noEnabledRoster = join(scratchDir, 'no-enabled.json');
  writeFileSync(noEnabledRoster, JSON.stringify([{ name: 'alpha' }]), 'utf8');
  const result = runRegistrationScript(['-Roster', noEnabledRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: an entry missing enabled is refused by the missing-enabled leg', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/is missing 'enabled'/.test(collapsed), 'stderr: ' + result.stderr);
  });
}

// A zero-byte roster returns $null from Get-Content -Raw under Windows PowerShell 5.1
// rather than an empty string, so this pins the not-an-array leg's own message rather than the
// engine's generic null-valued-expression error.
{
  const zeroByteRoster = join(scratchDir, 'zero-byte.json');
  writeFileSync(zeroByteRoster, '', 'utf8');
  const result = runRegistrationScript(['-Roster', zeroByteRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf']);
  record('extension: a zero-byte roster is refused by the not-an-array leg, not by an engine error', () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(/must be a top-level JSON array/.test(collapsed), 'stderr: ' + result.stderr);
    assert.ok(!/cannot call a method on a null-valued expression/i.test(collapsed), 'stderr: ' + result.stderr);
  });
}

// A -RepoRoot, -Roster or -EnvFile naming a drive that does not exist is refused naming
// the parameter and the value, rather than surfacing the engine's own unqualified "Cannot find
// drive" message. The drive is picked at run time by finding one this box has not mounted, rather
// than a hardcoded letter, so the case still finds one wherever it runs.
function pickUnusedDriveLetter() {
  const result = runScratchScript([
    'foreach ($i in 90..65) {',
    '    $c = [char]$i',
    '    $d = "$c" + ":"',
    '    if (-not (Test-Path -LiteralPath ($d + "\\"))) {',
    '        Write-Output $d',
    '        break',
    '    }',
    '}',
  ]);
  return result.stdout.trim();
}
const unusedDrive = pickUnusedDriveLetter();
record('control: an unused drive letter was found on this box to drive the bad-drive cases', () => {
  assert.ok(/^[A-Za-z]:$/.test(unusedDrive), 'picked drive: ' + JSON.stringify(unusedDrive));
});

function assertBadDriveRefused(paramName) {
  const badPath = unusedDrive + '\\';
  const args = ['-Roster', fixtureRoster, '-EnvFile', scratchEnvFile, '-RepoRoot', repoRoot, '-WhatIf'];
  const flagIndex = args.indexOf('-' + paramName);
  args[flagIndex + 1] = badPath;
  const result = runRegistrationScript(args);
  record(`extension: a nonexistent drive on -${paramName} is refused naming the parameter and the value`, () => {
    assert.equal(result.status, 1, 'exit code');
    const collapsed = result.stderr.replace(/\s+/g, ' ');
    assert.ok(collapsed.includes(`-${paramName} '${badPath}'`), 'stderr: ' + result.stderr);
    assert.ok(collapsed.includes('could not be resolved'), 'stderr: ' + result.stderr);
  });
}
assertBadDriveRefused('RepoRoot');
assertBadDriveRefused('Roster');
assertBadDriveRefused('EnvFile');

// Controls for the spawn guard, each an instance withheld from the shapes the suite itself spawns
// and each classified without being run. They are what say the guard's silence above is coverage
// rather than a classifier that clears everything it is handed.
record('control: the spawn guard refuses a registration run carrying neither -WhatIf nor a scratch path pair', () => {
  const verdict = classifySpawnRequest({ kind: 'registration', args: ['-Bogus'] });
  assert.equal(verdict.allowed, false, 'verdict: ' + JSON.stringify(verdict));
  assert.equal(verdict.family, 'registration script', 'verdict: ' + JSON.stringify(verdict));
});

record('control: the spawn guard refuses a registration run whose -Roster is not a scratch path', () => {
  const verdict = classifySpawnRequest({ kind: 'registration', args: ['-Roster', 'D:/personas/fleet.json', '-EnvFile', scratchEnvFile] });
  assert.equal(verdict.allowed, false, 'verdict: ' + JSON.stringify(verdict));
});

// The two routes past a stub, each on an export the suite's own cases never call that way. The
// module-qualified shape is matched on the module name and a backslash, whatever export follows.
record('control: the spawn guard refuses a request that calls an export module-qualified', () => {
  const verdict = classifySpawnRequest({ kind: 'script', lines: [`${SCHEDULER_MODULE}\\Stop-ScheduledTask -TaskName 'x'`] });
  assert.equal(verdict.allowed, false, 'verdict: ' + JSON.stringify(verdict));
  assert.ok(verdict.reason.includes('module-qualified'), 'verdict: ' + JSON.stringify(verdict));
});

record('control: the spawn guard refuses a request that removes or redefines a function named for an export', () => {
  const removal = classifySpawnRequest({ kind: 'script', lines: ['Remove-Item function:\\Disable-ScheduledTask'] });
  assert.equal(removal.allowed, false, 'verdict: ' + JSON.stringify(removal));
  assert.ok(removal.reason.includes('Disable-ScheduledTask'), 'verdict: ' + JSON.stringify(removal));
  const redefinition = classifySpawnRequest({ kind: 'script', lines: ['function global:Get-ClusteredScheduledTask { }'] });
  assert.equal(redefinition.allowed, false, 'verdict: ' + JSON.stringify(redefinition));
  assert.ok(redefinition.reason.includes('Get-ClusteredScheduledTask'), 'verdict: ' + JSON.stringify(redefinition));
});

record('control: the spawn guard refuses a request whose export list drops a module export', () => {
  const verdict = classifySpawnRequest({ kind: 'script', lines: [], exports: schedulerExports.slice(1) });
  assert.equal(verdict.allowed, false, 'verdict: ' + JSON.stringify(verdict));
  assert.ok(verdict.reason.includes(schedulerExports[0]), 'verdict: ' + JSON.stringify(verdict));
});

// Structural pin: the guard cleared every spawn this suite made. Each entry was recorded by
// runPowerShell as the spawn was made, so the list is the whole family by construction rather than
// a sweep of call sites. A refused spawn never ran and has already failed its own case; this pin
// is what names it in one place.
record('structural pin: the spawn guard refused no spawn this suite made', () => {
  const refused = spawnClassifications.filter((entry) => !entry.allowed);
  assert.deepEqual(refused.map((entry) => entry.description + ' :: ' + entry.reason), [], 'refused spawns');
});

// Structural pin: no spawn in this suite names its executable by bare command name. On Windows a
// bare name resolves against the working directory before the system PATH, and the suppressing
// variable is read from the spawning process rather than from the child, so a file dropped beside
// the caller would run in place of the real engine on every spawn this suite makes. Read off the
// suite's own source, so a spawn added later is covered by shape rather than by anyone remembering.
record('structural pin: every spawn names its executable by a qualified path', () => {
  const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const literals = [...ownSource.matchAll(SPAWN_LITERAL_SHAPE)].map((m) => m[2]);
  assert.deepEqual(literals, [], 'spawnSync called with a string-literal executable');
});

const afterCount = countScheduledTasks('AgentPersona-*');
record('the suite left the machine\'s AgentPersona-* task count where it found it', () => {
  assert.equal(afterCount, beforeCount, `AgentPersona-* count before ${beforeCount}, after`);
});

// Structural pin, read last so it covers every spawn: no spawn failed its shadow self-check except
// the one control that exists to make it fail.
record('structural pin: no spawn failed its shadow self-check outside the control that expects it', () => {
  const failed = spawnClassifications.filter((entry) => entry.shadowCheckFailed !== entry.expectShadowCheckFailure && entry.status !== null);
  assert.deepEqual(failed.map((entry) => entry.description + ' :: exit ' + entry.status), [], 'spawns whose self-check verdict was not the expected one');
});

// Cleanup runs on the 'exit' handler registered above, on every exit path, not here.

// The classification report: what the structural pins saw, printed so a run's own output carries
// the evidence rather than only the verdict.
console.log('');
console.log(SCHEDULER_MODULE + ' module exports, read from Windows PowerShell ' + schedulerModulePsMajor + ' (' + schedulerExports.length + '):');
for (const name of schedulerExports) {
  console.log('  ' + name + ': ' + classifySchedulerExport(name));
}
console.log('');
console.log('every spawn this suite made, in the order it was made (' + spawnClassifications.length + ' spawns):');
for (const entry of spawnClassifications) {
  console.log('  [' + (entry.allowed ? 'allowed' : 'REFUSED') + '] exit ' + entry.status + ' ' + entry.family + ': ' + entry.reason);
  console.log('      ' + entry.description);
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed, ' + skipped + ' skipped');
process.exit(fail > 0 ? 1 : 0);
