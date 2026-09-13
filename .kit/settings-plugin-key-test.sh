#!/usr/bin/env bash
# settings-plugin-key-test.sh - harness case for v2 Section 0 item 5: the
# settings file emit_settings_json writes reaches the plugin in both load
# modes. The engine keys pluginConfigs by plugin id, which is the manifest
# name under --plugin-dir and "<name>@<marketplace>" for the installed copy.
# Options written under only one of the two are silently ignored in the other
# mode, and the child falls back to persona "default" and default cadences.
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

OUT_FILE="$(mktemp)"
trap 'rm -f "$OUT_FILE"' EXIT

# Run the emitter in its own bash process, sourcing the real library, the
# same shape bin/supervise.sh uses.
env -i PATH="$PATH" PERSONA="keyprobe" TICK_MS=10000 NUDGE_IDLE_MS=60000 GIT_PROBE_MS=120000 \
  bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$OUT_FILE"
check "emit_settings_json exits 0" "$?"

RESULT=$(node -e '
const fs = require("fs");
const [root, out] = process.argv.slice(1);
const name = JSON.parse(fs.readFileSync(root + "/.claude-plugin/plugin.json", "utf8")).name;
const market = JSON.parse(fs.readFileSync(root + "/.claude-plugin/marketplace.json", "utf8")).name;
let s;
try { s = JSON.parse(fs.readFileSync(out, "utf8")); } catch (e) { console.log("PARSE_FAIL"); process.exit(0); }
const pc = s.pluginConfigs || {};
const dev = pc[name] && pc[name].options;
const inst = pc[name + "@" + market] && pc[name + "@" + market].options;
console.log("DEV_KEY=" + (dev ? 1 : 0));
console.log("INSTALLED_KEY=" + (inst ? 1 : 0));
console.log("SAME_OPTIONS=" + (dev && inst && JSON.stringify(dev) === JSON.stringify(inst) ? 1 : 0));
console.log("PERSONA_DEV=" + (dev ? dev.persona : ""));
console.log("PERSONA_INSTALLED=" + (inst ? inst.persona : ""));
' "$ROOT" "$OUT_FILE")

case "$RESULT" in *PARSE_FAIL*) check "emitted settings parse as JSON" 1 ;; *) check "emitted settings parse as JSON" 0 ;; esac
case "$RESULT" in *"DEV_KEY=1"*) check "options under the --plugin-dir id (manifest name)" 0 ;; *) check "options under the --plugin-dir id (manifest name)" 1 ;; esac
case "$RESULT" in *"INSTALLED_KEY=1"*) check "options under the installed id (name@marketplace)" 0 ;; *) check "options under the installed id (name@marketplace)" 1 ;; esac
case "$RESULT" in *"SAME_OPTIONS=1"*) check "both ids carry identical options" 0 ;; *) check "both ids carry identical options" 1 ;; esac
case "$RESULT" in *"PERSONA_INSTALLED=keyprobe"*) check "installed id carries the supervisor's persona" 0 ;; *) check "installed id carries the supervisor's persona" 1 ;; esac

if [ "$failed" -eq 0 ]; then
  echo "settings-plugin-key-test.sh: PASS"
  exit 0
fi
echo "settings-plugin-key-test.sh: FAIL"
exit 1
