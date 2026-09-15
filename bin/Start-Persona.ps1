# Runs one persona's supervisor under the process keeper's exit-code policy. This is the script
# each AgentPersona-<name> scheduled task launches at boot, under Windows PowerShell 5.1:
#
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File bin\Start-Persona.ps1 -Name <n> [-Roster <path>] [-EnvFile <path>] [-Release]
#
# The wrapper reads the persona's roster entry, applies the env file's allowlisted keys to its own
# process, launches bin/supervise.sh through the bash the env file names, and loops on
# Get-KeeperDecision (bin/keeper-functions.ps1) over the supervisor's exit code: relaunch after a
# delay, hold, or exit. State the operator can read lives under the entry's run directory:
# keeper.log (one line per event, rotated at 5 MB keeping keeper.log.1), keeper.json (the last
# run's facts), supervisor.out (the supervisor's own stdout and stderr, appended per run) and
# keeper.hold (present while the persona is held; -Release removes it).
#
# Exit codes of the wrapper itself: 0 when the policy said hold or exit, or when -Release ran, or
# when a hold marker was already present; 1 on a fault of the wrapper's own (an unknown flag, a
# roster or env file that cannot be trusted or read, a supervisor that cannot be launched). Task
# Scheduler's restart-on-failure setting is the backstop for the 1s.
#
# [CmdletBinding()] is what makes an unknown switch a binding error (exit 1) rather than a value
# that lands in $args while the body runs anyway.
[CmdletBinding()]
param(
    # Required. Checked in the body rather than marked Mandatory, because a Mandatory parameter
    # left off the command line opens an interactive prompt, and under a scheduled task there is
    # no console to answer it, so the run would hang rather than fail.
    [string]$Name,
    [string]$Roster = 'D:/personas/fleet.json',
    [string]$EnvFile = 'D:/personas/keeper.env',
    # Removes the hold marker and exits without launching.
    [switch]$Release,
    # Multiplies every sleep between relaunches. The DECIDE line still records the unscaled delay.
    # Exists so the unit test can walk the doubling ladder in seconds; a task never passes it.
    [double]$DelayScale = 1.0
)

. (Join-Path $PSScriptRoot 'keeper-functions.ps1')

$script:LogCapBytes = 5MB
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:LogPath = $null

<#
.SYNOPSIS
Appends one timestamped line to keeper.log as UTF-8 without a byte-order mark, rotating first.

.DESCRIPTION
The cap check runs immediately before the append so a line lands in the live generation rather
than in the one about to be renamed away. Rotation renames keeper.log to keeper.log.1, replacing
the previous one; it never truncates in place. A rotation that fails is written into the log as it
stands and stepped over, since the condition that stopped the rename outlives this run and raising
would leave the persona unlaunched over a log file. A failed append goes to stderr, the only other
channel the wrapper has.
#>
function Write-KeeperLog {
    param([Parameter(Mandatory)][string]$Text)
    if ($null -eq $script:LogPath) { return }
    $stamp = [DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    try {
        if ((Test-Path -LiteralPath $script:LogPath) -and (Get-Item -LiteralPath $script:LogPath).Length -gt $script:LogCapBytes) {
            Move-Item -Force -LiteralPath $script:LogPath -Destination "$($script:LogPath).1" -ErrorAction Stop
        }
    } catch {
        try {
            [System.IO.File]::AppendAllText($script:LogPath, "$stamp ROTATE failed: $($_.Exception.Message)" + [Environment]::NewLine, $script:Utf8NoBom)
        } catch { }
    }
    try {
        [System.IO.File]::AppendAllText($script:LogPath, "$stamp $Text" + [Environment]::NewLine, $script:Utf8NoBom)
    } catch {
        [Console]::Error.WriteLine("Start-Persona: could not append to '$($script:LogPath)': $($_.Exception.Message)")
    }
}

<#
.SYNOPSIS
Reports a fault of the wrapper's own on stderr and in the log, then exits 1.
#>
function Stop-KeeperWithError {
    param([Parameter(Mandatory)][string]$Text)
    Write-KeeperLog "ERROR $Text"
    [Console]::Error.WriteLine("Start-Persona: $Text")
    exit 1
}

<#
.SYNOPSIS
Quotes one argument for a native command line the way CreateProcess parsing expects.

.DESCRIPTION
Start-Process joins its -ArgumentList with spaces and adds no quoting of its own under Windows
PowerShell 5.1, so an argument carrying a space (a workdir under a path with spaces) would arrive
as two. An argument with no space, tab or quote is passed as written.
#>
function ConvertTo-NativeArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    if ($Text.Length -gt 0 -and $Text -notmatch '[\s"]') { return $Text }
    $escaped = $Text -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

<#
.SYNOPSIS
Applies the env file's allowlisted keys to this process and returns the bash executable it names.

.DESCRIPTION
The trust check comes first: a file any foreign principal can write, or whose owner is outside the
exempt set, is refused with the principals named on an ENV refused: line, since KEEPER_BASH_EXE is
the executable the persona boots with. The directory's foreign writers are logged as a warning and
nothing more. Then each key: outside the allowlist it is named on the ENV ignored: line and not
applied; empty or whitespace-only it is named on an ENV empty: line and not applied, because
Set-Item on env: with an empty value removes the variable under Windows PowerShell 5.1 and keeps it
under pwsh 7; a key that appears twice takes the last value and is named on an ENV duplicate: line.
KEEPER_BASH_EXE is returned rather than exported and KEEPER_PATH_PREPEND is prepended to PATH.
Returns $null when the file names no bash executable.
#>
function Set-KeeperEnvironment {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $foreign = Get-ForeignWriters -Path $Path
    } catch {
        Stop-KeeperWithError "env file '$Path' ACL could not be read: $($_.Exception.Message)"
    }
    if ($foreign.Length -gt 0) {
        Write-KeeperLog "ENV refused: $foreign"
        Stop-KeeperWithError "env file '$Path' is writable by a principal outside the exempt set: $foreign"
    }
    try {
        $dirForeign = Get-ForeignWriters -Path (Split-Path -Parent $Path)
        if ($dirForeign.Length -gt 0) { Write-KeeperLog "ENV dir-writers: $dirForeign" }
    } catch {
        Write-KeeperLog "ENV dir-writers: unreadable: $($_.Exception.Message)"
    }

    try {
        $read = Read-KeeperEnvFile -Path $Path
    } catch {
        Stop-KeeperWithError "env file '$Path' could not be read: $($_.Exception.Message)"
    }
    foreach ($dup in $read.Duplicates) { Write-KeeperLog "ENV duplicate: $dup" }
    $ignored = New-Object System.Collections.Generic.List[string]
    $bashExe = $null
    foreach ($key in $read.Values.Keys) {
        if ($script:KeeperEnvAllowlist -notcontains $key) {
            $ignored.Add($key)
            continue
        }
        $value = [string]$read.Values[$key]
        if ([string]::IsNullOrWhiteSpace($value)) {
            Write-KeeperLog "ENV empty: $key"
            continue
        }
        switch ($key) {
            'KEEPER_BASH_EXE' { $bashExe = $value }
            'KEEPER_PATH_PREPEND' {
                $delivered = [Environment]::GetEnvironmentVariable('PATH', 'Process')
                if ([string]::IsNullOrEmpty($delivered)) { $env:PATH = $value } else { $env:PATH = $value + ';' + $delivered }
            }
            default {
                try {
                    Set-Item -Path "env:$key" -Value $value -ErrorAction Stop
                } catch {
                    Write-KeeperLog "ENV failed: $key $($_.Exception.Message)"
                }
            }
        }
    }
    if ($ignored.Count -gt 0) { Write-KeeperLog "ENV ignored: $($ignored -join ';')" }
    return $bashExe
}

<#
.SYNOPSIS
Runs the supervisor once, appends its output to supervisor.out, and returns its exit code, uptime and last stderr line.

.DESCRIPTION
stdout and stderr go to two temporary files under the run directory, then are appended (stdout
first) to supervisor.out and the temporary files removed. A 2>&1 merge would instead wrap every
stderr line in an ErrorRecord whose file rendering carries category noise. A launch that cannot
start is a wrapper fault and ends the run.
#>
function Invoke-Supervisor {
    param(
        [Parameter(Mandatory)][string]$BashExe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$OutputPath
    )
    $stdoutTemp = "$OutputPath.stdout.tmp"
    $stderrTemp = "$OutputPath.stderr.tmp"
    $native = @($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ })
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $BashExe -ArgumentList $native -WorkingDirectory $WorkingDirectory `
            -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutTemp -RedirectStandardError $stderrTemp -ErrorAction Stop
        $code = $process.ExitCode
    } catch {
        Stop-KeeperWithError "launch failed: '$BashExe' $($Arguments -join ' '): $($_.Exception.Message)"
    }
    $stopwatch.Stop()
    $lastError = ''
    foreach ($temp in @($stdoutTemp, $stderrTemp)) {
        try {
            if (Test-Path -LiteralPath $temp) {
                $text = [System.IO.File]::ReadAllText($temp)
                if ($text.Length -gt 0) { [System.IO.File]::AppendAllText($OutputPath, $text, $script:Utf8NoBom) }
                if ($temp -eq $stderrTemp) {
                    foreach ($line in ($text -split "`r?`n")) {
                        if (-not [string]::IsNullOrWhiteSpace($line)) { $lastError = $line.Trim() }
                    }
                }
                Remove-Item -LiteralPath $temp -Force -ErrorAction Stop
            }
        } catch {
            Write-KeeperLog "CAPTURE failed: '$temp' $($_.Exception.Message)"
        }
    }
    return @{
        ExitCode = $code
        UptimeSeconds = [int][Math]::Floor($stopwatch.Elapsed.TotalSeconds)
        LastErrorLine = $lastError
    }
}

<#
.SYNOPSIS
Writes keeper.json as UTF-8 without a byte-order mark; a failure is logged and stepped over.
#>
function Write-KeeperState {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][hashtable]$State)
    try {
        $json = [pscustomobject]$State | ConvertTo-Json -Depth 3
        [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $script:Utf8NoBom)
    } catch {
        Write-KeeperLog "STATE failed: '$Path' $($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($Name)) {
    [Console]::Error.WriteLine('Start-Persona: -Name is required.')
    exit 1
}

try {
    $entry = Read-KeeperRoster -Path $Roster -Name $Name
} catch {
    [Console]::Error.WriteLine("Start-Persona: $($_.Exception.Message)")
    exit 1
}

$runDir = [string]$entry.rundir
if ([string]::IsNullOrWhiteSpace($runDir)) { $runDir = Join-Path ([string]$entry.workdir) 'run' }
try {
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) {
        # New-Item takes -Path under Windows PowerShell 5.1; -LiteralPath arrived in a later engine.
        New-Item -ItemType Directory -Path $runDir -Force -ErrorAction Stop | Out-Null
    }
} catch {
    [Console]::Error.WriteLine("Start-Persona: run directory '$runDir' could not be created: $($_.Exception.Message)")
    exit 1
}
$script:LogPath = Join-Path $runDir 'keeper.log'
$holdPath = Join-Path $runDir 'keeper.hold'
$statePath = Join-Path $runDir 'keeper.json'
$outputPath = Join-Path $runDir 'supervisor.out'

if ($Release) {
    if (Test-Path -LiteralPath $holdPath -PathType Leaf) {
        try {
            Remove-Item -LiteralPath $holdPath -Force -ErrorAction Stop
        } catch {
            Stop-KeeperWithError "hold marker '$holdPath' could not be removed: $($_.Exception.Message)"
        }
        Write-KeeperLog "RELEASE $holdPath"
    } else {
        Write-KeeperLog 'RELEASE none'
    }
    exit 0
}

if (Test-Path -LiteralPath $holdPath -PathType Leaf) {
    $reason = 'unreadable'
    try {
        $first = @(Get-Content -LiteralPath $holdPath -Encoding UTF8 -TotalCount 1 -ErrorAction Stop)
        if ($first.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($first[0])) { $reason = $first[0].Trim() }
    } catch {
        $reason = "unreadable: $($_.Exception.Message)"
    }
    Write-KeeperLog "HOLD $reason"
    exit 0
}

# The env file is the source of KEEPER_BASH_EXE. When it is absent, a value already on the process
# environment stands in, so a hand launch from a shell that exported it still works; a task with
# neither has nothing to run bash with and stops.
$bashExe = $null
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
    $bashExe = Set-KeeperEnvironment -Path $EnvFile
} else {
    Write-KeeperLog "ENV missing: $EnvFile"
}
if ([string]::IsNullOrWhiteSpace($bashExe)) {
    $bashExe = [Environment]::GetEnvironmentVariable('KEEPER_BASH_EXE', 'Process')
}
if ([string]::IsNullOrWhiteSpace($bashExe)) {
    Stop-KeeperWithError "no bash executable: KEEPER_BASH_EXE is neither in env file '$EnvFile' nor in the process environment"
}

try {
    $invocation = Build-SupervisorInvocation -Entry $entry -RosterPath $Roster
} catch {
    Stop-KeeperWithError $_.Exception.Message
}
foreach ($key in $invocation.Environment.Keys) {
    try {
        Set-Item -Path "env:$key" -Value $invocation.Environment[$key] -ErrorAction Stop
    } catch {
        Write-KeeperLog "ENV failed: $key $($_.Exception.Message)"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$supervisorPath = (Join-Path $repoRoot 'bin/supervise.sh') -replace '\\', '/'
$arguments = @($supervisorPath) + $invocation.Arguments

$launchCount = 0
$delay = $script:KeeperBaseDelaySeconds
$exit1Count = 0
while ($true) {
    $launchCount++
    $started = [DateTime]::UtcNow
    Write-KeeperLog "LAUNCH $launchCount $bashExe $($arguments -join ' ')"
    $run = Invoke-Supervisor -BashExe $bashExe -Arguments $arguments -WorkingDirectory $repoRoot -OutputPath $outputPath
    $ended = [DateTime]::UtcNow
    Write-KeeperLog "EXIT $launchCount code=$($run.ExitCode) uptime=$($run.UptimeSeconds)"

    $decision = Get-KeeperDecision -ExitCode $run.ExitCode -UptimeSeconds $run.UptimeSeconds -PreviousDelaySeconds $delay -ConsecutiveExit1Count $exit1Count
    $holdReason = $null
    if ($decision.Action -eq 'hold') { $holdReason = $decision.Reason }
    Write-KeeperState -Path $statePath -State @{
        persona = $Name
        launchCount = $launchCount
        lastStart = $started.ToString('o')
        lastEnd = $ended.ToString('o')
        lastExitCode = $run.ExitCode
        currentDelay = $decision.NextDelaySeconds
        holdReason = $holdReason
    }
    Write-KeeperLog "DECIDE exit=$($run.ExitCode) uptime=$($run.UptimeSeconds) action=$($decision.Action) delay=$($decision.DelaySeconds) reason=$($decision.Reason)"

    switch ($decision.Action) {
        'hold' {
            # Line 1 is the reason. An exit-1 hold adds the supervisor's last stderr line and the
            # path of supervisor.out, so the operator reading the marker sees why without opening it.
            $lines = New-Object System.Collections.Generic.List[string]
            $lines.Add($decision.Reason)
            if ($run.ExitCode -eq 1) {
                $lines.Add($run.LastErrorLine)
                $lines.Add($outputPath)
            }
            try {
                [System.IO.File]::WriteAllLines($holdPath, $lines, $script:Utf8NoBom)
            } catch {
                Stop-KeeperWithError "hold marker '$holdPath' could not be written: $($_.Exception.Message)"
            }
            exit 0
        }
        'exit' {
            exit 0
        }
        default {
            $delay = $decision.NextDelaySeconds
            $exit1Count = $decision.NextExit1Count
            Start-Sleep -Milliseconds ([int][Math]::Round($decision.DelaySeconds * 1000 * $DelayScale))
        }
    }
}
