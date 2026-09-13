#!/usr/bin/env bash
# settings-plugin-key-test.sh - harness case for v2 Section 0 item 5: the
# settings file a supervisor hands its child reaches the plugin in both load
# modes. pluginConfigs is keyed by plugin id, which is the manifest name under
# --plugin-dir and "<name>@<marketplace>" for the installed copy. Options
# under only one id are ignored in the other mode, and the child falls back to
# persona "default" and default cadences.
#
# The expected ids are derived from .claude-plugin/plugin.json and
# .claude-plugin/marketplace.json rather than restated here, so a rename of
# either file reds this test instead of the live fleet.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."

failed=0
check() {
  if [ "$2" = "0" ]; then echo "  OK: $1"; else echo "  FAIL: $1"; failed=1; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Reads a settings file and prints what each plugin id carries.
inspect() {
  node -e '
const fs = require("fs");
const [root, file] = process.argv.slice(1);
const name = JSON.parse(fs.readFileSync(root + "/.claude-plugin/plugin.json", "utf8")).name;
const market = JSON.parse(fs.readFileSync(root + "/.claude-plugin/marketplace.json", "utf8")).name;
let s;
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.log("PARSE_FAIL"); process.exit(0); }
const pc = s.pluginConfigs || {};
const dev = pc[name] && pc[name].options;
const inst = pc[name + "@" + market] && pc[name + "@" + market].options;
console.log("DEV_KEY=" + (dev ? 1 : 0));
console.log("INSTALLED_KEY=" + (inst ? 1 : 0));
console.log("SAME_OPTIONS=" + (dev && inst && JSON.stringify(dev) === JSON.stringify(inst) ? 1 : 0));
console.log("PERSONA_DEV=" + (dev ? dev.persona : "") + ";");
console.log("PERSONA_INSTALLED=" + (inst ? inst.persona : "") + ";");
' "$ROOT" "$1"
}

# Runs a snippet in its own bash process with the real library sourced, the
# same shape bin/supervise.sh uses.
run_lib() {
  env -i PATH="$PATH" "$@"
}

# --- emit_settings_json writes both ids ---
run_lib PERSONA="keyprobe" bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$TMP/emitted.json"
check "emit_settings_json exits 0" "$?"
R=$(inspect "$TMP/emitted.json")
case "$R" in *PARSE_FAIL*) check "emitted settings parse as JSON" 1 ;; *) check "emitted settings parse as JSON" 0 ;; esac
case "$R" in *"DEV_KEY=1"*) check "emitted: options under the --plugin-dir id" 0 ;; *) check "emitted: options under the --plugin-dir id" 1 ;; esac
case "$R" in *"INSTALLED_KEY=1"*) check "emitted: options under the installed id" 0 ;; *) check "emitted: options under the installed id" 1 ;; esac
case "$R" in *"SAME_OPTIONS=1"*) check "emitted: both ids carry identical options" 0 ;; *) check "emitted: both ids carry identical options" 1 ;; esac
case "$R" in *"PERSONA_DEV=keyprobe;"*) check "emitted: --plugin-dir id carries the persona" 0 ;; *) check "emitted: --plugin-dir id carries the persona" 1 ;; esac
case "$R" in *"PERSONA_INSTALLED=keyprobe;"*) check "emitted: installed id carries the persona" 0 ;; *) check "emitted: installed id carries the persona" 1 ;; esac

# --- a provided single-id file gains the other id, options unchanged ---
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":7,"persona":"legacy"}}}}' > "$TMP/legacy.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/legacy.json"
check "ensure_settings_plugin_ids exits 0 on a --plugin-dir-only file" "$?"
R=$(inspect "$TMP/legacy.json")
case "$R" in *"INSTALLED_KEY=1"*"SAME_OPTIONS=1"*"PERSONA_INSTALLED=legacy;"*) check "provided --plugin-dir-only file gains the installed id with its options" 0 ;; *) check "provided --plugin-dir-only file gains the installed id with its options" 1 ;; esac

printf '%s' '{"pluginConfigs":{"agentic-plugin@agent-persona":{"options":{"persona":"inst"}}}}' > "$TMP/inst.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/inst.json"
R=$(inspect "$TMP/inst.json")
case "$R" in *"DEV_KEY=1"*"SAME_OPTIONS=1"*"PERSONA_DEV=inst;"*) check "provided installed-only file gains the --plugin-dir id" 0 ;; *) check "provided installed-only file gains the --plugin-dir id" 1 ;; esac

# An id present without options counts as missing.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":9}},"agentic-plugin@agent-persona":{"enabled":true}}}' > "$TMP/partial.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/partial.json"
R=$(inspect "$TMP/partial.json")
case "$R" in *"INSTALLED_KEY=1"*"SAME_OPTIONS=1"*) check "an id with no options gains the other id's options" 0 ;; *) check "an id with no options gains the other id's options" 1 ;; esac

# An id whose options object is empty counts as missing.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":9}},"agentic-plugin@agent-persona":{"options":{}}}}' > "$TMP/empty.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/empty.json"
R=$(inspect "$TMP/empty.json")
case "$R" in *"INSTALLED_KEY=1"*"SAME_OPTIONS=1"*) check "an id with empty options gains the other id's options" 0 ;; *) check "an id with empty options gains the other id's options" 1 ;; esac

# Two ids that already carry different options are left exactly as written.
DIFFERENT='{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":1}},"agentic-plugin@agent-persona":{"options":{"controllerTickMs":2}}}}'
printf '%s' "$DIFFERENT" > "$TMP/different.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/different.json"
[ "$(cat "$TMP/different.json")" = "$DIFFERENT" ]; check "two ids with different options are left byte for byte" "$?"

# Shapes that cannot hold options are refused rather than repaired.
for shape in '{"pluginConfigs":[]}' '{"pluginConfigs":{"agentic-plugin":"x"}}' '{"pluginConfigs":{"agentic-plugin":{"options":"x"}}}'; do
  printf '%s' "$shape" > "$TMP/shape.json"
  ERR=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/shape.json" 2>&1)
  RC=$?
  case "$RC:$ERR" in 0:*) check "refuses $shape" 1 ;; *"not an object"*) check "refuses $shape" 0 ;; *) check "refuses $shape (err=$ERR)" 1 ;; esac
done

# A leading UTF-8 byte order mark is accepted.
printf '\xef\xbb\xbf%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"persona":"bom"}}}}' > "$TMP/bom.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/bom.json"
R=$(inspect "$TMP/bom.json")
case "$R" in *"PERSONA_INSTALLED=bom;"*) check "a file with a byte order mark is completed" 0 ;; *) check "a file with a byte order mark is completed" 1 ;; esac

printf '%s' '{"pluginConfigs":' > "$TMP/broken.json"
ERR=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/broken.json" 2>&1)
RC=$?
case "$RC:$ERR" in 0:*) check "ensure_settings_plugin_ids refuses a file that is not JSON" 1 ;; *"is not valid JSON"*) check "ensure_settings_plugin_ids refuses a file that is not JSON" 0 ;; *) check "ensure_settings_plugin_ids refuses a file that is not JSON" 1 ;; esac

# --- values spliced into JSON are refused when they could break out ---
# Each refusal is attributed by the variable name the emitter's own message
# names, and no settings file may be left behind.
refused() {  # <label> <expected token> <output file> -- env assignments...
  local label="$1" token="$2" file="$3"; shift 3
  local err rc
  err=$(run_lib "$@" bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$file" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ] && [ ! -e "$file" ] && case "$err" in *"$token"*) true ;; *) false ;; esac; then
    check "$label" 0
  else
    check "$label (rc=$rc, err=$err)" 1
  fi
}
refused "emit_settings_json refuses a persona carrying a quote" "PERSONA 'x" "$TMP/inj.json" PERSONA='x"}}},"hooks":{"a":1'
refused "emit_settings_json refuses a non-numeric cadence" "HEARTBEAT_MS '1," "$TMP/inj2.json" PERSONA="ok" HEARTBEAT_MS='1,"hooks":{}'
# HEARTBEAT_MS rather than TICK_MS: sourcing the library resets TICK_MS from
# PROFILE, so a TICK_MS value set here never reaches the emitter.
refused "emit_settings_json refuses a cadence with a leading zero" "HEARTBEAT_MS '030000'" "$TMP/inj3.json" PERSONA="ok" HEARTBEAT_MS='030000'

# --- bin/supervise.sh, driven for real ---
# HOME is an empty directory, so no commons store exists and the pre-launch
# gate stops the supervisor with "GATE FAIL", exit 2, before any child starts.
# --no-channel keeps the Discord relay out even if that ever changes.
SUP="$ROOT/bin/supervise.sh"
mkdir -p "$TMP/home" "$TMP/wd" "$TMP/rd" "$TMP/rd-ok"
drive() {  # <persona> <rundir>
  env -i PATH="$PATH" HOME="$TMP/home" bash "$SUP" "$TMP/wd" "$1" default --rundir "$2" --no-channel 2>&1
}

printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":7,"persona":"tester"}}}}' > "$TMP/rd-ok/settings.json"
OUT=$(drive tester "$TMP/rd-ok")
RC=$?
[ "$RC" -eq 2 ] && grep -q "GATE FAIL" "$TMP/rd-ok/supervisor.log" && ! grep -q "LAUNCH" "$TMP/rd-ok/supervisor.log"
check "driven supervise.sh stops at the gate without launching (rc=$RC)" "$?"
R=$(inspect "$TMP/rd-ok/settings.json")
case "$R" in *"INSTALLED_KEY=1"*"SAME_OPTIONS=1"*"PERSONA_INSTALLED=tester;"*) check "supervise.sh completes a provided --plugin-dir-only settings file" 0 ;; *) check "supervise.sh completes a provided --plugin-dir-only settings file" 1 ;; esac

printf '%s' '{"pluginConfigs":' > "$TMP/rd/settings.json"
OUT=$(drive tester "$TMP/rd")
RC=$?
[ "$RC" -eq 1 ]; check "supervise.sh exits 1 on a provided settings file that is not JSON (rc=$RC)" "$?"
grep -q "is not valid JSON" "$TMP/rd/supervisor.log" 2>/dev/null; check "supervise.sh records the settings refusal in supervisor.log" "$?"
! grep -q "LAUNCH" "$TMP/rd/supervisor.log" 2>/dev/null; check "supervise.sh launches nothing after refusing the settings file" "$?"

OUT=$(drive 'bad"name' "$TMP/rd2")
case "$OUT" in *"persona 'bad\"name' may hold only"*) check "supervise.sh refuses a persona carrying a quote" 0 ;; *) check "supervise.sh refuses a persona carrying a quote" 1 ;; esac
[ ! -e "$TMP/rd2" ]; check "supervise.sh refuses the persona before creating the rundir" "$?"

if [ "$failed" -eq 0 ]; then
  echo "settings-plugin-key-test.sh: PASS"
  exit 0
fi
echo "settings-plugin-key-test.sh: FAIL"
exit 1
