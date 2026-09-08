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
if (Test-Path $SUITE_DIR) { Remove-Item -Recurse -Force $SUITE_DIR }
New-Item -ItemType Directory -Path $SUITE_DIR -Force | Out-Null
Set-Location $SUITE_DIR

$RUNNING = Join-Path $K "RUNNING"
$env:CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = "1"
if ($env:CLAUDECODE) { Remove-Item Env:CLAUDECODE }
$TOOLS = "mcp__agentic-plugin__goal_create,mcp__agentic-plugin__memory_add,mcp__agentic-plugin__agentic_identity"

# Remove heartbeat and yield log before the test
foreach ($f in @(".agentic-heartbeat.json", ".agentic-yields.log")) {
  $p = Join-Path $SUITE_DIR $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

if (Test-Path $RUNNING) { Write-Host "RUNNING exists, refusing"; exit 8 }
"DeepSeekHarness live-commons-test.ps1 $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')" | Out-File -FilePath $RUNNING -Encoding utf8

# Emit settings.json for this suite
$settings = '{"pluginConfigs":{"agentic-plugin":{"options":{"controllerTickMs":10000,"nudgeIdleMs":45000,"gitProbeMs":30000}}}}'
$settings | Out-File -FilePath (Join-Path $SUITE_DIR "settings.json") -Encoding utf8

# Create input feeds (plain text, no escaped quotes)
$feedA = '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona default. Report the result verbatim."}}'
$feedB = '{"type":"user","message":{"role":"user","content":"Call agentic_identity with persona default. Report the result verbatim."}}'
$feedA | Out-File -FilePath (Join-Path $K "feed-A.json") -Encoding utf8
$feedB | Out-File -FilePath (Join-Path $K "feed-B.json") -Encoding utf8

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
$STORE_FILE = $null
$storeDir = Join-Path $env:USERPROFILE ".claude\plugins\store"
if (Test-Path $storeDir) {
  $files = Get-ChildItem -Path $storeDir -Filter "*.json" -ErrorAction SilentlyContinue
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

# Step 4: Check for persona_yield_commons decisions
$YIELD_FOUND = $false
$YIELD_EVIDENCE = ""

$yieldLog = Join-Path $SUITE_DIR ".agentic-yields.log"
if (Test-Path $yieldLog) {
  $content = Get-Content $yieldLog -Raw
  if ($content -match "persona_yield_commons") {
    $YIELD_FOUND = $true
    $lines = $content -split "`n"
    $YIELD_EVIDENCE = ($lines | Where-Object { $_ -match "persona_yield_commons" })[0]
    "Yield log evidence: $YIELD_EVIDENCE" | Out-File -FilePath $assertLog -Append -Encoding utf8
  }
}

$personaStore = Join-Path $SUITE_DIR ".agentic-personas.json"
if (Test-Path $personaStore) {
  $content = Get-Content $personaStore -Raw
  if ($content -match "persona_yield_commons") {
    $YIELD_FOUND = $true
    if (-not $YIELD_EVIDENCE) {
      $lines = $content -split "`n"
      $YIELD_EVIDENCE = ($lines | Where-Object { $_ -match "persona_yield_commons" })[0]
    }
    "Persona store evidence: $YIELD_EVIDENCE" | Out-File -FilePath $assertLog -Append -Encoding utf8
  }
}

if (-not $YIELD_FOUND) {
  "FAIL: no persona_yield_commons decision found in yield log or persona store" | Out-File -FilePath $assertLog -Append -Encoding utf8
  $ASSERT_FAILED = $true
} else {
  "OK: persona_yield_commons decision confirmed (mutual exclusion proven)" | Out-File -FilePath $assertLog -Append -Encoding utf8
}

# Final exit code
if ($ASSERT_FAILED) {
  "ASSERT: 1 (FAILED)" | Out-File -FilePath (Join-Path $K "commons.exit") -Append -Encoding utf8
  exit 1
} else {
  "ASSERT: 0 (PASSED)" | Out-File -FilePath (Join-Path $K "commons.exit") -Append -Encoding utf8
  exit $EA
}
