#!/usr/bin/env bash
cd /d/DeepSeekHarness/agentic-plugin
OUT=/d/DeepSeekHarness/.kit/runs/reviewer-r49
unset CLAUDECODE
run() { local name="$1"; shift; echo "$(date -u +%FT%TZ) START $name" >> $OUT/timeline.log; "$@" > $OUT/$name.log 2>&1; echo $? > $OUT/$name.exit; echo "$(date -u +%FT%TZ) END $name exit=$(cat $OUT/$name.exit)" >> $OUT/timeline.log; }
run supervisor bash .kit/live-supervisor-test.sh
run selfreview env PROFILE=short bash .kit/live-self-review-test.sh
run errorstreak bash .kit/live-errorstreak-test.sh
run liveall bash .kit/live-all.sh
echo done > $OUT/ALL.done
