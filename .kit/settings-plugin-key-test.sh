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

printf '%s' '{"pluginConfigs":' > "$TMP/broken.json"
ERR=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/broken.json" 2>&1)
RC=$?
case "$RC:$ERR" in 0:*) check "ensure_settings_plugin_ids refuses a file that is not JSON" 1 ;; *"is not valid JSON"*) check "ensure_settings_plugin_ids refuses a file that is not JSON" 0 ;; *) check "ensure_settings_plugin_ids refuses a file that is not JSON" 1 ;; esac

# --- values spliced into JSON are refused when they could break out ---
run_lib PERSONA='x"}}},"hooks":{"a":1' bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$TMP/inj.json" 2>/dev/null
[ "$?" -ne 0 ]; check "emit_settings_json refuses a persona carrying a quote" "$?"
run_lib PERSONA="ok" HEARTBEAT_MS='1,"hooks":{}' bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$TMP/inj2.json" 2>/dev/null
[ "$?" -ne 0 ]; check "emit_settings_json refuses a non-numeric cadence" "$?"

# --- bin/supervise.sh wires both helpers and the persona check ---
SUP="$ROOT/bin/supervise.sh"
grep -q 'emit_settings_json "\$SETTINGS_FILE" || exit 1' "$SUP"; check "supervise.sh exits when the emitter refuses" "$?"
grep -q 'ensure_settings_plugin_ids "\$SETTINGS_FILE" || exit 1' "$SUP"; check "supervise.sh completes a provided settings file" "$?"
OUT=$(env -i PATH="$PATH" bash "$SUP" /nonexistent 'bad"name' default 2>&1)
case "$OUT" in *"persona 'bad\"name' may hold only"*) check "supervise.sh refuses a persona carrying a quote" 0 ;; *) check "supervise.sh refuses a persona carrying a quote" 1 ;; esac

if [ "$failed" -eq 0 ]; then
  echo "settings-plugin-key-test.sh: PASS"
  exit 0
fi
echo "settings-plugin-key-test.sh: FAIL"
exit 1
