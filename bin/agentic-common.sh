#!/usr/bin/env bash
# bin/agentic-common.sh - Shared supervisor/test helpers.
# Sourced by bin/supervise.sh and .kit/live-common.sh.
# Provides: wait_persona_free, refuse_if_persona_live, emit_settings_json,
#           ensure_settings_plugin_ids, ensure_settings_arming,
#           ensure_settings_jev_mode, settings_path_json,
#           read_settings_coordinator_persona,
#           read_settings_architect_persona,
#           read_settings_fleet_roster,
#           valid_persona_name,
#           find_global_store, list_installed_stores, poll_decisions,
#           poll_heartbeat.
# COORDINATOR_PERSONA and ARCHITECT_PERSONA are exported on both settings
# branches: emit_settings_json exports the names it writes, and the two
# read_settings_*_persona functions print the names a provided file resolves
# to, for the caller to export.
# All functions use W2 read-error semantics: a read error is a transient mid-write
# race, treated as "live" (or "not ready"), never an abort. The timeout is the only
# exit. refuse_if_persona_live is the one exception: it is a start-only check with
# no later poll to recover on, so it fails closed on a read error after its re-reads
# instead of waiting it out.

# --- Plugin ids ---
# The two ids pluginConfigs is keyed by: --plugin-dir load, and installed load.
AGENTIC_PLUGIN_DEV_ID="agentic-plugin"
AGENTIC_PLUGIN_INSTALLED_ID="agentic-plugin@agent-persona"

# --- Contention guards ---
# The bound below which a commons entry counts as live, matching the plugin's
# staleAfterMs default (hooks/index.ts). A fleet launched with heartbeatMs
# above this value is read as stale here while its own arbitration still
# treats it as live.
PERSONA_STALE_MS=90000

# --- Profiles ---
# Selected by PROFILE=full|short (default: short).
# full: TICK_MS=30000, NUDGE_IDLE_MS=120000, GIT_PROBE_MS=120000
# short: TICK_MS=10000, NUDGE_IDLE_MS=45000, GIT_PROBE_MS=30000
PROFILE="${PROFILE:-short}"
case "$PROFILE" in
  full)
    TICK_MS=30000
    NUDGE_IDLE_MS=120000
    GIT_PROBE_MS=120000
    ;;
  short)
    TICK_MS=10000
    NUDGE_IDLE_MS=45000
    GIT_PROBE_MS=30000
    ;;
  *)
    echo "Unknown PROFILE: $PROFILE (use full or short)" >&2
    exit 1
    ;;
esac

# --- settings_path_json ---
# Usage: settings_path_json <variable-name> <path>
# Prints <path> as the body of a JSON string, for emit_settings_json to splice
# between quotes. It holds a filesystem path to what a JSON string can carry:
# a backslash, which a Windows path is written with, is doubled so the parser
# reads back the path that was given; a double quote, which would close the
# string, and a control character, which JSON refuses raw, are refused with an
# ERROR line naming the variable, and the function returns 1. Every path the
# emitter writes goes through here.
settings_path_json() {
  local name="$1" value="$2"
  case "$value" in
    *'"'*)
      echo "ERROR: emit_settings_json: $name '$value' must not hold a double quote" >&2
      return 1
      ;;
    *[[:cntrl:]]*)
      echo "ERROR: emit_settings_json: $name must not hold a control character" >&2
      return 1
      ;;
  esac
  # The pattern and the replacement are held in a variable rather than
  # written as escapes, because bash 5.2 changed how a backslash inside a
  # substitution pattern is read and the literal form matches nothing there.
  local backslash='\'
  printf '%s' "${value//"$backslash"/"$backslash$backslash"}"
}

# --- emit_settings_json ---
# Usage: emit_settings_json <output-file>
# Emits the settings.json JSON for the --settings flag.
# Carries: controllerTickMs, nudgeIdleMs, nudgeFloorMs, gitProbeMs, heartbeatMs,
#          staleAfterMs, arming (always "owner": every supervisor launch is an owner),
#          coordinatorPersona (from COORDINATOR_PERSONA, default "coordinator")
#          and architectPersona (from ARCHITECT_PERSONA, which has no default:
#          the key is omitted where the variable is unset or empty),
#          and fleetRoster (from FLEET_ROSTER, which has no default either
#          and is omitted the same way), and supervisorMailbox, heartbeatPath
#          and supervisorHeartbeatPath (from SUPERVISOR_MAILBOX, HEARTBEAT_PATH
#          and SUPERVISOR_HEARTBEAT_PATH, each omitted the same way); and,
#          outside the plugin options, the harness's own autoContinue, always
#          false.
# Exports COORDINATOR_PERSONA and ARCHITECT_PERSONA to the values it wrote, so
# a caller can compare its own persona against the same names without parsing
# the settings file. This is the emit branch's half of those exports; the
# provided-settings branch reads the same names back through
# read_settings_coordinator_persona and read_settings_architect_persona.
emit_settings_json() {
  local out="$1"
  local self_review_opts=""
  if [ -n "${SELF_REVIEW_EVERY_TURNS:-}" ]; then
    self_review_opts=",\"selfReviewEveryTurns\":$SELF_REVIEW_EVERY_TURNS"
  fi
  local cost_opts=""
  if [ -n "${COST_SUMMARY_EVERY_N_TICKS:-}" ]; then
    cost_opts=",\"costSummaryEveryNTicks\":$COST_SUMMARY_EVERY_N_TICKS"
  fi
  if [ -n "${COST_MAX_NUDGES_PER_HOUR:-}" ]; then
    cost_opts="$cost_opts,\"costMaxNudgesPerHour\":$COST_MAX_NUDGES_PER_HOUR"
  fi
  if [ -n "${COST_MAX_PLUGIN_CALLS_PER_HOUR:-}" ]; then
    cost_opts="$cost_opts,\"costMaxPluginCallsPerHour\":$COST_MAX_PLUGIN_CALLS_PER_HOUR"
  fi
  if [ -n "${COST_BACKOFF_AFTER_TICKS:-}" ]; then
    cost_opts="$cost_opts,\"costBackoffAfterTicks\":$COST_BACKOFF_AFTER_TICKS"
  fi
  if [ -n "${COST_BACKOFF_MAX_MS:-}" ]; then
    cost_opts="$cost_opts,\"costBackoffMaxMs\":$COST_BACKOFF_MAX_MS"
  fi
  # jevMode is the decision seam's kill switch: off makes no shadow call and
  # writes no journal line, shadow is the working default. A set JEV_MODE
  # outside that pair is refused the way an invalid COST_* value is, rather
  # than reaching the child where the seam would otherwise fold it to off.
  local jev_opts=""
  if [ -n "${JEV_MODE:-}" ]; then
    case "$JEV_MODE" in
      off|shadow) ;;
      *)
        echo "ERROR: emit_settings_json: JEV_MODE '$JEV_MODE' must be 'off' or 'shadow'" >&2
        return 1
        ;;
    esac
    jev_opts=",\"jevMode\":\"$JEV_MODE\""
  fi
  # Plan item 6: pass the persona the supervisor was given through to the
  # child, so it claims that persona at session.start instead of always
  # falling back to the plugin's hardcoded "default". $PERSONA is supervise.sh's
  # own second positional argument, visible here because this function is
  # sourced into the caller's shell rather than run in a subshell.
  # Every value below is spliced into JSON unescaped, so each is held to a
  # shape that cannot close a string or an object and that JSON accepts:
  # digits with no leading zero for the numbers, letters, digits, underscore
  # and hyphen for the persona and for coordinatorPersona and architectPersona
  # (the same valid_persona_name check, since all three are spliced the same
  # way).
  local var
  for var in TICK_MS NUDGE_IDLE_MS GIT_PROBE_MS NUDGE_FLOOR_MS HEARTBEAT_MS STALE_AFTER_MS \
    SELF_REVIEW_EVERY_TURNS COST_SUMMARY_EVERY_N_TICKS \
    COST_MAX_NUDGES_PER_HOUR COST_MAX_PLUGIN_CALLS_PER_HOUR COST_BACKOFF_AFTER_TICKS COST_BACKOFF_MAX_MS; do
    case "${!var:-0}" in
      ''|*[!0-9]*|0[0-9]*)
        echo "ERROR: emit_settings_json: $var '${!var}' is not a non-negative integer without leading zeros" >&2
        return 1
        ;;
    esac
  done
  if ! valid_persona_name "${PERSONA:-default}"; then
    echo "ERROR: emit_settings_json: PERSONA '$PERSONA' may hold only letters, digits, underscore and hyphen" >&2
    return 1
  fi
  local persona_opt=""
  if [ -n "${PERSONA:-}" ]; then
    persona_opt=",\"persona\":\"$PERSONA\""
  fi
  # Section 6: a supervisor launch is always an owner, never a reader or an
  # off session, so this value is fixed rather than read from an env var.
  local coordinator_persona="${COORDINATOR_PERSONA:-coordinator}"
  if ! valid_persona_name "$coordinator_persona"; then
    echo "ERROR: emit_settings_json: COORDINATOR_PERSONA '$coordinator_persona' may hold only letters, digits, underscore and hyphen" >&2
    return 1
  fi
  if [ "$coordinator_persona" = "default" ]; then
    echo "ERROR: emit_settings_json: COORDINATOR_PERSONA must not be 'default'" >&2
    return 1
  fi
  # This export lets a caller compare its own persona against the name this
  # function just wrote into coordinatorPersona, without parsing the
  # settings file itself.
  export COORDINATOR_PERSONA="$coordinator_persona"
  # architectPersona names the persona that receives the architect's standing
  # instruction. It carries no default, unlike coordinatorPersona: an unset or
  # empty variable omits the key, and a launch reading a file without it builds
  # no architect instruction for any persona, so a fleet with no architect
  # carries no architect setting either. The name is held to the same character
  # class as the two values above, since it is spliced into JSON the same way,
  # and "default" is refused because every unnamed launch carries that persona
  # and the charter would reach all of them.
  local architect_persona="${ARCHITECT_PERSONA:-}"
  local architect_opt=""
  if [ -n "$architect_persona" ]; then
    if ! valid_persona_name "$architect_persona"; then
      echo "ERROR: emit_settings_json: ARCHITECT_PERSONA '$architect_persona' may hold only letters, digits, underscore and hyphen" >&2
      return 1
    fi
    if [ "$architect_persona" = "default" ]; then
      echo "ERROR: emit_settings_json: ARCHITECT_PERSONA must not be 'default'" >&2
      return 1
    fi
    # One persona cannot hold both seats. The two names gate two standing
    # instructions that contradict each other in one priming write: route
    # design asks to the architect, and answer the coordinator by naming
    # yourself, with a standing goal held and not held at once.
    if [ "$architect_persona" = "$coordinator_persona" ]; then
      echo "ERROR: emit_settings_json: ARCHITECT_PERSONA and COORDINATOR_PERSONA are both '$architect_persona'; one persona cannot hold both seats" >&2
      return 1
    fi
    architect_opt=",\"architectPersona\":\"$architect_persona\""
  fi
  export ARCHITECT_PERSONA="$architect_persona"
  # fleetRoster names the roster file the plugin reads: its fleet_status tool
  # on demand, and its controller tick to watch each roster persona's health.
  # The setting carries no default, as architectPersona does not: an unset or
  # empty variable omits the key, and a launch reading a file without it has no
  # fleet to read, on which the tool reports that it has no roster and the tick
  # watches nothing.
  # The value is a filesystem path rather than a name, so it is held to what a
  # JSON string can carry rather than to the persona character class. Three
  # characters decide that: a backslash, which a Windows path is written with
  # and which is doubled here so the parser reads back the path that was given;
  # a double quote, which would close the string; and a control character,
  # which JSON refuses raw. The last two are refused, neither belonging in a
  # path a fleet runs from.
  local fleet_roster="${FLEET_ROSTER:-}"
  local roster_opt="" path_json
  if [ -n "$fleet_roster" ]; then
    path_json=$(settings_path_json FLEET_ROSTER "$fleet_roster") || return 1
    roster_opt=",\"fleetRoster\":\"$path_json\""
  fi
  # The three paths a supervised child is handed by the supervisor that reads
  # them, each exported by bin/supervise.sh before this runs and each omitted
  # where its variable is unset or empty, so a launch that sets none of them
  # writes the options exactly as before: SUPERVISOR_MAILBOX, the mailbox the
  # controller tick drains; HEARTBEAT_PATH, the workdir sidecar the pre-launch
  # gate reads; SUPERVISOR_HEARTBEAT_PATH, the heartbeat file only the child
  # writes and the liveness verdict reads.
  local supervisor_opts=""
  if [ -n "${SUPERVISOR_MAILBOX:-}" ]; then
    path_json=$(settings_path_json SUPERVISOR_MAILBOX "$SUPERVISOR_MAILBOX") || return 1
    supervisor_opts="$supervisor_opts,\"supervisorMailbox\":\"$path_json\""
  fi
  if [ -n "${HEARTBEAT_PATH:-}" ]; then
    path_json=$(settings_path_json HEARTBEAT_PATH "$HEARTBEAT_PATH") || return 1
    supervisor_opts="$supervisor_opts,\"heartbeatPath\":\"$path_json\""
  fi
  if [ -n "${SUPERVISOR_HEARTBEAT_PATH:-}" ]; then
    path_json=$(settings_path_json SUPERVISOR_HEARTBEAT_PATH "$SUPERVISOR_HEARTBEAT_PATH") || return 1
    supervisor_opts="$supervisor_opts,\"supervisorHeartbeatPath\":\"$path_json\""
  fi
  # pluginConfigs is keyed by plugin id: the manifest name under --plugin-dir,
  # and "<name>@<marketplace>" for the installed copy. The installed form is
  # absent from the engine's type file, and options under the other id are
  # ignored without an error, so the same options are written under both.
  # .kit/settings-plugin-key-test.sh pins both ids against the two manifests.
  local options="{\"controllerTickMs\":$TICK_MS,\"nudgeIdleMs\":$NUDGE_IDLE_MS,\"nudgeFloorMs\":${NUDGE_FLOOR_MS:-5000},\"gitProbeMs\":$GIT_PROBE_MS,\"heartbeatMs\":${HEARTBEAT_MS:-30000},\"staleAfterMs\":${STALE_AFTER_MS:-90000}$self_review_opts$cost_opts$jev_opts$persona_opt,\"arming\":\"owner\",\"coordinatorPersona\":\"$coordinator_persona\"$architect_opt$roster_opt$supervisor_opts}"
  # autoContinue is the harness's own setting, at the top level rather than
  # under a plugin id. Off, a child that trips a usage limit ends its turn and
  # sits idle rather than parking until the limit resets, and the supervisor's
  # liveness verdict reads that child alive for as long as the limit is its
  # newest word. Interactive sessions never read this file.
  cat > "$out" <<EOF
{"autoContinue":false,"pluginConfigs":{"$AGENTIC_PLUGIN_DEV_ID":{"options":$options},"$AGENTIC_PLUGIN_INSTALLED_ID":{"options":$options}}}
EOF
}

# --- ensure_settings_plugin_ids ---
# Usage: ensure_settings_plugin_ids <settings-file>
# For a settings file the caller already provided: where options sit under only
# one of the two plugin ids, copies them under the other, leaving every option
# as the caller wrote it. An id whose options object is missing or empty counts
# as absent. The file is replaced by rename, so an interrupted write never leaves
# it truncated. Returns 1 when the file is not valid JSON, when it, its
# pluginConfigs, an id entry or an options value is not a plain object, or when
# the write fails.
ensure_settings_plugin_ids() {
  node -e '
const fs = require("fs");
const [file, devId, installedId] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: ensure_settings_plugin_ids: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
if (s.pluginConfigs === undefined) process.exit(0);
const pc = s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
for (const id of [devId, installedId]) {
  if (pc[id] === undefined) continue;
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options !== undefined && !plain(pc[id].options)) fail("has " + id + " options that are not an object");
}
const has = (id) => pc[id] !== undefined && plain(pc[id].options) && Object.keys(pc[id].options).length > 0;
let from, to;
if (has(devId) && !has(installedId)) { from = devId; to = installedId; }
else if (has(installedId) && !has(devId)) { from = installedId; to = devId; }
else process.exit(0);
pc[to] = Object.assign({}, pc[to], { options: Object.assign({}, pc[from].options) });
const tmp = file + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  fail("could not be rewritten: " + e.message);
}
' "$1" "$AGENTIC_PLUGIN_DEV_ID" "$AGENTIC_PLUGIN_INSTALLED_ID"
}

# --- ensure_settings_arming ---
# Usage: ensure_settings_arming <settings-file>
# For a settings file the caller already provided: under each of the two
# plugin ids, creates pluginConfigs, the id entry and its options object
# where any of them is absent, and sets options.arming to "owner" where an
# id's options omit the key, leaving every other option the caller wrote
# exactly as written. Where an id's options.arming is present and is not
# exactly "owner", the function refuses and exits 1 without writing: a
# supervisor launch always drives a goal tree as an owner, so a settings
# file naming another tier is a mistake to refuse rather than a value to
# honor. The same pass sets the harness's top-level autoContinue to false
# where the file omits it, as emit_settings_json writes it, and refuses any
# other value the same way it refuses another arming tier, since a
# supervised child always runs with the usage-limit pause off. It also writes
# supervisorMailbox, heartbeatPath and supervisorHeartbeatPath under each id
# from SUPERVISOR_MAILBOX, HEARTBEAT_PATH and SUPERVISOR_HEARTBEAT_PATH, where
# each is set, overwriting a differing value rather than completing an absent
# one: the supervisor reads those paths itself, so a value naming anything
# else would have the child write where nothing reads. An unset variable
# leaves its key as the file has it. The file is
# replaced by rename, same as ensure_settings_plugin_ids, so an interrupted
# write never leaves it truncated. Returns 1 on the same conditions that
# function does, with the same error-line shape, plus the arming and
# autoContinue refusals above; exits 0 when nothing needed changing.
ensure_settings_arming() {
  node -e '
const fs = require("fs");
const [file, devId, installedId, mailbox, heartbeatPath, supervisorHeartbeatPath] = process.argv.slice(1);
const paths = [["supervisorMailbox", mailbox || ""], ["heartbeatPath", heartbeatPath || ""], ["supervisorHeartbeatPath", supervisorHeartbeatPath || ""]];
const fail = (msg) => { console.error("ERROR: ensure_settings_arming: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
let changed = false;
if (s.pluginConfigs === undefined) { s.pluginConfigs = {}; changed = true; }
const pc = s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
for (const id of [devId, installedId]) {
  if (pc[id] === undefined) { pc[id] = {}; changed = true; }
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options === undefined) { pc[id].options = {}; changed = true; }
  const opts = pc[id].options;
  if (!plain(opts)) fail("has " + id + " options that are not an object");
  if (opts.arming === undefined) { opts.arming = "owner"; changed = true; }
  else if (opts.arming !== "owner") fail("carries arming '"'"'" + opts.arming + "'"'"' under " + id + "; a supervisor launch is always owner");
  for (const [key, value] of paths) {
    if (value !== "" && opts[key] !== value) { opts[key] = value; changed = true; }
  }
}
if (s.autoContinue === undefined) { s.autoContinue = false; changed = true; }
else if (s.autoContinue !== false) fail("carries autoContinue " + JSON.stringify(s.autoContinue) + "; a supervised child always runs with autoContinue false");
if (!changed) process.exit(0);
const tmp = file + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  fail("could not be rewritten: " + e.message);
}
' "$1" "$AGENTIC_PLUGIN_DEV_ID" "$AGENTIC_PLUGIN_INSTALLED_ID" "${SUPERVISOR_MAILBOX:-}" "${HEARTBEAT_PATH:-}" "${SUPERVISOR_HEARTBEAT_PATH:-}"
}

# --- ensure_settings_jev_mode ---
# Usage: ensure_settings_jev_mode <settings-file>
# For a settings file the caller already provided: where JEV_MODE is set in
# the environment, writes it as options.jevMode under each of the two plugin
# ids, creating pluginConfigs, the id entry and its options object where any
# of them is absent, and leaving every other option the caller wrote exactly
# as written. Where JEV_MODE is unset or empty the file is left alone, so a
# hand-edited value survives a launch that says nothing about the mode.
#
# This one overwrites where ensure_settings_arming completes. The two keys
# answer different questions. arming is a property of the launch, always
# owner, so a file naming another tier is a mistake to refuse. jevMode is the
# operator current intent, carried from the roster through the keeper, and a
# kill switch that could not change a value an earlier launch wrote would be
# unable to turn anything off on any machine that has ever run.
#
# An invalid value is refused here on the same rule emit_settings_json uses,
# rather than written or folded, so the two branches cannot disagree about
# what a bad value means. The file is replaced by rename, same as its two
# siblings, so an interrupted write never leaves it truncated.
ensure_settings_jev_mode() {
  if [ -z "${JEV_MODE:-}" ]; then
    return 0
  fi
  case "$JEV_MODE" in
    off|shadow) ;;
    *)
      echo "ERROR: ensure_settings_jev_mode: JEV_MODE $JEV_MODE must be off or shadow" >&2
      return 1
      ;;
  esac
  node -e '
const fs = require("fs");
const [file, devId, installedId, mode] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: ensure_settings_jev_mode: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
let changed = false;
if (s.pluginConfigs === undefined) { s.pluginConfigs = {}; changed = true; }
const pc = s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
for (const id of [devId, installedId]) {
  if (pc[id] === undefined) { pc[id] = {}; changed = true; }
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options === undefined) { pc[id].options = {}; changed = true; }
  const opts = pc[id].options;
  if (!plain(opts)) fail("has " + id + " options that are not an object");
  if (opts.jevMode !== mode) { opts.jevMode = mode; changed = true; }
}
if (!changed) process.exit(0);
const tmp = file + ".tmp-" + process.pid;
try {
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
} catch (e) {
  try { fs.unlinkSync(tmp); } catch (_) {}
  fail("could not be rewritten: " + e.message);
}
' "$1" "$AGENTIC_PLUGIN_DEV_ID" "$AGENTIC_PLUGIN_INSTALLED_ID" "$JEV_MODE"
}
# --- read_settings_coordinator_persona ---
# Usage: read_settings_coordinator_persona <settings-file> <dev_mode: 0|1>
# For a settings file the caller already provided: prints the coordinator
# persona name the plugin will resolve from it, so the caller can export
# COORDINATOR_PERSONA on the provided branch to the same value the emit
# branch exports. Only the options under the id the launch loads are read,
# dev_mode 1 being the --plugin-dir id and 0 the installed id, the same flag
# find_global_store takes: the plugin reads its own id's options and nothing
# under the other, and a file naming both ids is left as written by
# ensure_settings_plugin_ids, so the two may carry different values. The
# rule is the plugin's own (hooks/index.ts, the coordinatorPersona read): a
# string that is non-empty after trim, carries no ":" and is bracket-safe
# once trimmed (no "[", "]", ",", whitespace, control or format character),
# and is not "default", is taken trimmed; anything else resolves to
# "coordinator", a key missing under the loaded id included, whatever the
# other id carries. Returns 1 on the same shapes ensure_settings_plugin_ids
# refuses (not JSON, not an object, a pluginConfigs, id entry or options
# value that is not an object), with the same error-line shape, and prints
# nothing then.
read_settings_coordinator_persona() {
  local dev_mode="${2:-1}"
  local id="$AGENTIC_PLUGIN_INSTALLED_ID"
  if [ "$dev_mode" -eq 1 ]; then
    id="$AGENTIC_PLUGIN_DEV_ID"
  fi
  node -e '
const fs = require("fs");
const [file, id] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: read_settings_coordinator_persona: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
const pc = s.pluginConfigs === undefined ? {} : s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
let value;
if (pc[id] !== undefined) {
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options !== undefined && !plain(pc[id].options)) fail("has " + id + " options that are not an object");
  if (plain(pc[id].options)) value = pc[id].options.coordinatorPersona;
}
const usable = typeof value === "string" && value.trim() !== "" && !value.includes(":")
  && !/[\[\],]/.test(value.trim()) && !/[\s\p{Cc}\p{Cf}]/u.test(value.trim());
console.log(usable && value.trim() !== "default" ? value.trim() : "coordinator");
' "$1" "$id"
}

# --- read_settings_architect_persona ---
# Usage: read_settings_architect_persona <settings-file> [dev_mode: 0|1, default 1]
# Prints the architectPersona a settings file the caller provided carries, so
# bin/supervise.sh can export ARCHITECT_PERSONA on the provided branch to the
# same value the emit branch exports. The setting is the supervisor's own: the
# plugin under hooks/ reads coordinatorPersona and never this key, so this read
# is the only consumer. The plugin id the launch loads is picked by dev_mode
# exactly as in read_settings_coordinator_persona. The name rule is
# valid_persona_name's own class, the one emit_settings_json holds
# ARCHITECT_PERSONA to: a string that after trim is a non-empty run of letters,
# digits, underscore and hyphen, and is not "default", is taken trimmed. The
# read side and the emit side hold one class because the value is spliced into
# the coordinator persona's standing instruction in bin/supervise.sh, at the
# agentic_say target and at the fleet row it names, and a settings file sits in
# a run directory the persona running there can rewrite. A missing key
# or an empty string prints the empty string, because this setting
# has no default: an empty result is a launch with no architect, on which no
# persona receives the architect's standing instruction. Returns 1 on the same shapes
# read_settings_coordinator_persona refuses, and on a present value outside the
# persona character class or naming "default", the two values emit_settings_json
# refuses, so a mis-set name is a refused launch named in the log rather than a
# fleet that comes up with no architect; the error-line shape is the same, and
# it prints nothing then.
read_settings_architect_persona() {
  local dev_mode="${2:-1}"
  local id="$AGENTIC_PLUGIN_INSTALLED_ID"
  if [ "$dev_mode" -eq 1 ]; then
    id="$AGENTIC_PLUGIN_DEV_ID"
  fi
  node -e '
const fs = require("fs");
const [file, id] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: read_settings_architect_persona: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
const pc = s.pluginConfigs === undefined ? {} : s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
let value;
if (pc[id] !== undefined) {
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options !== undefined && !plain(pc[id].options)) fail("has " + id + " options that are not an object");
  if (plain(pc[id].options)) value = pc[id].options.architectPersona;
}
if (value !== undefined && typeof value !== "string") fail("has an architectPersona that is not a string");
const name = typeof value === "string" ? value.trim() : "";
if (name !== "" && !/^[A-Za-z0-9_-]+$/.test(name)) fail("resolves architectPersona to \u0027" + name + "\u0027, which may hold only letters, digits, underscore and hyphen");
if (name === "default") fail("resolves architectPersona to \u0027default\u0027, and architectPersona must not be \u0027default\u0027");
console.log(name);
' "$1" "$id"
}

# --- read_settings_fleet_roster ---
# Usage: read_settings_fleet_roster <settings-file> [dev_mode: 0|1, default 1]
# Prints the roster path the plugin will resolve from a settings file the caller
# provided, so the provided branch can read back what the emit branch writes.
# The plugin id the launch loads is picked by dev_mode exactly as in
# read_settings_coordinator_persona. The rule is the plugin's own
# (hooks/index.ts, the fleetRoster read): a string is taken trimmed, and
# anything else, a missing key under the loaded id included, resolves to the
# empty string, which is a launch with no fleet to read. There is no default
# path to fall back to, so an empty result is the whole of that state. Returns 1
# on the same shapes read_settings_coordinator_persona refuses (not JSON, not an
# object, a pluginConfigs, id entry or options value that is not an object),
# with the same error-line shape, and prints nothing then. Nothing in the
# launch calls this: it exists so the shell side can pin the plugin's rule
# under test, the supervisor needing no roster path of its own.
read_settings_fleet_roster() {
  local dev_mode="${2:-1}"
  local id="$AGENTIC_PLUGIN_INSTALLED_ID"
  if [ "$dev_mode" -eq 1 ]; then
    id="$AGENTIC_PLUGIN_DEV_ID"
  fi
  node -e '
const fs = require("fs");
const [file, id] = process.argv.slice(1);
const fail = (msg) => { console.error("ERROR: read_settings_fleet_roster: " + file + " " + msg); process.exit(1); };
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { fail("is not valid JSON: " + e.message); }
if (!plain(s)) fail("is not a JSON object");
const pc = s.pluginConfigs === undefined ? {} : s.pluginConfigs;
if (!plain(pc)) fail("has a pluginConfigs value that is not an object");
let value;
if (pc[id] !== undefined) {
  if (!plain(pc[id])) fail("has a " + id + " entry that is not an object");
  if (pc[id].options !== undefined && !plain(pc[id].options)) fail("has " + id + " options that are not an object");
  if (plain(pc[id].options)) value = pc[id].options.fleetRoster;
}
console.log(typeof value === "string" ? value.trim() : "");
' "$1" "$id"
}

# --- valid_persona_name ---
# Usage: valid_persona_name <name>; returns 0 for a non-empty name of letters,
# digits, underscore and hyphen, 1 otherwise.
valid_persona_name() {
  case "$1" in
    ''|*[!A-Za-z0-9_-]*) return 1 ;;
  esac
  return 0
}

# --- find_global_store ---
# Plan item 6: the commons store's filename is load-mode-specific -
# "agentic-plugin_inline-<hash>.json" under --plugin-dir, and
# "agentic-plugin_<marketplace-name>-<hash>.json" for an installed plugin
# (confirmed live: "agentic-plugin_agent-persona-<hash>.json" for this
# repo's own marketplace). Once both load modes have ever run on one
# machine, both files can exist at once, and "take the first match"
# silently picks the wrong one for whichever mode this run is in. The
# caller's own dev_mode (whether --dev/--plugin-dir was given) says which
# glob is actually correct, so filter on it rather than guess.
# Single-sourced here for bin/supervise.sh, .kit/live-common.sh (and every
# live-*-test.sh through it), and any future caller - each used to carry
# its own copy, and a live-all.sh run caught the drift live: one caller's
# missing dev_mode filter resolved to the installed store while every
# child in the run used --plugin-dir, so the pre-gate read the wrong
# store's claims and let suites start inside each other's staleness window.
# Default is dev_mode=1: every .kit/*.sh caller runs under --plugin-dir,
# and bin/supervise.sh always passes its own DEV_MODE explicitly.
# Usage: find_global_store [dev_mode: 0|1, default 1]
find_global_store() {
  local dev_mode="${1:-1}"
  local f
  if [ -d "$HOME/.claude/plugins/store" ]; then
    if [ "$dev_mode" -eq 1 ]; then
      for f in "$HOME/.claude/plugins/store"/agentic-plugin_inline-*.json; do
        if [ -f "$f" ]; then
          echo "$f"
          return 0
        fi
      done
    else
      # Installed mode: the first store list_installed_stores names, so
      # this branch and the runner's refuse-at-start check share one filter.
      f="$(list_installed_stores | head -n 1)"
      if [ -n "$f" ]; then
        echo "$f"
        return 0
      fi
    fi
  fi
  echo ""
  return 0
}

# --- list_installed_stores ---
# Prints every installed-mode commons store, one path per line: each
# agentic-plugin_*.json under the plugin store directory that is not an
# inline (dev-tree) store. This is the one filter that decides what counts
# as an installed store. find_global_store's installed branch takes the
# first line and .kit/live-all.sh's refuse-at-start check reads every
# line, so the two cannot drift apart. Prints nothing when the directory
# is absent or holds no such file. Reads $HOME at call time.
# Usage: list_installed_stores
list_installed_stores() {
  local f
  [ -d "$HOME/.claude/plugins/store" ] || return 0
  for f in "$HOME/.claude/plugins/store"/agentic-plugin_*.json; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      agentic-plugin_inline-*) continue ;;
    esac
    echo "$f"
  done
  return 0
}
# --- wait_persona_free ---
# T9/V3: pre-gate - wait until no live persona claim exists in the commons store.
# Fails closed on a read error (V3). Prints live=/oldest_age= per poll (V3).
# W2: a read error is a transient mid-write race, not an abort.
# Usage: wait_persona_free <store-path> [timeout-seconds]
wait_persona_free() {
  local store="${1:-.agentic-personas.json}"
  local timeout="${2:-120}"
  local n=0
  local store_w
  store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
  [ -f "$store" ] || { echo "pre-gate FAIL: store not found: $store" >&2; return 1; }
  echo "pre-gate: waiting for no live persona claim (store: $store, timeout: ${timeout}s)..."
  while true; do
    local line live rc
    line=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
const stale = 90000;
let live = 0, oldest = 0;
for (const key of keys) {
  const e = s[key];
  if (e.lastSeen && (now - e.lastSeen) < stale && e.claims) {
    for (const c of e.claims) {
      if (c.resource === 'persona:default') { live++; if (oldest === 0 || e.lastSeen < oldest) oldest = e.lastSeen; }
    }
  }
}
console.log('live=' + live + ' oldest_age=' + (oldest ? Math.round((now - oldest) / 1000) : 0) + 's');
" "$store_w")
    rc=$?
    if [ $rc -ne 0 ] || echo "$line" | grep -q '^ERROR'; then
      # W2: a read error is a transient mid-write race, not an abort.
      # Treat as live=1 for this poll and let the timeout be the only exit.
      echo "pre-gate poll: ERROR (transient read error, retrying): $line"
      n=$((n + 5))
      [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s (last: $line)"; return 1; }
      sleep 5
      continue
    fi
    live=$(echo "$line" | sed -n 's/.*live=\([0-9]*\).*/\1/p')
    echo "pre-gate poll: $line"
    if [ "${live:-0}" = "0" ]; then
      echo "pre-gate passed (no live claims)"
      return 0
    fi
    n=$((n + 5))
    [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s ($line)"; return 1; }
    sleep 5
  done
}

# --- refuse_if_persona_live ---
# Start-only refuse-at-start check, beside wait_persona_free's own wait.
# Reads every given store path once, with no polling, and refuses the moment
# any store holds a live persona: claim of any name (a commons: key whose
# lastSeen is within stale_after_ms, holding a claim whose resource starts
# with "persona:"). A store path that does not exist is skipped (installed
# mode may never have run on this machine). A store whose read fails is
# re-read up to two more times, with no sleep between reads, before it
# counts as a failure: the failure is either a mid-write race by a live
# session or a corrupt file, and a start-only check has no later poll to
# tell the two apart or recover on, so after three reads it fails closed
# the same way a live claim does. A stale bound that is not a positive
# number is refused immediately, on the first read, with no re-read (a
# malformed bound reads the same way every time). Reading zero stores end
# to end is itself a refusal, since a check that read nothing proved
# nothing clean. The caller decides the exit code; this function only
# returns and prints, it never exits the shell.
# Usage: refuse_if_persona_live <stale_after_ms> <store-path>...
refuse_if_persona_live() {
  local stale_after_ms="$1"
  shift
  local store checked=0
  for store in "$@"; do
    [ -n "$store" ] || continue
    if [ ! -f "$store" ]; then
      echo "refuse-check: store not present, skipping: $store"
      continue
    fi
    local store_w line rc attempt
    store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
    for attempt in 1 2 3; do
      line=$(node -e "
const fs = require('fs');
const staleAfterMs = Number(process.argv[2]);
if (!Number.isFinite(staleAfterMs) || !(staleAfterMs > 0)) {
  console.log('ERROR: stale bound is not a positive number: ' + process.argv[2]);
  process.exit(2);
}
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
for (const key of keys) {
  const e = s[key];
  if (!e) continue;
  if (e.lastSeen !== undefined && e.lastSeen !== null && (typeof e.lastSeen !== 'number' || !Number.isFinite(e.lastSeen))) {
    console.log('ERROR: lastSeen is not a number under ' + key);
    process.exit(2);
  }
  if (e.lastSeen && (now - e.lastSeen) < staleAfterMs && Array.isArray(e.claims)) {
    for (const c of e.claims) {
      if (c && typeof c.resource === 'string' && c.resource.indexOf('persona:') === 0) {
        console.log('LIVE ' + c.resource + ' ' + Math.round((now - e.lastSeen) / 1000));
        process.exit(0);
      }
    }
  }
}
console.log('CLEAN');
" "$store_w" "$stale_after_ms")
      rc=$?
      if echo "$line" | grep -q '^ERROR: stale bound is not a positive number:'; then
        echo "refuse-check FAIL: ${line#ERROR: }"
        return 1
      fi
      if [ $rc -eq 0 ] && ! echo "$line" | grep -q '^ERROR'; then
        break
      fi
    done
    if [ $rc -ne 0 ] || echo "$line" | grep -q '^ERROR'; then
      echo "refuse-check FAIL: store could not be read after 3 attempts (a mid-write race or a corrupt file): $store ($line)"
      return 1
    fi
    case "$line" in
      LIVE\ *)
        local resource age
        resource=$(echo "$line" | sed -n 's/^LIVE \([^ ]*\) .*/\1/p')
        age=$(echo "$line" | sed -n 's/^LIVE [^ ]* \(.*\)/\1/p')
        echo "refuse-check FAIL: live persona claim in $store: $resource (age ${age}s)"
        return 1
        ;;
    esac
    checked=$((checked + 1))
  done
  if [ "$checked" -eq 0 ]; then
    echo "refuse-check FAIL: no store was read (every path was empty or missing)"
    return 1
  fi
  echo "refuse-check passed ($checked store(s) read, no live persona claim)"
  return 0
}

# --- wait_persona_free_both ---
# AD2: Wait for the persona to be free in BOTH the commons store AND the
# per-directory heartbeat. The commons check ensures no machine-global claim;
# the heartbeat check ensures the local holder is stale (lastSeen older than
# staleAfterMs) or absent.
# Usage: wait_persona_free_both <workdir> <persona> <timeout-seconds> <stale_after_ms> <global_store>
wait_persona_free_both() {
  local workdir="$1"
  local persona="${2:-default}"
  local timeout="${3:-120}"
  local stale_after_ms="${4:-90000}"
  local global_store="$5"
  local n=0
  local heartbeat_path="$workdir/.agentic-heartbeat.json"
  
  echo "pre-gate: waiting for persona '$persona' free in commons AND heartbeat (timeout: ${timeout}s)..."
  
  while true; do
    # Check 1: commons store (machine-global)
    local commons_ok=false
    if [ -n "$global_store" ] && [ -f "$global_store" ]; then
      local line live rc
      # The persona and the stale bound are passed as arguments rather than
      # spliced into the program text, so a value carrying JavaScript is data
      # the program reads instead of code it runs. A bound that is not a
      # number reads as NaN, which the program takes as no bound at all and
      # counts every claim as live, so the gate waits rather than passing on
      # a bad bound.
      line=$(node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const persona = process.argv[2];
const staleAfterMs = Number(process.argv[3]);
const bounded = !Number.isNaN(staleAfterMs);
const keys = Object.keys(s).filter(k => k.startsWith('commons:'));
const now = Date.now();
let live = 0;
for (const key of keys) {
  const e = s[key];
  if (e.lastSeen && (!bounded || (now - e.lastSeen) < staleAfterMs) && e.claims) {
    for (const c of e.claims) {
      if (c.resource === 'persona:' + persona) { live++; }
    }
  }
}
console.log('live=' + live);
" "$global_store" "$persona" "$stale_after_ms" 2>/dev/null)
      rc=$?
      if [ $rc -eq 0 ] && ! echo "$line" | grep -q '^ERROR'; then
        live=$(echo "$line" | sed -n 's/.*live=\([0-9]*\).*/\1/p')
        if [ "${live:-1}" = "0" ]; then
          commons_ok=true
        fi
      fi
    fi
    
    # Check 2: per-directory heartbeat
    local heartbeat_ok=false
    if [ ! -f "$heartbeat_path" ]; then
      heartbeat_ok=true
    else
      local hb_status
      # The persona and the stale bound are passed as arguments rather than
      # spliced into the program text, so a value carrying JavaScript is data
      # the program reads instead of code it runs. A bound that is not a
      # number reads as NaN, every comparison against it is false, and the
      # holder is treated as live, so the gate waits rather than passing on
      # a bad bound.
      hb_status=$(node -e "
const fs = require('fs');
let hb;
try {
  hb = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log('ERROR: ' + e.message);
  process.exit(2);
}
const staleAfterMs = Number(process.argv[2]);
const entry = hb[process.argv[3]];
if (!entry) {
  console.log('absent');
} else {
  const age = Date.now() - entry.lastSeen;
  console.log(age > staleAfterMs ? 'stale:' + Math.round(age / 1000) + 's' : 'live:' + Math.round(age / 1000) + 's');
}
" "$heartbeat_path" "$stale_after_ms" "$persona" 2>/dev/null)
      if echo "$hb_status" | grep -q '^stale\|^absent'; then
        heartbeat_ok=true
      fi
    fi
    
    # Log which conditions are satisfied
    local commons_msg="FAIL" heartbeat_msg="FAIL"
    $commons_ok && commons_msg="OK"
    $heartbeat_ok && heartbeat_msg="OK"
    echo "pre-gate poll: commons=$commons_msg heartbeat=$heartbeat_msg"
    
    if $commons_ok && $heartbeat_ok; then
      echo "pre-gate passed (commons and heartbeat both free)"
      return 0
    fi
    
    n=$((n + 5))
    [ $n -ge $timeout ] && { echo "pre-gate timeout after ${n}s (commons=$commons_msg heartbeat=$heartbeat_msg)"; return 1; }
    sleep 5
  done
}

# --- newest_handle ---
# The pre-launch gate's handle branch. Prints the path of the newest
# <rundir>/child-*/handle.json, newest by the launchedAt timestamp inside it
# rather than by file mtime, since child directories are reused across
# supervisor runs. Prints nothing where no readable handle exists. Never
# throws: an unreadable or malformed handle is skipped.
# Usage: newest_handle <rundir>
newest_handle() {
  local rundir="$1"
  [ -n "$rundir" ] || return 0
  node -e '
const fs = require("fs");
const path = require("path");
const rundir = process.argv[1];
let best = null;
let bestAt = -Infinity;
const seen = [];
let entries = [];
try { entries = fs.readdirSync(rundir); } catch (e) { process.exit(0); }
for (const name of entries) {
  if (!/^child-\d+$/.test(name)) continue;
  const p = path.join(rundir, name, "handle.json");
  let h;
  try { h = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { continue; }
  const at = Number(h.launchedAt);
  if (!Number.isFinite(at)) continue;
  seen.push({ name, p, at });
  if (at > bestAt) { bestAt = at; best = p; }
}
// Every older handle passed over is named on stderr, one per line, so the
// caller can log which child directories still hold a handle nobody has
// accounted for.
for (const s of seen) { if (s.p !== best) console.error("OLDER " + s.name); }
if (best) console.log(best);
' "$rundir"
}

# --- handle_num_field ---
# handle_field narrowed to a non-negative integer: prints the value only where
# it is all digits, and nothing otherwise, so a pid, an index or a timestamp
# read from a handle is refused before it reaches kill, the walk or a path.
# Usage: handle_num_field <handle-file> <field>
handle_num_field() {
  local v
  v=$(handle_field "$1" "$2")
  case "$v" in ''|*[!0-9]*) return 0 ;; esac
  printf '%s\n' "$v"
}

# --- handle_field ---
# One top-level field of a handle.json, read through a JSON parser rather than a
# grep so a value carrying JSON is data. Prints the value, or nothing where the
# handle is unreadable or the field is absent or null.
# Usage: handle_field <handle-file> <field>
handle_field() {
  local file="$1" field="$2"
  [ -f "$file" ] || return 0
  node -e '
const fs = require("fs");
try {
  const h = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const v = h[process.argv[2]];
  if (v !== undefined && v !== null) console.log(v);
} catch (e) {}
' "$file" "$field" 2>/dev/null
}

# --- poll_decisions ---
# Read the decision log from .agentic-personas.json for a given persona key.
# W2: a read error returns "ERROR" and no decisions (treat as not-ready).
# Usage: poll_decisions <store-path> [persona-key]
# Prints JSON: {"decisions":[...], "error": null|"msg"}
poll_decisions() {
  local store="${1:-.agentic-personas.json}"
  local persona="${2:-default}"
  local store_w
  store_w=$(cygpath -m "$store" 2>/dev/null || echo "$store")
  node -e "
const fs = require('fs');
let s;
try {
  s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log(JSON.stringify({decisions: [], error: e.message}));
  process.exit(0);
}
const key = process.argv[2];
const p = s[key];
if (!p) {
  console.log(JSON.stringify({decisions: [], error: 'persona not found'}));
  process.exit(0);
}
console.log(JSON.stringify({decisions: p.decisions || [], error: null}));
" "$store_w" "$persona"
}

# --- poll_heartbeat ---
# Read the heartbeat sidecar (.agentic-heartbeat.json) for a given persona key.
# W2: a read error returns "ERROR" (treat as not-ready).
# Usage: poll_heartbeat <heartbeat-path> [persona-key]
# Prints JSON: {"sessionId": "...", "epoch": N, "lastSeen": N, "error": null|"msg"}
poll_heartbeat() {
  local hb_path="${1:-.agentic-heartbeat.json}"
  local persona="${2:-default}"
  local hb_w
  hb_w=$(cygpath -m "$hb_path" 2>/dev/null || echo "$hb_path")
  node -e "
const fs = require('fs');
let hb;
try {
  hb = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
} catch (e) {
  console.log(JSON.stringify({sessionId: null, epoch: 0, lastSeen: null, error: e.message}));
  process.exit(0);
}
const key = process.argv[2];
const e = hb[key];
if (!e) {
  console.log(JSON.stringify({sessionId: null, epoch: 0, lastSeen: null, error: 'persona not in heartbeat'}));
  process.exit(0);
}
console.log(JSON.stringify({sessionId: e.sessionId, epoch: e.epoch, lastSeen: e.lastSeen, error: null}));
" "$hb_w" "$persona"
}
