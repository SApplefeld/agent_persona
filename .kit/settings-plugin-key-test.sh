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
console.log("ARMING_DEV=" + (dev ? dev.arming : "") + ";");
console.log("ARMING_INSTALLED=" + (inst ? inst.arming : "") + ";");
console.log("COORD_DEV=" + (dev ? dev.coordinatorPersona : "") + ";");
console.log("COORD_INSTALLED=" + (inst ? inst.coordinatorPersona : "") + ";");
console.log("TICK_DEV=" + (dev ? dev.controllerTickMs : "") + ";");
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
case "$R" in *"SAME_OPTIONS=1"*) check "emitted: both ids carry identical options" 0 ;; *) check "emitted: both ids carry identical options" 1 ;; esac
case "$R" in *"PERSONA_DEV=keyprobe;"*) check "emitted: --plugin-dir id carries the persona" 0 ;; *) check "emitted: --plugin-dir id carries the persona" 1 ;; esac
case "$R" in *"ARMING_DEV=owner;"*"ARMING_INSTALLED=owner;"*) check "emitted: both ids carry arming owner" 0 ;; *) check "emitted: both ids carry arming owner (out=$R)" 1 ;; esac
case "$R" in *"COORD_DEV=coordinator;"*"COORD_INSTALLED=coordinator;"*) check "emitted: both ids carry coordinatorPersona coordinator (default)" 0 ;; *) check "emitted: both ids carry coordinatorPersona coordinator (default) (out=$R)" 1 ;; esac

# --- emit_settings_json exports COORDINATOR_PERSONA for the caller ---
# The export lets a caller compare its own persona against the name it wrote
# into coordinatorPersona without parsing the settings file.
EXPORTED=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2" >/dev/null && export -p | grep -c "COORDINATOR_PERSONA="' _ "$ROOT" "$TMP/exported.json")
[ "$EXPORTED" = "1" ]; check "emit_settings_json exports COORDINATOR_PERSONA" "$?"
# The value is read from a grandchild bash -c, which inherits an env var
# only when it was actually exported; a plain assignment in this shell
# would already answer "lead" without exercising the export at all.
COORD_VALUE=$(run_lib bash -c 'COORDINATOR_PERSONA="lead"; source "$1/bin/agentic-common.sh" && emit_settings_json "$2" >/dev/null && bash -c '\''echo "$COORDINATOR_PERSONA"'\''' _ "$ROOT" "$TMP/exported2.json")
[ "$COORD_VALUE" = "lead" ]; check "emit_settings_json exports the given COORDINATOR_PERSONA value ($COORD_VALUE)" "$?"

# --- Section 6: COORDINATOR_PERSONA "default" is refused ---
ERR=$(run_lib COORDINATOR_PERSONA="default" bash -c 'source "$1/bin/agentic-common.sh" && emit_settings_json "$2"' _ "$ROOT" "$TMP/coord-default.json" 2>&1)
RC=$?
case "$RC:$ERR" in 0:*) check "emit_settings_json refuses COORDINATOR_PERSONA=default" 1 ;; *"COORDINATOR_PERSONA must not be 'default'"*) check "emit_settings_json refuses COORDINATOR_PERSONA=default" 0 ;; *) check "emit_settings_json refuses COORDINATOR_PERSONA=default (rc=$RC, err=$ERR)" 1 ;; esac
[ ! -e "$TMP/coord-default.json" ]; check "a refused COORDINATOR_PERSONA leaves no settings file" "$?"

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
RC=$?
[ "$RC" -eq 0 ] && [ "$(cat "$TMP/different.json")" = "$DIFFERENT" ]; check "two ids with different options are accepted and left byte for byte (rc=$RC)" "$?"

# --- Section 6: ensure_settings_arming completes a missing arming key ---
# A provided file with no arming key gains "owner" under both ids once
# ensure_settings_plugin_ids has already given each id the same options;
# every other option the caller wrote survives untouched.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":11,"persona":"noarm"}}}}' > "$TMP/noarm.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2" && ensure_settings_arming "$2"' _ "$ROOT" "$TMP/noarm.json"
check "ensure_settings_arming exits 0 on a file with no arming key" "$?"
R=$(inspect "$TMP/noarm.json")
case "$R" in *"PERSONA_DEV=noarm;"*"ARMING_DEV=owner;"*"ARMING_INSTALLED=owner;"*"TICK_DEV=11;"*) check "a missing arming key gains owner under both ids, other options unchanged" 0 ;; *) check "a missing arming key gains owner under both ids, other options unchanged (out=$R)" 1 ;; esac

# A provided arming value naming another tier is refused, not honored: a
# supervisor launch always drives a goal tree as an owner.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":11,"arming":"reader"}}}}' > "$TMP/hasarm.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_plugin_ids "$2"' _ "$ROOT" "$TMP/hasarm.json"
BEFORE=$(cat "$TMP/hasarm.json")
ERR=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_arming "$2"' _ "$ROOT" "$TMP/hasarm.json" 2>&1)
RC=$?
case "$RC:$ERR" in 1:*"carries arming 'reader' under agentic-plugin; a supervisor launch is always owner"*) check "ensure_settings_arming refuses a provided arming value naming another tier" 0 ;; *) check "ensure_settings_arming refuses a provided arming value naming another tier (rc=$RC, err=$ERR)" 1 ;; esac
[ "$(cat "$TMP/hasarm.json")" = "$BEFORE" ]; check "a refused arming value leaves the file byte for byte unchanged" "$?"

# ensure_settings_arming completes an empty file to owner under both ids,
# creating pluginConfigs and both id entries from nothing, and leaves any
# sibling key (here a permissions block) untouched.
printf '%s' '{"permissions":{"allow":[]}}' > "$TMP/empty.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_arming "$2"' _ "$ROOT" "$TMP/empty.json"
check "ensure_settings_arming exits 0 on an empty file" "$?"
R=$(inspect "$TMP/empty.json")
case "$R" in *"ARMING_DEV=owner;"*"ARMING_INSTALLED=owner;"*) check "an empty file gains owner under both ids" 0 ;; *) check "an empty file gains owner under both ids (out=$R)" 1 ;; esac
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(s.permissions && Array.isArray(s.permissions.allow) ? 0 : 1);' "$TMP/empty.json"
check "an empty file's permissions sibling key survives completion" "$?"

# ensure_settings_arming completes a file naming only the dev id with empty
# options, gaining the installed id from nothing and owner under both.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{}}}}' > "$TMP/onlydev.json"
run_lib bash -c 'source "$1/bin/agentic-common.sh" && ensure_settings_arming "$2"' _ "$ROOT" "$TMP/onlydev.json"
check "ensure_settings_arming exits 0 on a file naming only the dev id" "$?"
R=$(inspect "$TMP/onlydev.json")
case "$R" in *"ARMING_DEV=owner;"*"ARMING_INSTALLED=owner;"*) check "a file naming only the dev id gains owner under both ids" 0 ;; *) check "a file naming only the dev id gains owner under both ids (out=$R)" 1 ;; esac

# --- Section 8: read_settings_coordinator_persona resolves the plugin's name ---
# The provided-settings branch of bin/supervise.sh exports COORDINATOR_PERSONA
# from this read, so the coordinator-role comparison sees the name the plugin
# resolves from the file. The driven runs below cannot observe that export:
# the pre-launch gate stops the supervisor before the priming block, so this
# library case is the coverage. Three files, one per class of the plugin's
# rule: a usable name (under the installed id only, so the dev-id miss and
# the installed-id read both run), "default" (refused, falls back), and no
# key at all (falls back). "boss" is withheld from every literal the
# function carries.
printf '%s' '{"pluginConfigs":{"agentic-plugin@agent-persona":{"options":{"coordinatorPersona":"boss"}}}}' > "$TMP/coord-boss.json"
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && read_settings_coordinator_persona "$2"' _ "$ROOT" "$TMP/coord-boss.json" 2>&1)
[ "$OUT" = "boss" ]; check "read_settings_coordinator_persona prints the file's coordinatorPersona (out=$OUT)" "$?"
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"coordinatorPersona":"default"}}}}' > "$TMP/coord-default.json"
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && read_settings_coordinator_persona "$2"' _ "$ROOT" "$TMP/coord-default.json" 2>&1)
[ "$OUT" = "coordinator" ]; check "read_settings_coordinator_persona resolves a coordinatorPersona of default to coordinator (out=$OUT)" "$?"
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":7}}}}' > "$TMP/coord-nokey.json"
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && read_settings_coordinator_persona "$2"' _ "$ROOT" "$TMP/coord-nokey.json" 2>&1)
[ "$OUT" = "coordinator" ]; check "read_settings_coordinator_persona resolves a missing coordinatorPersona to coordinator (out=$OUT)" "$?"

# Shapes that cannot hold options are refused rather than repaired.
for shape in '{"pluginConfigs":[]}' '{"pluginConfigs":{"agentic-plugin":"x"}}' '{"pluginConfigs":{"agentic-plugin":{"options":"x"}}}'; do
  for fn in ensure_settings_plugin_ids ensure_settings_arming; do
    printf '%s' "$shape" > "$TMP/shape.json"
    ERR=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && "$3" "$2"' _ "$ROOT" "$TMP/shape.json" "$fn" 2>&1)
    RC=$?
    case "$RC:$ERR" in 0:*) check "$fn refuses $shape" 1 ;; *"not an object"*) check "$fn refuses $shape" 0 ;; *) check "$fn refuses $shape (err=$ERR)" 1 ;; esac
  done
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

# --- the persona character class is the same in both files that check it ---
# bin/supervise.sh refuses a bad persona before sourcing the library, so it
# carries its own copy of valid_persona_name's class.
SUP_CLASS=$(sed -n '/^case "\$PERSONA" in$/{n;p;}' "$ROOT/bin/supervise.sh" | grep -o '\[![^]]*\]')
LIB_CLASS=$(sed -n '/^valid_persona_name() {$/,/^}$/p' "$ROOT/bin/agentic-common.sh" | grep -o '\[![^]]*\]')
[ -n "$SUP_CLASS" ] && [ "$(printf '%s\n' "$SUP_CLASS" | wc -l)" -eq 1 ]; check "one persona class found in bin/supervise.sh ($SUP_CLASS)" "$?"
[ -n "$LIB_CLASS" ] && [ "$(printf '%s\n' "$LIB_CLASS" | wc -l)" -eq 1 ]; check "one persona class found in valid_persona_name ($LIB_CLASS)" "$?"
[ -n "$SUP_CLASS" ] && [ "$SUP_CLASS" = "$LIB_CLASS" ]; check "bin/supervise.sh and valid_persona_name use the same persona class" "$?"

# --- bin/supervise.sh, driven for real ---
# HOME is an empty directory, so no commons store exists and the pre-launch
# gate stops the supervisor with "GATE FAIL", exit 2, before any child starts.
# Two more layers hold if that ever changes: --no-channel keeps the Discord
# relay out, and a stub claude first on PATH records any launch and exits.
SUP="$ROOT/bin/supervise.sh"
mkdir -p "$TMP/home" "$TMP/wd" "$TMP/rd" "$TMP/rd-ok" "$TMP/stub"
printf '#!/usr/bin/env bash\ntouch "%s"\nexit 1\n' "$TMP/stub/launched" > "$TMP/stub/claude"
chmod +x "$TMP/stub/claude"
drive() {  # <persona> <rundir>
  env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" bash "$SUP" "$TMP/wd" "$1" default --rundir "$2" --no-channel 2>&1
}

# The file's persona differs from the launch argument, so a supervisor that
# overwrote the file, or wrote its own persona into it, reads differently from
# one that completed it.
printf '%s' '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":7,"persona":"fromfile"}}}}' > "$TMP/rd-ok/settings.json"
OUT=$(drive tester "$TMP/rd-ok")
RC=$?
[ "$RC" -eq 2 ] && grep -q "GATE FAIL" "$TMP/rd-ok/supervisor.log" && ! grep -q "LAUNCH" "$TMP/rd-ok/supervisor.log" && [ ! -e "$TMP/stub/launched" ]
check "driven supervise.sh stops at the gate without launching (rc=$RC)" "$?"
R=$(inspect "$TMP/rd-ok/settings.json")
case "$R" in *"INSTALLED_KEY=1"*"SAME_OPTIONS=1"*"PERSONA_DEV=fromfile;"*"PERSONA_INSTALLED=fromfile;"*) check "supervise.sh completes a provided --plugin-dir-only file, keeping its persona" 0 ;; *) check "supervise.sh completes a provided --plugin-dir-only file, keeping its persona" 1 ;; esac

# --- controllerTickMs reaches the emitted settings file (M1) ---
# A fresh rundir with no settings.json takes the emit_settings_json path,
# where the env override must survive the library's own PROFILE assignment.
mkdir -p "$TMP/rd-tick"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" controllerTickMs=60000 \
  bash "$SUP" "$TMP/wd" tester default --rundir "$TMP/rd-tick" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 2 ]; check "driven supervise.sh with controllerTickMs=60000 stops at the gate (rc=$RC)" "$?"
R=$(inspect "$TMP/rd-tick/settings.json")
case "$R" in *"TICK_DEV=60000;"*) check "supervise.sh emits controllerTickMs into the settings file (out=$R)" 0 ;; *) check "supervise.sh emits controllerTickMs into the settings file (out=$R)" 1 ;; esac

printf '%s' '{"pluginConfigs":' > "$TMP/rd/settings.json"
OUT=$(drive tester "$TMP/rd")
RC=$?
[ "$RC" -eq 1 ]; check "supervise.sh exits 1 on a provided settings file that is not JSON (rc=$RC)" "$?"
[ -s "$TMP/rd/supervisor.log" ] && ! grep -q "LAUNCH" "$TMP/rd/supervisor.log"; check "supervise.sh records the settings refusal in supervisor.log and launches nothing" "$?"

OUT=$(drive 'bad"name' "$TMP/rd2")
case "$OUT" in *"persona 'bad\"name' may hold only"*) check "supervise.sh refuses a persona carrying a quote" 0 ;; *) check "supervise.sh refuses a persona carrying a quote" 1 ;; esac

# --- staleAfterMs: checked at startup, and passed as data, not as source ---
# The stale bound reaches a node program inside wait_persona_free_both. A
# rundir that already holds a settings file skips emit_settings_json, which is
# where the plugin values are otherwise checked, so the supervisor checks this
# one itself on the path every launch takes.
PROVIDED='{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":7}}}}'
mkdir -p "$TMP/rd-stale" "$TMP/rd-stale-ok" "$TMP/hb"
printf '%s' "$PROVIDED" > "$TMP/rd-stale/settings.json"
printf '%s' "$PROVIDED" > "$TMP/rd-stale-ok/settings.json"
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" staleAfterMs='0;require("fs").writeFileSync("PWNED","x")' \
  bash "$SUP" "$TMP/wd" tester default --rundir "$TMP/rd-stale" --no-channel 2>&1)
RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q "ERROR: staleAfterMs"; then
  check "supervise.sh refuses a staleAfterMs carrying JavaScript even with a settings file provided" 0
else
  check "supervise.sh refuses a staleAfterMs carrying JavaScript even with a settings file provided (rc=$RC, out=$OUT)" 1
fi
OUT=$(env -i PATH="$TMP/stub:$PATH" HOME="$TMP/home" staleAfterMs=90000 \
  bash "$SUP" "$TMP/wd" tester default --rundir "$TMP/rd-stale-ok" --no-channel 2>&1)
RC=$?
[ "$RC" -eq 2 ]; check "control: the same run with a numeric staleAfterMs passes the check and reaches the gate (rc=$RC)" "$?"

# The bound is an argument to the heartbeat program, so a value carrying
# JavaScript is read rather than run. The two cases after it are the control:
# the same call reads a 60-second-old holder as stale under a small bound and
# as live under a large one, which only happens if the bound arrives at all.
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({probe:{lastSeen:Date.now()-60000}}))' "$TMP/hb/.agentic-heartbeat.json"
PWN="$TMP/pwned"
run_lib PWN="$PWN" bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 "$3" ""' \
  _ "$ROOT" "$TMP/hb" '(require("fs").writeFileSync(process.env.PWN,"x"),0)' > /dev/null 2>&1
[ ! -e "$PWN" ]; check "a staleAfterMs carrying JavaScript never runs inside the heartbeat program" "$?"
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 1 ""' _ "$ROOT" "$TMP/hb" 2>&1)
case "$OUT" in *"heartbeat=OK"*) check "a 1ms stale bound reads the 60s-old holder as stale" 0 ;; *) check "a 1ms stale bound reads the 60s-old holder as stale (out=$OUT)" 1 ;; esac
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 90000 ""' _ "$ROOT" "$TMP/hb" 2>&1)
case "$OUT" in *"heartbeat=FAIL"*) check "a 90000ms stale bound reads the same holder as live" 0 ;; *) check "a 90000ms stale bound reads the same holder as live (out=$OUT)" 1 ;; esac

# The mirror leg for the commons half of the same gate. The store holds one
# session entry in the shape hooks/commons.ts writes (a commons:<session-id>
# key carrying lastSeen and a claims array), 60 seconds old and claiming
# persona:probe. The workdir has no heartbeat file, so the reading below is
# the commons half's alone. The persona and the bound both reach the program
# as arguments, so a value carrying JavaScript in either is read rather than
# run; the two cases after them are the control, the same store reading free
# under a 1 ms bound and held under a 90000 ms bound, which only happens if
# the bound arrives at all.
mkdir -p "$TMP/wd-commons"
COMMONS_STORE="$TMP/commons-store.json"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({"commons:probe-session":{sessionId:"probe-session",lastSeen:Date.now()-60000,claims:[{resource:"persona:probe",claimedAt:Date.now()-60000}]}}))' "$COMMONS_STORE"
PWN="$TMP/pwned-commons-bound"
run_lib PWN="$PWN" bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 "$3" "$4"' \
  _ "$ROOT" "$TMP/wd-commons" '(require("fs").writeFileSync(process.env.PWN,"x"),0)' "$COMMONS_STORE" > /dev/null 2>&1
[ ! -e "$PWN" ]; check "a staleAfterMs carrying JavaScript never runs inside the commons program" "$?"
PWN="$TMP/pwned-commons-persona"
run_lib PWN="$PWN" bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" "$3" 1 90000 "$4"' \
  _ "$ROOT" "$TMP/wd-commons" "probe'+(require(\"fs\").writeFileSync(process.env.PWN,\"x\"),'')+'" "$COMMONS_STORE" > /dev/null 2>&1
[ ! -e "$PWN" ]; check "a persona carrying JavaScript never runs inside the commons program" "$?"
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 1 "$3"' _ "$ROOT" "$TMP/wd-commons" "$COMMONS_STORE" 2>&1)
case "$OUT" in *"commons=OK"*) check "a 1ms stale bound reads the 60s-old commons claim as free" 0 ;; *) check "a 1ms stale bound reads the 60s-old commons claim as free (out=$OUT)" 1 ;; esac
OUT=$(run_lib bash -c 'source "$1/bin/agentic-common.sh" && wait_persona_free_both "$2" probe 1 90000 "$3"' _ "$ROOT" "$TMP/wd-commons" "$COMMONS_STORE" 2>&1)
case "$OUT" in *"commons=FAIL"*) check "a 90000ms stale bound reads the same commons claim as held" 0 ;; *) check "a 90000ms stale bound reads the same commons claim as held (out=$OUT)" 1 ;; esac

if [ "$failed" -eq 0 ]; then
  echo "settings-plugin-key-test.sh: PASS"
  exit 0
fi
echo "settings-plugin-key-test.sh: FAIL"
exit 1
