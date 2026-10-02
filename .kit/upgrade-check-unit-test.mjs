#!/usr/bin/env node
// Unit test for bin/upgrade-check.mjs (the Claude Code upgrade check).
// Run: node .kit/upgrade-check-unit-test.mjs
// Exits 0 on all-pass, 1 on any failure.
//
// Each case writes its own files under its own temp directory and runs the
// check as its own process, with .kit/fixtures/upgrade-check first on PATH so
// the fake claude there answers every engine invocation. No case launches a
// real engine, a real compiler or a real session, so the suite runs beside a
// live fleet.
//
// The risk this suite exists for is a clean exit that proves nothing, so the
// compile step is driven three ways: the hooks compiling with a control the
// compiler rejects (pass), the hooks failing (triage), and a control the
// compiler accepts (fail, whatever the hooks did).

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const checkPath = resolve(here, '../bin/upgrade-check.mjs');
const fixtures = resolve(here, 'fixtures/upgrade-check');
const root = fs.mkdtempSync(join(os.tmpdir(), 'upgrade-check-'));

// The check's own helpers, imported rather than spawned: the table's
// regeneration is a pure function of the rows, and reading it twice over
// unchanged input is the one reading a spawn cannot take, since every spawn of
// a verb appends rows of its own first.
let mod = null;
let importError = null;
try {
  mod = await import(pathToFileURL(checkPath).href);
} catch (e) {
  importError = e;
}
const api = () => {
  if (!mod) throw new Error('the check did not import: ' + (importError && importError.message));
  return mod;
};

const PROJECT_KEY_SESSION = 'upgrade-check-fixture';
const FIXTURE_FROM = '2.1.282';
const NEW_VERSION = '9.9.9';
// The file a run writes into a scratch folder it made, which is what lets a
// later run empty that folder.
const SCRATCH_MARKER = '.upgrade-check-scratch';

// One case's directory tree: a checkout the check reads, a results directory,
// a scratch folder, a profile holding the session transcript, and the working
// directory the check runs in. The checkout carries what each step reads and
// nothing else: hooks/, the committed types, the manifest, and the fake
// compiler where the case wants one.
function makeCase(name, opts = {}) {
  const dir = join(root, name);
  const paths = {
    dir,
    repo: join(dir, 'repo'),
    results: join(dir, 'results'),
    scratch: join(dir, 'scratch'),
    profile: join(dir, 'profile'),
    workdir: join(dir, 'wd'),
    rundir: join(dir, 'run'),
    calls: join(dir, 'calls.jsonl'),
    jsonl: join(dir, 'results', 'upgrade-checks.jsonl'),
    md: join(dir, 'results', 'upgrade-checks.md'),
  };
  fs.mkdirSync(join(paths.repo, 'hooks'), { recursive: true });
  fs.mkdirSync(join(paths.repo, '.claude', 'types'), { recursive: true });
  fs.mkdirSync(join(paths.repo, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(paths.workdir, { recursive: true });
  fs.mkdirSync(paths.rundir, { recursive: true });

  // The hooks the diff step asks which changed names the plugin reads. Two of
  // the fixture types' three declarations are named here.
  fs.writeFileSync(join(paths.repo, 'hooks', 'index.ts'),
    'import type { PromptSubmitResult, Register } from "claude-code";\nexport const register: Register = () => {};\nexport type R = PromptSubmitResult;\n');
  const newTypes = fs.readFileSync(join(fixtures, 'claude-code.d.ts'), 'utf8');
  // The committed types: the same file with one declaration the hooks do not
  // read taken out, unless the case asks for a change the hooks do read.
  const committed = opts.committedTypes === 'changes-a-name-the-hooks-read'
    ? newTypes.replace('export type Register', 'export type RegisterHook')
    : newTypes.replace(/\n  export type NothingTheHooksRead[^\n]*\n/, '\n');
  fs.writeFileSync(join(paths.repo, '.claude', 'types', 'claude-code.d.ts'), committed);
  // The checkout's own tool-list mirror, which names the plugin's tools. The
  // compile reads this one and never the mirror the scratch session wrote.
  fs.writeFileSync(join(paths.repo, '.claude', 'types', 'claude-code-mcp.d.ts'), '// CHECKOUT_MIRROR: the plugin\'s own tools.\n');
  fs.writeFileSync(join(paths.repo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agentic-plugin' }));
  if (opts.typescript !== false) {
    const bin = join(paths.repo, 'node_modules', 'typescript', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(join(fixtures, 'tsc'), join(bin, 'tsc'));
  }
  if (opts.testFile) fs.writeFileSync(join(paths.repo, 'hooks', 'index.test.ts'), 'export const t = 1;\n');
  for (const rel of opts.extraFiles || []) {
    fs.mkdirSync(dirname(join(paths.repo, rel)), { recursive: true });
    fs.writeFileSync(join(paths.repo, rel), 'export const t = 1;\n');
  }
  // The transcript the version readings come off, under the project key the
  // harness derives from the working directory.
  const project = join(paths.profile, '.claude', 'projects', projectKey(paths.workdir));
  fs.mkdirSync(project, { recursive: true });
  fs.copyFileSync(join(fixtures, 'transcript.jsonl'), join(project, PROJECT_KEY_SESSION + '.jsonl'));
  return paths;
}

// The harness's project key, as bin/supervise-liveness.mjs derives it. Read
// from that module rather than restated, so the two cannot drift.
let projectKeyFn = null;
function projectKey(workdir) {
  if (!projectKeyFn) throw new Error('the liveness module did not import');
  return projectKeyFn(workdir);
}
({ projectKey: projectKeyFn } = await import(pathToFileURL(resolve(here, '../bin/supervise-liveness.mjs')).href));

// Runs the check as its own process, with the fixtures first on PATH and the
// session id and profile the transcript sits under.
function run(paths, args, env = {}) {
  // Windows reads environment names without case, so the inherited Path is
  // dropped by name rather than shadowed: a child handed both Path and PATH
  // resolves against whichever the platform picks.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  const r = spawnSync(process.execPath, [checkPath, ...args.map(String)], {
    cwd: paths.workdir,
    encoding: 'utf8',
    env: {
      ...inherited,
      PATH: fixtures + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
      CLAUDE_CODE_SESSION_ID: PROJECT_KEY_SESSION,
      USERPROFILE: paths.profile,
      HOME: paths.profile,
      FAKE_CLAUDE_CALLS: paths.calls,
      FAKE_CLAUDE_VERSION: NEW_VERSION,
      FAKE_CLAUDE_TYPES_FILE: join(fixtures, 'claude-code.d.ts'),
      ...env,
    },
  });
  const lines = String(r.stdout || '').split('\n').filter((l) => l.trim());
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    verdict: lines.length > 0 ? lines[lines.length - 1] : '',
    rows: readRows(paths),
    calls: readCalls(paths),
  };
}

function readRows(paths) {
  let text;
  try { text = fs.readFileSync(paths.jsonl, 'utf8'); } catch (e) { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function readCalls(paths) {
  let text;
  try { text = fs.readFileSync(paths.calls, 'utf8'); } catch (e) { return []; }
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const step = (rows, name) => rows.filter((r) => r.step === name);
const only = (rows, name) => {
  const hits = step(rows, name);
  assert.equal(hits.length, 1, name + ' rows: ' + hits.length);
  return hits[0];
};
const resultsOf = (rows) => rows.map((r) => r.step + '=' + r.result).join(' ');

// A pre run whose steps all read pass, with step 6 the gap the plugin's
// missing engine tests are. Every other case is this one with one thing
// changed.
function passingPre(name, extraEnv = {}, opts = {}) {
  const paths = makeCase(name, opts);
  const r = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE'], extraEnv);
  return { paths, r };
}

// A ticker that stamps a heartbeat file while the check waits out one
// interval, which is what an advancing heartbeat looks like to post. Returns a
// stop function.
function startHeartbeatTicker(rundir) {
  const script = join(rundir, 'ticker.cjs');
  fs.writeFileSync(script, [
    'const fs = require("node:fs");',
    'const file = process.argv[2];',
    'setInterval(() => {',
    '  try { fs.writeFileSync(file, JSON.stringify({ sessionId: "s", lastSeen: Date.now() })); } catch (e) {}',
    '}, 200);',
  ].join('\n'));
  const child = spawn(process.execPath, [script, join(rundir, 'heartbeat.json')], { stdio: 'ignore' });
  return () => { try { child.kill(); } catch (e) { /* already gone */ } };
}

const cases = [
  // --- The verdict, both directions. ---
  ['every step passes with step 6 the engine-test gap: clear, exit 0', () => {
    const { paths, r } = passingPre('clear');
    assert.equal(r.status, 0, 'exit ' + r.status + ': ' + r.stdout + r.stderr);
    assert.match(r.verdict, new RegExp('^pre: clear to restart the canary onto 9\\.9\\.9 \\(run [0-9TZ]+-[0-9a-f]{4}\\)$'));
    assert.equal(r.rows.length, 7, resultsOf(r.rows));
    assert.equal(resultsOf(r.rows),
      '1. versions=pass 2. types=pass 3. diff=pass 4. compile=pass 5. validate=pass 6. engine tests=gap 7. smoke=pass');
    // Every row carries the run the verdict names, the build tested, the build
    // this session runs and the canary.
    const runId = r.verdict.match(/\(run (.+)\)$/)[1];
    for (const row of r.rows) {
      assert.equal(row.run, runId);
      assert.equal(row.version, NEW_VERSION);
      assert.equal(row.from, FIXTURE_FROM);
      assert.equal(row.canary, 'FIXTURE');
    }
    assert.ok(fs.existsSync(paths.md), 'the table was written');
    assert.ok(fs.existsSync(join(paths.scratch, SCRATCH_MARKER)), 'the scratch folder the run made carries the marker');
  }],
  ['a compile failure reads triage, exit 1, and the rest of the run still reports', () => {
    const { r } = passingPre('compile-fails', { FAKE_TSC_HOOKS_EXIT: '2' });
    assert.equal(r.status, 1, 'exit ' + r.status);
    assert.match(r.verdict, /^pre: triage 4\. compile \(run /);
    assert.equal(only(r.rows, '4. compile').result, 'fail');
    assert.match(only(r.rows, '4. compile').evidence, /do not compile against the new types.*error TS2305/);
    // The steps after the failure still ran and still reported.
    assert.equal(only(r.rows, '5. validate').result, 'pass');
    assert.equal(only(r.rows, '7. smoke').result, 'pass');
  }],

  // --- The control. A compiler that admits the control proves nothing, so
  // the step fails however clean the hooks' own compile was.
  ['a control the compiler accepts turns the compile step to fail, and the verdict to triage', () => {
    const { r } = passingPre('control-compiles', { FAKE_TSC_CONTROL_COMPILES: '1' });
    assert.equal(r.status, 1, 'exit ' + r.status);
    const compile = only(r.rows, '4. compile');
    assert.equal(compile.result, 'fail');
    assert.match(compile.evidence, /^control did not reject/);
    assert.match(r.verdict, /^pre: triage 4\. compile \(run /);
  }],
  ['the passing compile row names the control\'s own diagnostic, so the pass is evidence', () => {
    const { r } = passingPre('control-diagnostic');
    const compile = only(r.rows, '4. compile');
    assert.equal(compile.result, 'pass');
    assert.match(compile.evidence, /memberTheEngineTypesDoNotDeclare/);
    assert.match(compile.evidence, /error TS2339/);
  }],
  ['the compile reads the new engine types and the checkout\'s tool-list mirror, never the mirror the scratch session wrote', () => {
    const { r, paths } = passingPre('mirror-source');
    assert.equal(only(r.rows, '4. compile').result, 'pass', only(r.rows, '4. compile').evidence);
    // The scratch session wrote a mirror, so the case is live: the fake
    // compiler would have refused had the compile read it.
    const probeTypes = join(paths.scratch, 'types-probe', '.claude-plugin', 'types');
    assert.ok(fs.readFileSync(join(probeTypes, 'claude-code-mcp', 'index.d.ts'), 'utf8').includes('SCRATCH_MIRROR'));
    const config = JSON.parse(fs.readFileSync(join(paths.scratch, 'tsconfig.json'), 'utf8'));
    const named = (config.files || []).map((f) => resolve(f));
    assert.ok(named.includes(resolve(paths.scratch, 'claude-code.d.ts')), 'the joined new engine types are read');
    assert.ok(named.includes(resolve(paths.repo, '.claude', 'types', 'claude-code-mcp.d.ts')), 'the checkout mirror is read');
    for (const dir of config.include || []) assert.ok(!resolve(dir).startsWith(resolve(paths.scratch)), 'no scratch directory is included whole: ' + dir);
  }],

  // --- Step 2's probe plugin. ---
  ['step 2 runs the probe plugin the engine loads, under a config directory inside the scratch folder', () => {
    const { paths, r } = passingPre('probe-shape');
    const types = r.calls.filter((c) => c.kind === 'types');
    assert.equal(types.length, 1, JSON.stringify(r.calls.map((c) => c.kind)));
    const call = types[0];
    assert.equal(call.args[call.args.indexOf('-p') + 1], '/version');
    const probeDir = call.args[call.args.indexOf('--plugin-dir') + 1];
    const inScratch = (p) => resolve(p).toLowerCase().startsWith(resolve(paths.scratch).toLowerCase() + sep);
    assert.ok(inScratch(probeDir), 'the probe is under the scratch folder: ' + probeDir);
    assert.equal(resolve(probeDir), resolve(paths.scratch, 'types-probe'));
    // The shape the engine loads: a probe whose module exports nothing, or
    // whose hooks.json carries a module key, loads nothing and writes nothing.
    assert.deepEqual(JSON.parse(fs.readFileSync(join(probeDir, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'upgrade-check-types-probe' });
    assert.deepEqual(JSON.parse(fs.readFileSync(join(probeDir, 'hooks', 'hooks.json'), 'utf8')), { modules: ['./register.js'] });
    const register = fs.readFileSync(join(probeDir, 'hooks', 'register.js'), 'utf8');
    assert.match(register, /export function register\(on\)/);
    assert.match(register, /on\('session\.start', async \(\$, e, next\) => next\(e\)\)/);
    // A run under the real config costs a model call and depends on login.
    assert.ok(call.configDir && inScratch(call.configDir), 'the config directory is under the scratch folder: ' + call.configDir);
    assert.ok(fs.statSync(call.configDir).isDirectory(), 'the config directory exists');
    // The step reads the file the engine wrote at the probe path.
    const row = only(r.rows, '2. types');
    assert.equal(row.result, 'pass', row.evidence);
    assert.ok(row.evidence.includes(join(probeDir, '.claude-plugin', 'types', 'claude-code', 'index.d.ts')), row.evidence);
  }],
  ['step 2 joins the built-in tools\' tables after the interface, and steps 3 and 4 read the joined file', () => {
    const { paths, r } = passingPre('types-joined', { FAKE_CLAUDE_TOOLS_TEXT: '// TOOLS_TABLES: the built-in tools.\n' });
    const engineTypes = join(paths.scratch, 'types-probe', '.claude-plugin', 'types');
    const joined = fs.readFileSync(join(paths.scratch, 'claude-code.d.ts'), 'utf8');
    assert.equal(joined, fs.readFileSync(join(engineTypes, 'claude-code', 'index.d.ts'), 'utf8') + '// TOOLS_TABLES: the built-in tools.\n');
    const row = only(r.rows, '2. types');
    assert.equal(row.result, 'pass', row.evidence);
    assert.ok(row.evidence.includes(join(engineTypes, 'claude-code', 'index.d.ts')) && row.evidence.includes(join(engineTypes, 'claude-code-tools', 'index.d.ts')), row.evidence);
    // Step 3 diffs the joined file, so the tables' one line counts as one more
    // added line than the same run with no tables.
    const added = (rows) => Number(only(rows, '3. diff').evidence.match(/^\+(\d+) and/)[1]);
    assert.equal(added(r.rows), added(passingPre('types-unjoined').r.rows) + 1, only(r.rows, '3. diff').evidence);
  }],
  ['a probe run that writes the interface but no built-in tools\' tables reads fail at step 2, naming the missing file', () => {
    const { r } = passingPre('no-tools', { FAKE_CLAUDE_TOOLS_WRITE: 'none' });
    const row = only(r.rows, '2. types');
    assert.equal(row.result, 'fail');
    assert.ok(row.evidence.includes(join('claude-code-tools', 'index.d.ts')), row.evidence);
    assert.match(only(r.rows, '4. compile').evidence, /step 2 wrote no types file/);
  }],
  ['the probe run carries no login key from the environment, while the other steps keep theirs', () => {
    const keys = { ANTHROPIC_API_KEY: 'fake-key', ANTHROPIC_AUTH_TOKEN: 'fake-token', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth' };
    const { r } = passingPre('probe-login', keys);
    const types = r.calls.filter((c) => c.kind === 'types');
    assert.equal(types.length, 1);
    assert.deepEqual(types[0].loginKeys, [], 'the probe ran with no login key');
    const smoke = r.calls.filter((c) => c.kind === 'smoke');
    assert.deepEqual(smoke[0].loginKeys, Object.keys(keys), 'the smoke run kept the environment whole');
  }],
  ['a probe run that exits 1 having written the declarations reads pass, with the exit code as evidence', () => {
    // The engine exits 1 under an empty config directory, since no login
    // exists there, and has already written the files by then.
    const { r } = passingPre('types-exit-1', { FAKE_CLAUDE_TYPES_EXIT: '1' });
    const row = only(r.rows, '2. types');
    assert.equal(row.result, 'pass', row.evidence);
    assert.match(row.evidence, /^exit 1 \(.+\); .* first line: /);
  }],
  ['the fixture refuses the retired types slash command at its unknown branch, and a bare /version without --plugin-dir', () => {
    const paths = makeCase('old-invocation');
    // The retired command's name, split so the sweep for it over the tree stays empty.
    const retired = '/plugin-' + 'types';
    for (const args of [['-p', retired], ['-p', '/version']]) {
      const r = spawnSync(process.execPath, [join(fixtures, 'claude'), ...args], {
        cwd: paths.workdir, encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE_CALLS: paths.calls },
      });
      assert.equal(r.status, 64, args.join(' ') + ' exited ' + r.status);
      assert.match(r.stderr, /fake claude: no case for/);
    }
    assert.deepEqual(readCalls(paths).map((c) => c.kind), ['unknown', 'unknown'], 'both hit the unknown branch, not the types case');
  }],

  // --- The steps' own readings. ---
  ['a changed declaration the hooks read is a warn, and a warn is still clear', () => {
    const { r } = passingPre('diff-warn', {}, { committedTypes: 'changes-a-name-the-hooks-read' });
    const diff = only(r.rows, '3. diff');
    assert.equal(diff.result, 'warn', diff.evidence);
    // Register is the name that changed and that the hooks read. RegisterHook,
    // the name it changed from, is named nowhere in the hooks, so it is not
    // reported: the step answers which changed declarations the plugin reads.
    assert.match(diff.evidence, /^\+1 and -1 lines; changed declarations the hooks read: Register$/);
    assert.equal(r.status, 0, 'a warn does not read as triage');
  }],
  ['a test file in the checkout runs the engine tests rather than reading the gap', () => {
    const { r } = passingPre('engine-tests', {}, { testFile: true });
    const engine = only(r.rows, '6. engine tests');
    assert.equal(engine.result, 'pass', engine.evidence);
    assert.match(engine.evidence, /^1 test file\(s\), exit 0/);
  }],
  ['the engine tests run in the scratch folder, like every other engine step that reads files', () => {
    const { r, paths } = passingPre('engine-tests-cwd', {}, { testFile: true });
    const test = r.calls.filter((c) => c.kind === 'test');
    assert.equal(test.length, 1, JSON.stringify(r.calls.map((c) => c.kind)));
    assert.equal(fs.realpathSync(test[0].cwd), fs.realpathSync(paths.scratch));
  }],
  ['a test file under .claude/worktrees or .kit is not the plugin\'s, so step 6 still reads the gap', () => {
    const { r } = passingPre('engine-tests-sibling', {}, {
      extraFiles: ['.claude/worktrees/other/hooks/index.test.ts', '.kit/scratch/probe.test.ts'],
    });
    const engine = only(r.rows, '6. engine tests');
    assert.equal(engine.result, 'gap', engine.evidence);
    assert.equal(r.calls.filter((c) => c.kind === 'test').length, 0, 'no engine test run was made');
  }],
  ['a test file under .claude outside worktrees is still found, so the skip is that folder alone', () => {
    const { r } = passingPre('engine-tests-claude-other', {}, { extraFiles: ['.claude/checks/index.test.ts'] });
    assert.equal(only(r.rows, '6. engine tests').result, 'pass', only(r.rows, '6. engine tests').evidence);
  }],
  ['a build with no plugin test subcommand reads skipped with the CLI\'s own error, and skipped is triage', () => {
    const { r } = passingPre('engine-absent', { FAKE_CLAUDE_TEST_OUT: 'error: unknown command "test"', FAKE_CLAUDE_TEST_EXIT: '1' }, { testFile: true });
    const engine = only(r.rows, '6. engine tests');
    assert.equal(engine.result, 'skipped', engine.evidence);
    assert.match(engine.evidence, /unknown command "test"/);
    assert.equal(r.status, 1, 'step 6 clears on pass or gap only');
    assert.match(r.verdict, /^pre: triage 6\. engine tests \(run /);
  }],
  ['a test run that exits 0 is read on its exit code, even where its output reads like a missing subcommand', () => {
    const { r } = passingPre('engine-exit-0', { FAKE_CLAUDE_TEST_OUT: 'test "unknown command" handling: ok' }, { testFile: true });
    assert.equal(only(r.rows, '6. engine tests').result, 'pass', only(r.rows, '6. engine tests').evidence);
  }],
  ['typescript missing from the checkout reads fail with the install it needs', () => {
    const { r } = passingPre('no-typescript', {}, { typescript: false });
    const compile = only(r.rows, '4. compile');
    assert.equal(compile.result, 'fail');
    assert.match(compile.evidence, /^typescript is not installed in .*; run npm install there$/);
  }],
  ['no types file written reads fail at step 2, and steps 3 and 4 say what they could not read', () => {
    const { r } = passingPre('no-types', { FAKE_CLAUDE_TYPES_WRITE: 'none' });
    assert.equal(only(r.rows, '2. types').result, 'fail');
    assert.match(only(r.rows, '3. diff').evidence, /step 2 wrote no types file/);
    assert.match(only(r.rows, '4. compile').evidence, /step 2 wrote no types file/);
    assert.equal(r.status, 1);
  }],
  ['a manifest the engine refuses reads fail with the findings, not the exit code alone', () => {
    const { r } = passingPre('validate-fails', {
      FAKE_CLAUDE_VALIDATE_EXIT: '1',
      FAKE_CLAUDE_VALIDATE_OUT: 'Validating plugin manifest\n\nFound 2 errors:\n\n  userConfig.jevLive.type: Invalid input\n  userConfig.jevLive: Invalid input\n',
    });
    const validate = only(r.rows, '5. validate');
    assert.equal(validate.result, 'fail');
    assert.match(validate.evidence, /exit 1; Found 2 errors: userConfig\.jevLive\.type: Invalid input userConfig\.jevLive: Invalid input/);
  }],
  ['a smoke log naming the plugin beside one of the five readings is a warn carrying the line', () => {
    const { r } = passingPre('smoke-warn', { FAKE_CLAUDE_SMOKE_LOG: 'engine: ready\nplugin agentic-plugin: prompt.submit skipped\n' });
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'warn', smoke.evidence);
    assert.match(smoke.evidence, /1 log line\(s\) naming agentic-plugin .*prompt\.submit skipped/);
    assert.equal(r.status, 0, 'a warn does not read as triage');
  }],
  ['a smoke log carrying one of the readings on a line that does not name the plugin stays pass', () => {
    const { r } = passingPre('smoke-other-plugin', { FAKE_CLAUDE_SMOKE_LOG: 'plugin agentic-plugin: admitted\nplugin claude-kit: prompt.submit skipped\nengine: WARN something else\n' });
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'pass');
    // The pass says how much of the log named the plugin at all.
    assert.match(smoke.evidence, /\b1 of 5 line\(s\)/);
    assert.match(smoke.evidence, /agentic-plugin/);
  }],
  ['the smoke row names the path the engine read the plugin\'s hooks from, the last where the log names several', () => {
    const log = [
      'Read hooks.json for plugin agentic-plugin (enabled=true): C:/cache/agentic-plugin/old/hooks/hooks.json',
      'plugin agentic-plugin: admitted',
      'Read hooks.json for plugin agentic-plugin (enabled=true): C:/cache/agentic-plugin/new/hooks/hooks.json',
    ].join('\n');
    const { r } = passingPre('smoke-hooks-path', { FAKE_CLAUDE_SMOKE_LOG: log });
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'pass', smoke.evidence);
    assert.match(smoke.evidence, /C:\/cache\/agentic-plugin\/new\/hooks\/hooks\.json/);
    assert.doesNotMatch(smoke.evidence, /agentic-plugin\/old\//);
  }],
  ['a smoke log with no hooks.json line for the plugin says so, and the result stands on the other readings', () => {
    const { r } = passingPre('smoke-no-hooks-path');
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'pass', smoke.evidence);
    assert.match(smoke.evidence, /no "Read hooks\.json for plugin agentic-plugin" line/);
  }],
  ['the smoke run is handed the debug log as an absolute path in the scratch folder', () => {
    const { r, paths } = passingPre('smoke-debug-path');
    const smoke = r.calls.find((c) => c.kind === 'smoke');
    const i = smoke.args.indexOf('--debug-file');
    const given = smoke.args[i + 1];
    assert.ok(isAbsolute(given), 'absolute: ' + given);
    assert.equal(resolve(given), resolve(paths.scratch, 'smoke.log'));
  }],
  ['a smoke log that never names the plugin reads fail, since its silence says nothing about the plugin', () => {
    const { r } = passingPre('smoke-never-named', { FAKE_CLAUDE_SMOKE_LOG: 'plugin claude-kit: admitted\nengine: ready\n' });
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'fail', smoke.evidence);
    assert.match(smoke.evidence, /no line in .* names agentic-plugin/);
    assert.equal(r.status, 1);
  }],
  ['a plugin the engine failed to load reads fail and the verdict triage, never a warn', () => {
    // The shape Claude Code 2.1.283 writes when it refuses the manifest.
    const refused = '[ERROR] "Failed to load plugin agentic-plugin@agent-persona: Plugin agentic-plugin has an invalid manifest file"';
    const { r } = passingPre('smoke-load-failed', { FAKE_CLAUDE_SMOKE_LOG: 'engine: ready\n' + refused + '\n' });
    const smoke = only(r.rows, '7. smoke');
    assert.equal(smoke.result, 'fail', smoke.evidence);
    assert.match(smoke.evidence, /Failed to load plugin agentic-plugin/);
    assert.match(r.verdict, /^pre: triage 7\. smoke \(run /);
    assert.equal(r.status, 1);
  }],
  ['the passing smoke row counts the lines that name the plugin, so its silence is readable', () => {
    const { r } = passingPre('smoke-named');
    const evidence = only(r.rows, '7. smoke').evidence;
    assert.match(evidence, /\b2 of 4 line\(s\)/);
    assert.match(evidence, /agentic-plugin/);
  }],
  ['a smoke run that writes no debug log reads fail rather than an empty pass', () => {
    const { r } = passingPre('smoke-no-log', { FAKE_CLAUDE_SMOKE_WRITE: 'none' });
    assert.equal(only(r.rows, '7. smoke').result, 'fail');
    assert.match(only(r.rows, '7. smoke').evidence, /no debug log at /);
  }],

  // --- The function-hooks flag, which the engine no longer needs to load the
  // plugin: no step's child environment carries it, under any value.
  ["no step's child environment carries CLAUDE_CODE_ENABLE_FUNCTION_HOOKS", () => {
    // Cleared in the launch environment first: a machine that still sets the
    // flag globally would otherwise pass it to every step and fail the case
    // for a reason the check does not own. A test file is planted so step 6
    // spawns too, and every step that spawns is swept.
    const { paths, r } = passingPre('function-hooks', { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '' }, { testFile: true });
    assert.deepEqual([...new Set(r.calls.map((c) => c.kind))].sort(), ['smoke', 'test', 'types', 'validate', 'version']);
    const withFlag = r.calls.filter((c) => c.functionHooks !== '').map((c) => c.kind);
    assert.deepEqual(withFlag, [], JSON.stringify(r.calls.map((c) => [c.kind, c.functionHooks])));
    // The types and smoke steps run in the scratch folder, so the plugin finds no persona there.
    const scratchCalls = r.calls.filter((c) => c.kind === 'types' || c.kind === 'smoke');
    assert.deepEqual(scratchCalls.map((c) => c.kind).sort(), ['smoke', 'types']);
    for (const call of scratchCalls) {
      assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(paths.scratch));
    }
  }],
  ['a scratch folder an earlier run made is emptied at the start of a run, so its types file cannot be read as this build\'s', () => {
    const paths = makeCase('scratch-emptied');
    const staleDir = join(paths.scratch, 'types-probe', '.claude-plugin', 'types', 'claude-code');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(join(paths.scratch, SCRATCH_MARKER), '');
    fs.writeFileSync(join(staleDir, 'index.d.ts'), '// Written by Claude Code 0.0.1.\n');
    // The tables beside it too, so only the emptying can turn step 2 to fail.
    const staleTools = join(paths.scratch, 'types-probe', '.claude-plugin', 'types', 'claude-code-tools');
    fs.mkdirSync(staleTools, { recursive: true });
    fs.writeFileSync(join(staleTools, 'index.d.ts'), '');
    fs.writeFileSync(join(paths.scratch, 'leftover.txt'), 'from an earlier run');
    const r = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE'],
      { FAKE_CLAUDE_TYPES_WRITE: 'none' });
    assert.equal(fs.existsSync(join(paths.scratch, 'leftover.txt')), false, 'the folder was emptied');
    assert.equal(only(r.rows, '2. types').result, 'fail', 'no types file was read from the emptied folder');
    assert.ok(fs.existsSync(join(paths.scratch, SCRATCH_MARKER)), 'the emptied folder is marked again');
  }],
  ['a non-empty scratch folder no run of the check made exits 2 before any step, and is left untouched', () => {
    const paths = makeCase('scratch-unmarked');
    fs.mkdirSync(paths.scratch, { recursive: true });
    fs.writeFileSync(join(paths.scratch, 'notes.txt'), 'the operator\'s own file');
    const r = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch]);
    assert.equal(r.status, 2, r.stdout);
    // The rule that refused it: the marker, named in the reason.
    assert.match(r.stdout, /^upgrade-check: cannot run: .*\.upgrade-check-scratch/m);
    assert.equal(fs.readFileSync(join(paths.scratch, 'notes.txt'), 'utf8'), 'the operator\'s own file');
    assert.deepEqual(fs.readdirSync(paths.scratch), ['notes.txt']);
    assert.equal(readRows(paths).length, 0, 'no rows were written');
    assert.deepEqual(readCalls(paths).map((c) => c.kind), ['version'], 'only the version read that names the folder ran');
  }],
  ['a scratch folder that exists empty is used, and the run marks it as its own', () => {
    const paths = makeCase('scratch-empty');
    fs.mkdirSync(paths.scratch, { recursive: true });
    const r = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch]);
    assert.equal(r.status, 0, r.stdout);
    assert.ok(fs.existsSync(join(paths.scratch, SCRATCH_MARKER)), 'the marker was written');
  }],

  // --- Append-only results, and a table that regenerates to the same bytes.
  ['two runs on one version give two runs in the table, and the record is only appended to', () => {
    const paths = makeCase('two-runs');
    const first = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE']);
    const firstRows = readRows(paths).length;
    assert.equal(firstRows, 7);
    const second = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE']);
    const rows = readRows(paths);
    assert.equal(rows.length, 14, 'the record holds both runs');
    const firstId = first.verdict.match(/\(run (.+)\)$/)[1];
    const secondId = second.verdict.match(/\(run (.+)\)$/)[1];
    assert.notEqual(firstId, secondId);
    // The first run's rows are still there, byte for byte in their own lines.
    assert.equal(rows.filter((r) => r.run === firstId).length, 7);
    assert.equal(rows.filter((r) => r.run === secondId).length, 7);
    const table = fs.readFileSync(paths.md, 'utf8');
    assert.equal((table.match(/^## /gm) || []).length, 1, 'one version heading');
    assert.equal((table.match(/^### /gm) || []).length, 2, 'two run headings');
    // Newest first: the second run's heading comes before the first's.
    assert.ok(table.indexOf('run `' + secondId + '`') < table.indexOf('run `' + firstId + '`'), 'newest run first');
  }],
  ['a third regeneration over unchanged rows produces the same table, byte for byte', () => {
    const paths = makeCase('idempotent');
    run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE']);
    run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', paths.scratch, '--canary', 'FIXTURE']);
    const onDisk = fs.readFileSync(paths.md, 'utf8');
    const rows = readRows(paths);
    const third = api().renderTable(rows);
    assert.equal(third, onDisk, 'the third regeneration matches the second run\'s table');
    assert.equal(api().renderTable(rows), third, 'and a fourth matches the third');
  }],
  ['evidence cut from command output cannot forge a column in the table', () => {
    const { paths, r } = passingPre('table-guard', {
      FAKE_CLAUDE_VALIDATE_OUT: 'Validating plugin manifest\n\nFound 1 warning:\n\n  root: pipes | here | and | there\n',
    });
    const validate = only(r.rows, '5. validate');
    assert.match(validate.evidence, /pipes \| here \| and \| there/, 'the record keeps the text as it was read');
    const line = fs.readFileSync(paths.md, 'utf8').split('\n').find((l) => l.startsWith('| 5. validate'));
    assert.ok(line, 'the table carries the row');
    // Every pipe inside the cells is escaped, so the row still has exactly the
    // three columns the header names.
    const columns = line.split(/(?<!\\)\|/);
    assert.equal(columns.length, 5, 'three columns and the row\'s own ends: ' + JSON.stringify(line));
    assert.match(columns[3], /pipes \\\| here \\\| and \\\| there/);
  }],
  ['a result outside the closed list is recorded as fail rather than passed through', () => {
    const built = api().row('run-1', '9.9.9', '2.1.282', 'FIXTURE', '4. compile', 'clear', 'the compiler was happy');
    assert.equal(built.result, 'fail');
    assert.match(built.evidence, /"clear"/);
    assert.match(built.evidence, /the compiler was happy/);
    assert.deepEqual([...api().RESULTS], ['pass', 'warn', 'gap', 'fail', 'skipped']);
  }],

  // --- The hard exits. None of them writes a row: a run that cannot record
  // its rows is not a run.
  ['a missing --repo, --results or hooks directory exits 2 before any step runs', () => {
    const paths = makeCase('hard-exits');
    const noRepo = run(paths, ['pre', '--results', paths.results]);
    assert.equal(noRepo.status, 2, noRepo.stdout);
    assert.match(noRepo.stdout, /^upgrade-check: cannot run: --repo /);
    const noResults = run(paths, ['pre', '--repo', paths.repo]);
    assert.equal(noResults.status, 2, noResults.stdout);
    assert.match(noResults.stdout, /^upgrade-check: cannot run: --results /);
    const notACheckout = run(paths, ['pre', '--repo', paths.workdir, '--results', paths.results]);
    assert.equal(notACheckout.status, 2, notACheckout.stdout);
    assert.match(notACheckout.stdout, /has no hooks\/ directory/);
    assert.equal(readRows(paths).length, 0, 'no rows were written');
    assert.equal(readCalls(paths).length, 0, 'no engine invocation was made');
  }],
  ['a results directory that cannot be written exits 2 before any step runs', () => {
    const paths = makeCase('results-unwritable');
    // A file where the directory should be: the run cannot record its rows.
    const asFile = join(paths.dir, 'results-file');
    fs.writeFileSync(asFile, 'not a directory');
    const r = run(paths, ['pre', '--repo', paths.repo, '--results', asFile]);
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, /cannot be written/);
    assert.equal(readCalls(paths).length, 0, 'no engine invocation was made');
  }],
  ['an unexpected error exits 3 with a failed line, so a crash never reads as a triage verdict', () => {
    const paths = makeCase('unexpected-error');
    // A directory where the results file should be passes the writable check
    // and fails the append, an error the script has no reason for.
    fs.mkdirSync(join(paths.results, 'upgrade-checks.jsonl'), { recursive: true });
    const r = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^upgrade-check: failed: /m);
    assert.doesNotMatch(r.stdout, /^pre: (clear|triage)/m);
    assert.match(r.stdout, /^7\. smoke: /m, 'the step lines print before the append that failed');
    assert.match(r.stdout.trim().split('\n').pop(), /^upgrade-check: failed: /, 'the failed line is last');
    assert.match(r.stderr, /EISDIR|EPERM|illegal operation/i, 'the stack goes to stderr');
  }],
  ['a scratch folder holding the checkout or the results exits 2, since the scratch folder is emptied', () => {
    const paths = makeCase('scratch-guard');
    const insideRepo = run(paths, ['pre', '--repo', paths.repo, '--results', paths.results, '--scratch', join(paths.repo, 'scratch')]);
    assert.equal(insideRepo.status, 2, insideRepo.stdout);
    assert.match(insideRepo.stdout, /hold one another/);
    const holdsResults = run(paths, ['pre', '--repo', paths.repo, '--results', join(paths.dir, 'r2', 'inner'), '--scratch', join(paths.dir, 'r2')]);
    assert.equal(holdsResults.status, 2, holdsResults.stdout);
    assert.match(holdsResults.stdout, /hold one another/);
  }],
  ['a verb that is not pre or post exits 2 with the usage, so a direct launch is never silent', () => {
    const paths = makeCase('bad-verb');
    for (const args of [[], ['check'], ['--repo', paths.repo]]) {
      const r = run(paths, args);
      assert.equal(r.status, 2, JSON.stringify(args) + ' exited ' + r.status);
      assert.match(r.stdout, /the verb is "pre" or "post"/);
    }
  }],

  // --- post, both directions on the version check.
  ['post: the transcript version matching the build on disk reads clear, exit 0', () => {
    const paths = makeCase('post-clear');
    // The run the pre half recorded, so post's rows join it and carry its canary.
    fs.mkdirSync(paths.results, { recursive: true });
    fs.writeFileSync(paths.jsonl, JSON.stringify(api().row('run-post-1', FIXTURE_FROM, FIXTURE_FROM, 'FIXTURE', '1. versions', 'pass', 'seeded by the pre half')) + '\n');
    fs.writeFileSync(join(paths.rundir, 'settings.json'), JSON.stringify({ pluginConfigs: { 'agentic-plugin': { options: { heartbeatMs: 50 } } } }));
    fs.writeFileSync(join(paths.rundir, 'supervisor.log'),
      'LAUNCH child-3 pid 1234\nGATE poll FAIL heartbeat still fresh\nGATE poll FAIL heartbeat still fresh\nHEARTBEAT ok\n');
    // The heartbeat as it stands before the check reads it, then a ticker that
    // advances it while the check waits out one interval.
    fs.writeFileSync(join(paths.rundir, 'heartbeat.json'), JSON.stringify({ sessionId: 's', lastSeen: Date.now() - 60000 }));
    const stop = startHeartbeatTicker(paths.rundir);
    let r;
    try {
      r = run(paths, ['post', '--run', 'run-post-1', '--results', paths.results, '--rundir', paths.rundir, '--tools', 'ok'],
        { FAKE_CLAUDE_VERSION: FIXTURE_FROM });
    } finally {
      stop();
    }
    assert.equal(r.status, 0, 'exit ' + r.status + ': ' + r.stdout + r.stderr);
    assert.equal(r.verdict, 'post: fleet clear to restart onto ' + FIXTURE_FROM + ' (run run-post-1)');
    const rows = r.rows.filter((row) => row.step.startsWith('8'));
    assert.equal(resultsOf(rows), '8a. version=pass 8b. heartbeat=pass 8c. supervisor log=pass 8d. tools=pass');
    assert.match(only(rows, '8c. supervisor log').evidence, /2 expected pre-launch gate line\(s\)/);
    for (const row of rows) assert.equal(row.canary, 'FIXTURE', 'the canary is carried from the pre half');
  }],
  ['post: a transcript version behind the build on disk reads triage, exit 1', () => {
    const paths = makeCase('post-triage');
    fs.writeFileSync(join(paths.rundir, 'settings.json'), JSON.stringify({ pluginConfigs: { 'agentic-plugin': { options: { heartbeatMs: 50 } } } }));
    fs.writeFileSync(join(paths.rundir, 'heartbeat.json'), JSON.stringify({ sessionId: 's', lastSeen: 1 }));
    fs.writeFileSync(join(paths.rundir, 'supervisor.log'),
      'LAUNCH child-4 pid 99\nERROR the child never stamped a heartbeat\n');
    const r = run(paths, ['post', '--run', 'run-post-2', '--results', paths.results, '--rundir', paths.rundir, '--tools', 'fail: the relay reply was not delivered']);
    assert.equal(r.status, 1, 'exit ' + r.status);
    assert.equal(resultsOf(r.rows), '8a. version=fail 8b. heartbeat=fail 8c. supervisor log=fail 8d. tools=fail');
    assert.match(only(r.rows, '8a. version').evidence, /transcript reads 2\.1\.282 and the build on disk is 9\.9\.9/);
    assert.match(only(r.rows, '8b. heartbeat').evidence, /lastSeen stood at 1 across 50ms plus five seconds/);
    assert.match(only(r.rows, '8c. supervisor log').evidence, /the child never stamped a heartbeat/);
    assert.match(only(r.rows, '8d. tools').evidence, /the relay reply was not delivered/);
    assert.equal(r.verdict, 'post: triage 8a. version, 8b. heartbeat, 8c. supervisor log, 8d. tools (run run-post-2)');
  }],
  ['post: the supervisor\'s heartbeat-absent note on a healthy launch is counted as expected, never as an error', () => {
    // No heartbeat file, so 8b fails at once and the case does not wait out
    // an interval; 8c is the step under test.
    const paths = makeCase('post-heartbeat-note');
    fs.writeFileSync(join(paths.rundir, 'supervisor.log'), [
      '2026-09-27T10:00:00Z LAUNCH child-3 pid 1234',
      '2026-09-27T10:02:00Z HEARTBEAT_ABSENT child-3: /d/personas/X/run/child-3/heartbeat.json has not been written past the startup grace, so the heartbeat reads as not silent for this child',
      '',
    ].join('\n'));
    const r = run(paths, ['post', '--run', 'run-post-4', '--results', paths.results, '--rundir', paths.rundir, '--tools', 'ok']);
    const log = only(r.rows, '8c. supervisor log');
    assert.equal(log.result, 'pass', log.evidence);
    assert.match(log.evidence, /\b1 expected heartbeat-absent note/);
  }],
  ['post: a HEARTBEAT_ABSENT line in any other shape is still an error', () => {
    const paths = makeCase('post-heartbeat-other');
    fs.writeFileSync(join(paths.rundir, 'supervisor.log'), [
      '2026-09-27T10:00:00Z LAUNCH child-3 pid 1234',
      '2026-09-27T10:02:00Z HEARTBEAT_ABSENT child-3: the heartbeat never arrived and the child was stopped',
      '',
    ].join('\n'));
    const r = run(paths, ['post', '--run', 'run-post-5', '--results', paths.results, '--rundir', paths.rundir, '--tools', 'ok']);
    const log = only(r.rows, '8c. supervisor log');
    assert.equal(log.result, 'fail', log.evidence);
    assert.match(log.evidence, /the heartbeat never arrived/);
  }],
  ['post: a --tools value that is neither ok nor a fail reason reads fail rather than passing', () => {
    const paths = makeCase('post-tools');
    fs.writeFileSync(join(paths.rundir, 'settings.json'), JSON.stringify({ pluginConfigs: { p: { options: { heartbeatMs: 50 } } } }));
    const r = run(paths, ['post', '--run', 'run-post-3', '--results', paths.results, '--rundir', paths.rundir, '--tools', 'looked fine']);
    assert.equal(only(r.rows, '8d. tools').result, 'fail');
    assert.match(only(r.rows, '8d. tools').evidence, /--tools reads "looked fine", which is neither "ok" nor "fail: <reason>"/);
    assert.equal(r.status, 1);
  }],
  ['post: a missing --run, --results, --rundir or --tools exits 2', () => {
    const paths = makeCase('post-hard-exits');
    const args = { run: 'r', results: paths.results, rundir: paths.rundir, tools: 'ok' };
    for (const missing of Object.keys(args)) {
      const list = ['post'];
      for (const [k, v] of Object.entries(args)) if (k !== missing) list.push('--' + k, v);
      const r = run(paths, list);
      assert.equal(r.status, 2, 'without --' + missing + ' it exited ' + r.status);
      assert.match(r.stdout, new RegExp('cannot run: --' + missing + ' '));
    }
  }],

  // --- The engine binary is resolved by this script rather than by the
  // platform, which is what lets the fake answer and what keeps a file in the
  // scratch folder from answering instead.
  ['resolveCommand finds the fixture first on PATH and nothing for a name that is not there', () => {
    const sep = process.platform === 'win32' ? ';' : ':';
    const found = api().resolveCommand('claude', { PATH: fixtures + sep + process.env.PATH });
    assert.ok(found, 'the fixture resolved');
    // The fixture is a shebang script, so it is launched through this node.
    assert.equal(found.file, process.execPath);
    assert.equal(found.args.length, 1);
    assert.equal(fs.realpathSync(found.args[0]), fs.realpathSync(join(fixtures, 'claude')));
    assert.equal(api().resolveCommand('a-command-no-machine-has', { PATH: fixtures }), null);
  }],
  ['resolveCommand passes over a script whose shebang names no node, and takes the next one on PATH', () => {
    const dir = join(root, 'sh-shebang');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho not the engine\n');
    const sep = process.platform === 'win32' ? ';' : ':';
    const found = api().resolveCommand('claude', { PATH: dir + sep + fixtures });
    assert.ok(found, 'the fixture behind it resolved');
    assert.equal(found.file, process.execPath);
    assert.equal(fs.realpathSync(found.args[0]), fs.realpathSync(join(fixtures, 'claude')));
    // With only the shell script there, nothing resolves.
    assert.equal(api().resolveCommand('claude', { PATH: dir }), null);
  }],
  ['resolveCommand routes a shebang through node where it names node by path', () => {
    const dir = join(root, 'node-path-shebang');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'viapath'), '#!/usr/local/bin/node\nprocess.exit(0);\n');
    const found = api().resolveCommand('viapath', { PATH: dir });
    assert.ok(found, 'resolved');
    assert.equal(found.file, process.execPath);
  }],
  ['resolveCommand passes over a .cmd shim and takes the file beside it', () => {
    const dir = join(root, 'cmd-shim');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'shimmed.cmd'), '@echo off\r\nnode %*\r\n');
    fs.writeFileSync(join(dir, 'shimmed'), '#!/usr/bin/env node\nprocess.exit(0);\n');
    const found = api().resolveCommand('shimmed', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });
    assert.ok(found, 'something resolved');
    assert.equal(found.file, process.execPath);
    assert.equal(fs.realpathSync(found.args[0]), fs.realpathSync(join(dir, 'shimmed')));
    // With only the shim there, nothing resolves rather than a cmd.exe launch.
    fs.rmSync(join(dir, 'shimmed'));
    assert.equal(api().resolveCommand('shimmed', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }), null);
  }],
  ['a program is launched directly, and a script through this node', () => {
    const dir = join(root, 'program');
    fs.mkdirSync(dir, { recursive: true });
    // A file that is not a script: no shebang, so it is handed to the platform
    // as it stands. process.execPath itself is the one program every machine
    // running this suite has.
    const sep = process.platform === 'win32' ? ';' : ':';
    const nodeDir = dirname(process.execPath);
    const found = api().resolveCommand('node', { PATH: nodeDir + sep + process.env.PATH, PATHEXT: process.env.PATHEXT });
    assert.ok(found, 'node resolved');
    assert.equal(found.args.length, 0, 'a program takes no leading argument');
    assert.equal(fs.realpathSync(found.file).toLowerCase(), fs.realpathSync(process.execPath).toLowerCase());
  }],

  // --- A step whose child outlives its timeout is a reading, not a throw.
  ['a child that outlives its timeout reads as timed out rather than throwing', () => {
    const r = api().runChild(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);'], { timeoutMs: 800 });
    assert.equal(r.timedOut, true, JSON.stringify(r));
    assert.equal(r.status, null);
    assert.equal(api().STEP_TIMEOUT_MS, 180000, 'the step timeout the steps run under');
  }],
  ['a child whose output passes the buffer cap reads as that, never as timed out', () => {
    const r = api().runChild(process.execPath, ['-e', 'process.stdout.write("x".repeat(17 * 1024 * 1024))'], { timeoutMs: 60000 });
    assert.equal(r.timedOut, false, JSON.stringify({ ...r, stdout: r.stdout.length }));
    assert.match(r.error, /output exceeded 16 MB/);
  }],
  ['a child that cannot be spawned reads as an error rather than throwing', () => {
    const r = api().runChild(join(root, 'no-such-program-here'), [], { timeoutMs: 2000 });
    assert.equal(r.timedOut, false);
    assert.ok(r.error, 'the spawn error is reported: ' + JSON.stringify(r));
  }],

  // --- The evidence guards, on their own.
  ['evidence is folded on every line terminator the bracket rule names, not just LF and CR', () => {
    for (const terminator of ['\n', '\r\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
      const folded = api().evidenceLine('before' + terminator + 'after');
      assert.equal(folded, 'before after', JSON.stringify(terminator) + ' folded to ' + JSON.stringify(folded));
    }
  }],
  ['a heartbeat caught mid-write is read again rather than reported unreadable, and one that stays unreadable is null', () => {
    const dir = join(root, 'heartbeat-settle');
    fs.mkdirSync(dir, { recursive: true });
    const file = join(dir, 'heartbeat.json');
    // Empty, as a read that lands between the truncate and the write sees it.
    fs.writeFileSync(file, '');
    const writer = spawn(process.execPath, ['-e',
      'setTimeout(() => require("fs").writeFileSync(process.argv[1], JSON.stringify({ lastSeen: 42 })), 150)', file], { stdio: 'ignore' });
    try {
      assert.equal(api().readLastSeen(file), 42, 'the re-read found the finished write');
    } finally { writer.kill(); }
    fs.writeFileSync(file, '{ not json');
    assert.equal(api().readLastSeen(file), null, 'a file that never settles reads as unreadable');
  }],
  ['a declaration name is read from code, never from a comment that happens to read like one', () => {
    const names = (text) => [...api().declarationNames(text)].sort();
    assert.deepEqual(names('  // as the one type root, holding this file'), []);
    assert.deepEqual(names('   * a function root that returns the interface Foo'), []);
    assert.deepEqual(names('  /* the class Bar */'), []);
    assert.deepEqual(names('  export type Register = () => void; // the type root'), ['Register']);
    assert.deepEqual(names('  interface Hooks {'), ['Hooks']);
  }],
  ['a cell escapes the separator and the escape itself', () => {
    assert.equal(api().cell('a|b'), 'a\\|b');
    assert.equal(api().cell('a\\|b'), 'a\\\\\\|b');
    assert.equal(api().cell('a\u2028b'), 'a b');
    assert.equal(api().cell('a`b'), 'a\\`b', 'a backtick cannot open a code span');
  }],
  ['a version token is the first word only where it reads as a version, since it names the scratch folder', () => {
    assert.equal(api().versionToken('2.1.283 (Claude Code)'), '2.1.283');
    assert.equal(api().versionToken('1.0.0-beta+7 (Claude Code)'), '1.0.0-beta+7');
    assert.equal(api().versionToken('../../elsewhere (Claude Code)'), 'unknown');
    assert.equal(api().versionToken('a\\b'), 'unknown');
  }],
  ['a run id always carries four hex characters, whatever the random source returns', () => {
    const real = Math.random;
    Math.random = () => 0.5;
    try {
      assert.match(api().newRunId(new Date('2026-09-27T14:18:55Z')), /^20260927T141855Z-[0-9a-f]{4}$/);
    } finally {
      Math.random = real;
    }
  }],
  ['the running session\'s version is read off the transcript\'s tail, never the whole file', () => {
    const profile = join(root, 'tail-profile');
    const project = join(profile, '.claude', 'projects', projectKey(process.cwd()));
    fs.mkdirSync(project, { recursive: true });
    const file = join(project, 'tail-session.jsonl');
    const pad = JSON.stringify({ type: 'x', pad: 'p'.repeat(1000) }) + '\n';
    const env = { CLAUDE_CODE_SESSION_ID: 'tail-session', USERPROFILE: profile, HOME: profile };
    // A version only in a record older than the tail reads unknown.
    fs.writeFileSync(file, JSON.stringify({ version: '0.0.1' }) + '\n' + pad.repeat(400));
    assert.equal(api().runningSessionVersion(env), 'unknown');
    // A version inside the tail is read, the newest one.
    fs.appendFileSync(file, JSON.stringify({ version: '2.1.283' }) + '\n' + pad);
    assert.equal(api().runningSessionVersion(env), '2.1.283');
  }],
  ['the heartbeat interval is read from the settings file under either plugin id, and falls back to the default', () => {
    const dir = join(root, 'heartbeat-ms');
    fs.mkdirSync(dir, { recursive: true });
    const write = (body) => fs.writeFileSync(join(dir, 'settings.json'), body);
    write(JSON.stringify({ pluginConfigs: { 'agentic-plugin': { options: { heartbeatMs: 1234 } } } }));
    assert.equal(api().readHeartbeatMs(dir), 1234);
    write(JSON.stringify({ pluginConfigs: { 'agentic-plugin@agent-persona': { options: { heartbeatMs: 4321 } } } }));
    assert.equal(api().readHeartbeatMs(dir), 4321);
    write('\uFEFF' + JSON.stringify({ pluginConfigs: { p: { options: { heartbeatMs: 77 } } } }));
    assert.equal(api().readHeartbeatMs(dir), 77, 'a byte-order mark is stripped');
    write('{"pluginConfigs":');
    assert.equal(api().readHeartbeatMs(dir), api().DEFAULT_HEARTBEAT_MS);
    write(JSON.stringify({ pluginConfigs: { p: { options: { heartbeatMs: 'soon' } } } }));
    assert.equal(api().readHeartbeatMs(dir), api().DEFAULT_HEARTBEAT_MS);
    assert.equal(api().readHeartbeatMs(join(dir, 'nowhere')), api().DEFAULT_HEARTBEAT_MS);
  }],
  ['the supervisor log window starts at the newest launch line, so an older child\'s errors are not read', () => {
    const window = api().logSinceNewestLaunch('LAUNCH child-1\nERROR old and accounted for\nLAUNCH child-2\nall well\n');
    assert.deepEqual(window, ['LAUNCH child-2', 'all well', '']);
  }],
];

let pass = 0;
let fail = 0;
for (const [name, body] of cases) {
  try {
    body();
    console.log('PASS: ' + name);
    pass++;
  } catch (e) {
    console.error('FAIL: ' + name + ': ' + e.message);
    fail++;
  }
}
fs.rmSync(root, { recursive: true, force: true });
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
