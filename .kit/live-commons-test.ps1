#!/usr/bin/env pwsh
# Live test: commons two-session race suite (PowerShell version).
# Two concurrent sessions both try to claim the same persona via agentic_identity.
# Commons arbitration (first-claim-wins) determines the winner.
#
# F8 fix: reads the REAL $.store file. Asserts:
#   (1) BOTH sessions wrote a commons:<sessionId> claim entry,
#   (2) EXACTLY ONE is the winner,
#   (3) the loser's decision log shows persona_yield_commons.
# Exit code: non-zero on any assertion failure.

$ErrorActionPreference = "Stop"

# --- Configuration ---
$SUITE_DIR = if ($env:SUITE_DIR) { $env:SUITE_DIR } else { "D:\Temp\agentic-live\commons" }
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$PLUGIN_DIR = Split-Path -Parent $SCRIPT_DIR
$K = $SUITE_DIR

# --- Setup ---
# F12: check RUNNING FIRST, refuse if present, THEN clean the suite dir.
New-Item -ItemType Directory -Path $SUITE_DIR -Force | Out-Null
$RUNNING = Join-Path $K "RUNNING"
if (Test-Path $RUNNING) {
  # F12a: check if the PID in the marker is still alive; if not, reclaim
  $markerContent = Get-Content $RUNNING -Raw
  if ($markerContent -match 'pid=(\d+)') {
    $markerPid = [int]$Matches[1]
    try {
      $proc = Get-Process -Id $markerPid -ErrorAction Stop
      Write-Error "RUNNING exists, refusing to clean (PID $markerPid still alive)"
      exit 8
    } catch {
      Write-Host "RUNNING marker is stale (PID $markerPid not alive), reclaiming"
      Remove-Item $RUNNING -Force
    }
  } else {
    Write-Error "RUNNING exists, refusing to clean (another suite may be running)"
    exit 8
  }
}
if (Test-Path $SUITE_DIR) { Remove-Item -Recurse -Force $SUITE_DIR }
New-Item -ItemType Directory -Path $SUITE_DIR -Force | Out-Null
Set-Location $SUITE_DIR
$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1"
if ($env:CLAUDECODE) { Remove-Item Env:CLAUDECODE }
$TOOLS = "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

# Remove heartbeat and yield log before the test
foreach ($f in @(".agentic-heartbeat.json", ".agentic-yields.log")) {
  $p = Join-Path $SUITE_DIR $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

if (Test-Path $RUNNING) { Write-Host "RUNNING exists, refusing"; exit 8 }
# F12a: include PID in the marker; use UTC time
$utcNow = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
"DeepSeekHarness live-commons-test.ps1 $utcNow pid=$PID" | Out-File -FilePath $RUNNING -Encoding utf8

# F12a: try/finally ensures RUNNING is removed even on error
try {

# Emit settings.json for this suite
$settings = '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":10000,"nudgeIdleMs":45000,"gitProbeMs":30000}}}}'
$settings | Out-File -FilePath (Join-Path $SUITE_DIR "settings.json") -Encoding utf8

# Create input feeds (JSONL: one prompt per line, processed sequentially by claude -p)
# F16: each feed has TWO prompts: (1) claim identity, (2) try a memory_add write.
$feedALines = @(
  '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona default. Report the result verbatim."}}',
  '{"type":"user","message":{"role":"user","content":"Call memory_add with text A second write after claim and kind fact. Report the tool result verbatim."}}'
)
$feedBLines = @(
  '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona default. Report the result verbatim."}}',
  '{"type":"user","message":{"role":"user","content":"Call memory_add with text B second write after claim and kind fact. Report the tool result verbatim."}}'
)
$feedALines -join "`n" | Out-File -FilePath (Join-Path $K "feed-A.json") -Encoding utf8
$feedBLines -join "`n" | Out-File -FilePath (Join-Path $K "feed-B.json") -Encoding utf8

# F13a: Pre-gate — poll the commons store until persona:default has no live claim.
$storeDir = Join-Path $env:USERPROFILE ".claude\plugins\store"
$STORE_FILE = $null
if (Test-Path $storeDir) {
  $STORE_FILE = Get-ChildItem -Path $storeDir -Filter "agentic-plugin_*.json" | Select-Object -First 1
  if ($STORE_FILE) { $STORE_FILE = $STORE_FILE.FullName }
}
if ($STORE_FILE -and (Test-Path $STORE_FILE)) {
  Write-Host "F13a: pre-gate — waiting for persona:default to have no live claim..."
  $preGateN = 0
  while ($true) {
    $liveClaims = & node -e @"
const fs = require('fs');
try {
  const store = JSON.parse(fs.readFileSync('$($STORE_FILE -replace '\\','\\\\')', 'utf8'));
  const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
  const now = Date.now();
  const stale = 90000;
  let live = 0;
  for (const key of keys) {
    const entry = store[key];
    if (entry.claims) {
      for (const c of entry.claims) {
        if (c.resource === 'persona:default' && (now - c.claimedAt) < stale) live++;
      }
    }
  }
  console.log(live);
} catch { console.log(0); }
"@ 2>$null
    if ("$liveClaims" -eq "0") {
      "F13a: pre-gate passed (no live claims)" | Out-File -FilePath (Join-Path $K "commons.assert.log") -Append -Encoding utf8
      break
    }
    $preGateN += 5
    if ($preGateN -ge 120) {
      "F13a: pre-gate timeout after ${preGateN}s" | Out-File -FilePath (Join-Path $K "commons.assert.log") -Append -Encoding utf8
      break
    }
    Start-Sleep -Seconds 5
  }
}

# --- Launch both sessions concurrently ---
$pluginDirWin = (Resolve-Path $PLUGIN_DIR).Path
$settingsWin = (Resolve-Path (Join-Path $SUITE_DIR "settings.json")).Path
$commonArgs = @(
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--plugin-dir", $pluginDirWin,
  "--settings", $settingsWin,
  "--allowedTools", $TOOLS,
  "--model", "haiku"
)

# Use Start-Process with redirected stdin/stdout/stderr
$debugFileA = Join-Path $K "commons-A.debug.log"
$debugFileB = Join-Path $K "commons-B.debug.log"
$argsA = $commonArgs + @("--debug-file", $debugFileA)
$argsB = $commonArgs + @("--debug-file", $debugFileB)

$procA = Start-Process -FilePath "claude" -ArgumentList $argsA `
  -RedirectStandardInput (Join-Path $K "feed-A.json") `
  -RedirectStandardOutput (Join-Path $K "commons-A.out.jsonl") `
  -RedirectStandardError (Join-Path $K "commons-A.err.log") `
  -NoNewWindow -PassThru

Start-Sleep -Seconds 3

$procB = Start-Process -FilePath "claude" -ArgumentList $argsB `
  -RedirectStandardInput (Join-Path $K "feed-B.json") `
  -RedirectStandardOutput (Join-Path $K "commons-B.out.jsonl") `
  -RedirectStandardError (Join-Path $K "commons-B.err.log") `
  -NoNewWindow -PassThru

# Wait for both
$procA.WaitForExit() | Out-Null
$EA = $procA.ExitCode
$procB.WaitForExit() | Out-Null
$EB = $procB.ExitCode

" A=$EA B=$EB" | Out-File -FilePath (Join-Path $K "commons.exit") -Encoding utf8

# --- Loader check: fail fast if the plugin failed to load in any child ---
$LOADER_FAIL = $false
$assertLog = Join-Path $K "commons.assert.log"
foreach ($d in @("commons-A.debug.log", "commons-B.debug.log")) {
  $dp = Join-Path $K $d
  if (Test-Path $dp) {
    $content = Get-Content $dp -Raw
    if ($content -match "failed to load") {
      "FAIL: plugin failed to load in $d" | Out-File -FilePath $assertLog -Append -Encoding utf8
      ($content -split "`n" | Where-Object { $_ -match "failed to load" }) | ForEach-Object {
        $_ | Out-File -FilePath $assertLog -Append -Encoding utf8
      }
      $LOADER_FAIL = $true
    }
  }
}
if ($LOADER_FAIL) {
  "ASSERT: 1 (LOADER FAILED)" | Out-File -FilePath (Join-Path $K "commons.exit") -Append -Encoding utf8
  exit 1
}
"LOADER: clean (no 'failed to load' in either child)" | Out-File -FilePath $assertLog -Append -Encoding utf8

# --- Assertions (F8) ---
$ASSERT_FAILED = $false

# Step 1: Find the REAL $.store file
# F15: match agentic-plugin_*.json specifically (not first *.json).
$STORE_FILE = $null
$storeDir = Join-Path $env:USERPROFILE ".claude\plugins\store"
if (Test-Path $storeDir) {
  $files = Get-ChildItem -Path $storeDir -Filter "agentic-plugin_*.json" -ErrorAction SilentlyContinue
  if ($files) {
    $STORE_FILE = $files[0].FullName
  }
}

if (-not $STORE_FILE -or -not (Test-Path $STORE_FILE)) {
  "FAIL: could not find the real `$store file" | Out-File -FilePath $assertLog -Append -Encoding utf8
  $ASSERT_FAILED = $true
} else {
  "Found store file: $STORE_FILE" | Out-File -FilePath $assertLog -Append -Encoding utf8

  # Step 2: Read the store and check for commons entries
  try {
    $store = Get-Content $STORE_FILE -Raw | ConvertFrom-Json
    $commonsKeys = @($store.PSObject.Properties | Where-Object { $_.Name -like "commons:*" } | ForEach-Object { $_.Name })

    "commons keys found: $(if ($commonsKeys.Count -gt 0) { $commonsKeys -join ', ' } else { 'NONE' })" | Out-File -FilePath $assertLog -Append -Encoding utf8

    if ($commonsKeys.Count -eq 0) {
      "FAIL: no commons:* entries in the store" | Out-File -FilePath $assertLog -Append -Encoding utf8
      $ASSERT_FAILED = $true
    } else {
      # Check that we have at least one claim entry
      $claimCount = 0
      $sessionIds = [System.Collections.Generic.HashSet[string]]::new()
      foreach ($key in $commonsKeys) {
        $entry = $store.$key
        if ($entry.claims -and $entry.claims.Count -gt 0) {
          $claimCount += $entry.claims.Count
          $sessionIds.Add($entry.sessionId) | Out-Null
        }
      }
      "total claims: $claimCount" | Out-File -FilePath $assertLog -Append -Encoding utf8
      "unique sessions: $($sessionIds.Count) ($($sessionIds -join ', '))" | Out-File -FilePath $assertLog -Append -Encoding utf8

      if ($sessionIds.Count -lt 2) {
        "FAIL: expected 2 sessions to have claimed, got $($sessionIds.Count)" | Out-File -FilePath $assertLog -Append -Encoding utf8
        $ASSERT_FAILED = $true
      }

      # Step 3: Determine the winner
      $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
      $STALE_THRESHOLD = 90000

      $allClaims = @()
      foreach ($key in $commonsKeys) {
        $entry = $store.$key
        if (-not $entry.lastSeen -or (($now - [long]$entry.lastSeen) -gt $STALE_THRESHOLD)) {
          continue
        }
        foreach ($claim in $entry.claims) {
          $allClaims += @{
            resource = $claim.resource
            claimedAt = [long]$claim.claimedAt
            holder = $entry.sessionId
          }
        }
      }

      "live claims (non-stale): $($allClaims.Count)" | Out-File -FilePath $assertLog -Append -Encoding utf8

      $personaClaims = @($allClaims | Where-Object { $_.resource -eq "persona:default" })
      if ($personaClaims.Count -eq 0) {
        "FAIL: no claims found for persona:default" | Out-File -FilePath $assertLog -Append -Encoding utf8
        $ASSERT_FAILED = $true
      } else {
        $personaClaims = $personaClaims | Sort-Object @{Expression={$_.claimedAt}}, @{Expression={$_.holder}}
        $winner = $personaClaims[0].holder
        "winner: $winner" | Out-File -FilePath $assertLog -Append -Encoding utf8
        $claimStr = ($personaClaims | ForEach-Object { "$($_.holder) @ $([DateTimeOffset]::FromUnixTimeMilliseconds($_.claimedAt).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))" }) -join ' | '
        "claims: $claimStr" | Out-File -FilePath $assertLog -Append -Encoding utf8
      }
    }
  } catch {
    "FAIL: error reading store: $_" | Out-File -FilePath $assertLog -Append -Encoding utf8
    $ASSERT_FAILED = $true
  }
}

# Step 4 (F10a/F10b): Strict mutual-exclusion assertions on out.jsonl content.
# (1) Exactly one child reports "active (epoch N, owner)"; the other reports "joined as reader".
# (2) The reader/loser is the later claimedAt in the commons store.
# (3) The loser's write was refused ("this write was not saved"); the winner's was not.
# (4) Secondary: yield log (if present) must have 0 or 1 distinct yielder, never 2.

$outA = Join-Path $K "commons-A.out.jsonl"
$outB = Join-Path $K "commons-B.out.jsonl"

# Assertion 1: exactly one owner, one reader
$ownerCount = 0
$readerCount = 0
$ownerFile = $null
$readerFile = $null
foreach ($f in @($outA, $outB)) {
  if (Test-Path $f) {
    $content = Get-Content $f -Raw
    if ($content -match 'active \(epoch \d+, owner\)') {
      $ownerCount++
      $ownerFile = $f
    }
    if ($content -match 'joined as reader') {
      $readerCount++
      $readerFile = $f
    }
  }
}
if ($ownerCount -eq 1 -and $readerCount -eq 1) {
  "F10(1): exactly one owner + one reader (owner=$(Split-Path -Leaf $ownerFile), reader=$(Split-Path -Leaf $readerFile))" | Out-File -FilePath $assertLog -Append -Encoding utf8
} else {
  "F10(1) FAIL: expected 1 owner + 1 reader, got owners=$ownerCount readers=$readerCount" | Out-File -FilePath $assertLog -Append -Encoding utf8
  $ASSERT_FAILED = $true
}

# Assertion 2: reader is the later claimedAt in the commons store
if ($STORE_FILE -and (Test-Path $STORE_FILE) -and $ownerFile -and $readerFile) {
  try {
    $storeJson = Get-Content $STORE_FILE -Raw
    $result = & node -e @"
const fs = require('fs');
const store = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const keys = Object.keys(store).filter(k => k.startsWith('commons:'));
const claims = [];
for (const key of keys) {
  const entry = store[key];
  if (entry.claims) {
    for (const c of entry.claims) {
      if (c.resource === 'persona:default') {
        claims.push({ sessionId: entry.sessionId, claimedAt: c.claimedAt });
      }
    }
  }
}
claims.sort((a, b) => a.claimedAt - b.claimedAt || a.sessionId.localeCompare(b.sessionId));
console.log(JSON.stringify(claims));
"@ $STORE_FILE 2>$null
    $claimsArr = $result | ConvertFrom-Json
    if ($claimsArr.Count -ge 2) {
      $loser = $claimsArr[$claimsArr.Count - 1]  # later claimedAt
      $winner = $claimsArr[0]  # earlier claimedAt
      # Determine which out file is the reader
      $readerContent = Get-Content $readerFile -Raw
      $ownerContent = Get-Content $ownerFile -Raw
      $loserIsReader = ($readerContent -match [regex]::Escape($loser.sessionId)) -or (-not ($ownerContent -match [regex]::Escape($loser.sessionId)))
      if ($loserIsReader) {
        "F10(2): reader is the later claimant (loser=$($loser.sessionId) @ $($loser.claimedAt), winner=$($winner.sessionId) @ $($winner.claimedAt))" | Out-File -FilePath $assertLog -Append -Encoding utf8
      } else {
        "F10(2) FAIL: reader is NOT the later claimant (loser=$($loser.sessionId) @ $($loser.claimedAt), winner=$($winner.sessionId) @ $($winner.claimedAt))" | Out-File -FilePath $assertLog -Append -Encoding utf8
        $ASSERT_FAILED = $true
      }
    }
  } catch {
    "F10(2) FAIL: error reading store: $_" | Out-File -FilePath $assertLog -Append -Encoding utf8
    $ASSERT_FAILED = $true
  }
}

# Assertion 3: loser's write refused, winner's succeeded
if ($ownerFile -and $readerFile) {
  $loseContent = Get-Content $readerFile -Raw
  $winContent = Get-Content $ownerFile -Raw
  if ($loseContent -match "this write was not saved") {
    "F10(3): loser's write was refused" | Out-File -FilePath $assertLog -Append -Encoding utf8
  } else {
    "F10(3) FAIL: loser's write was NOT refused" | Out-File -FilePath $assertLog -Append -Encoding utf8
    $ASSERT_FAILED = $true
  }
  if ($winContent -match "this write was not saved") {
    "F10(3) FAIL: winner's write WAS refused" | Out-File -FilePath $assertLog -Append -Encoding utf8
    $ASSERT_FAILED = $true
  } else {
    "F10(3): winner's write succeeded" | Out-File -FilePath $assertLog -Append -Encoding utf8
  }
}

# Assertion 4 (secondary): yield log — 0 or 1 distinct yielder, never 2
$yieldLog = Join-Path $SUITE_DIR ".agentic-yields.log"
if (Test-Path $yieldLog) {
  $yieldContent = Get-Content $yieldLog -Raw
  $yieldResult = & node -e @"
const fs = require('fs');
const lines = fs.readFileSync(process.argv[1], 'utf8').trim().split('\n');
const yielders = new Set();
for (const line of lines) {
  try {
    const rec = JSON.parse(line);
    if (rec.yielded) yielders.add(rec.yielded);
  } catch {}
}
console.log(JSON.stringify([...yielders]));
"@ $yieldLog 2>$null
  $yielderArr = $yieldResult | ConvertFrom-Json -AsArray
  if ($yielderArr.Count -le 1) {
    "F10(4): yield log has $($yielderArr.Count) distinct yielder(s)" | Out-File -FilePath $assertLog -Append -Encoding utf8
  } else {
    "F10(4) FAIL: yield log has $($yielderArr.Count) distinct yielders: $($yielderArr -join ', ')" | Out-File -FilePath $assertLog -Append -Encoding utf8
    $ASSERT_FAILED = $true
  }
} else {
  "F10(4): no yield log (reader path writes no yield line — acceptable)" | Out-File -FilePath $assertLog -Append -Encoding utf8
}

# Final exit code
if ($ASSERT_FAILED) {
  "ASSERT: 1 (FAILED)" | Out-File -FilePath (Join-Path $K "commons.exit") -Append -Encoding utf8
  $exitCode = 1
} else {
  "ASSERT: 0 (PASSED)" | Out-File -FilePath (Join-Path $K "commons.exit") -Append -Encoding utf8
  $exitCode = 0
}
} finally {
  # F12a: always remove the RUNNING marker
  if (Test-Path $RUNNING) { Remove-Item $RUNNING -Force -ErrorAction SilentlyContinue }
}
exit $exitCode
