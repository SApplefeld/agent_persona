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
# keeper.hold (present while the persona is held; -Release removes it). A refusal that happens
# before the roster has named a run directory goes to keeper-refused.log beside the roster file,
# the only place known at that point, because a scheduled task has no console for stderr to reach.
#
# Exit codes of the wrapper itself: 0 when the policy said hold or exit, or when -Release ran, or
# when a hold marker was already present; 1 on a fault of the wrapper's own (an unknown flag, a
# roster or env file that cannot be read, a supervisor that cannot be launched). Task
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
    # Exists so the unit test can walk the doubling ladder in seconds; a task never passes it. A
    # negative scale would make Start-Sleep throw and end the loop at the first relaunch, so it is
    # a binding error instead.
    [ValidateRange(0, [double]::MaxValue)]
    [double]$DelayScale = 1.0
)

. (Join-Path $PSScriptRoot 'keeper-functions.ps1')

$script:LogCapBytes = 5MB
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:LogPath = $null

# How long one wait on the launched supervisor blocks before it is renewed. It bounds nothing: the
# wait returns the moment the process exits, and the renewal only exists so that a supervisor
# running longer than this never ends the wait.
$script:ExitWaitMilliseconds = 1000

# What every capture file of this wrapper carries in its name: the process id, and the moment the
# process started. Windows hands a process id out again once the process holding it is gone, so a
# name built from the id alone can be the name a survivor of an earlier wrapper is still writing
# into, and Start-Process opens a redirect target by truncating it. The start time distinguishes
# this incarnation from any other that ever held the same id, across a reboot included.
$script:CaptureId = "$PID-" + [System.Diagnostics.Process]::GetCurrentProcess().StartTime.ToString('yyyyMMddHHmmssfff', [System.Globalization.CultureInfo]::InvariantCulture)

# How much of a capture file's tail is read to find the supervisor's last stderr line. The line sits
# at the end of the file, so reading the end of it costs a launch that wrote megabytes a buffer
# rather than the whole capture as one string.
$script:CaptureTailBytes = 64KB

<#
.SYNOPSIS
Appends one timestamped line to a keeper log as UTF-8 without a byte-order mark, rotating first.

.DESCRIPTION
Without -Path the line goes to the run directory's keeper.log, which is unknown until the roster
has been read; a line written before then and without a path is dropped. A refusal raised before
that point names the fallback log beside the roster file instead, so the operator has something to
read where a scheduled task gives stderr no console.

The cap check runs immediately before the append so a line lands in the live generation rather
than in the one about to be renamed away. Rotation renames the log to <name>.1, replacing the
previous one; it never truncates in place. A rotation that fails is written into the log as it
stands and stepped over, since the condition that stopped the rename outlives this run and raising
would leave the persona unlaunched over a log file. A failed append goes to stderr, the only other
channel the wrapper has.
#>
function Write-KeeperLog {
    param([Parameter(Mandatory)][string]$Text, [string]$Path)
    if ([string]::IsNullOrEmpty($Path)) { $Path = $script:LogPath }
    if ([string]::IsNullOrEmpty($Path)) { return }
    $stamp = [DateTime]::UtcNow.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
    try {
        if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt $script:LogCapBytes) {
            Move-Item -Force -LiteralPath $Path -Destination "$Path.1" -ErrorAction Stop
        }
    } catch {
        try {
            [System.IO.File]::AppendAllText($Path, "$stamp ROTATE failed: $($_.Exception.Message)" + [Environment]::NewLine, $script:Utf8NoBom)
        } catch { }
    }
    try {
        [System.IO.File]::AppendAllText($Path, "$stamp $Text" + [Environment]::NewLine, $script:Utf8NoBom)
    } catch {
        [Console]::Error.WriteLine("Start-Persona: could not append to '$Path': $($_.Exception.Message)")
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
A process is started from one command line rather than an argument array, so an argument carrying a
space (a workdir under a path with spaces) would arrive as two unless it is quoted here. An
argument with no space, tab or quote is passed as written.
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
Each key: outside the allowlist it is named on the ENV ignored: line and not applied; empty or
whitespace-only it is named on an ENV empty: line and not applied, because Set-Item on env: with an
empty value removes the variable under Windows PowerShell 5.1 and keeps it under pwsh 7; a key that
appears twice takes the last value and is named on an ENV duplicate: line; a value written inside a
matching pair of quotes loses them and is named on an ENV unquoted: line, since the quotes would
otherwise be part of the file name or the path.
KEEPER_BASH_EXE is returned rather than exported and KEEPER_PATH_PREPEND is prepended to PATH.
Returns $null when the file names no bash executable.
#>
function Set-KeeperEnvironment {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $read = Read-KeeperEnvFile -Path $Path
    } catch {
        Stop-KeeperWithError "env file '$Path' could not be read: $($_.Exception.Message)"
    }
    foreach ($dup in $read.Duplicates) { Write-KeeperLog "ENV duplicate: $dup" }
    foreach ($key in $read.Unquoted) { Write-KeeperLog "ENV unquoted: $key" }
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
Appends one capture file to supervisor.out while another process may still be writing to it.

.DESCRIPTION
A descendant that outlives the supervisor holds the write end of the file it inherited, and an
ordinary read asks for a share mode such a writer's handle refuses. The source is opened permitting
a concurrent writer and a concurrent delete, so the copy takes what the file holds at the moment it
runs. The bytes go through a buffer rather than through one string, so a supervisor that wrote a
great deal costs the wrapper the buffer and not the whole launch's output. Copying the bytes also
keeps whatever the supervisor wrote exactly as it wrote it, which for bash and node programs is
UTF-8 whatever the console code page says.
#>
function Copy-KeeperCaptureFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Destination)
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $source = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try {
        $target = [System.IO.File]::Open($Destination, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try { $source.CopyTo($target) } finally { $target.Dispose() }
    } finally { $source.Dispose() }
}

<#
.SYNOPSIS
Returns the last non-blank line of a capture file, reading only its tail.

.DESCRIPTION
The file is opened the way Copy-KeeperCaptureFile opens it, so a descendant still holding the write
end does not refuse the read. Only the last $script:CaptureTailBytes are read, since the line being
looked for is the last one. A read that starts inside the file lands in the middle of a line and of
a UTF-8 sequence, so the first line of such a read is dropped: the line before it is whole, and one
of those is what the marker names.
#>
function Get-KeeperCaptureLastLine {
    param([Parameter(Mandatory)][string]$Path)
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    $partial = $false
    try {
        if ($stream.Length -gt $script:CaptureTailBytes) {
            [void]$stream.Seek(-$script:CaptureTailBytes, [System.IO.SeekOrigin]::End)
            $partial = $true
        }
        $reader = New-Object System.IO.StreamReader($stream, $script:Utf8NoBom)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
    $lines = @($text -split "`r?`n")
    if ($partial -and $lines.Count -gt 1) { $lines = $lines[1..($lines.Count - 1)] }
    $last = ''
    foreach ($line in $lines) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { $last = $line.Trim() }
    }
    return $last
}

<#
.SYNOPSIS
Removes the capture files this wrapper's own earlier launches left behind in the run directory.

.DESCRIPTION
A launch whose supervisor left a descendant behind cannot remove its own two capture files, because
that descendant still holds the handle it inherited and Windows refuses to delete a file opened
without delete sharing. Each later launch of this wrapper takes the ones that have since come free,
so the run directory carries a stale pair only while a survivor of that launch is alive.

Only names carrying this wrapper's own capture id are taken. Another wrapper's pair is deletable in
the window between its supervisor exiting and that wrapper appending the pair to supervisor.out,
which is a window nothing outside that wrapper can see, so a sweep by name shape alone would take a
run's captured output out from under a live peer and leave it logging a capture it could not read.
A pair an earlier incarnation of this wrapper left behind is outside this sweep for that same
reason and stays in the run directory.
#>
function Remove-KeeperCaptureLeftovers {
    param([Parameter(Mandatory)][string]$OutputPath)
    $leaf = Split-Path -Leaf $OutputPath
    try {
        $stale = @(Get-ChildItem -LiteralPath (Split-Path -Parent $OutputPath) -File -ErrorAction Stop |
            Where-Object { $_.Name -like "$leaf.$script:CaptureId.*.stdout" -or $_.Name -like "$leaf.$script:CaptureId.*.stderr" })
    } catch {
        return
    }
    foreach ($file in $stale) {
        try { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop } catch { }
    }
}

<#
.SYNOPSIS
Runs the supervisor once, appends its output to supervisor.out, and returns its exit code, uptime and last stderr line.

.DESCRIPTION
The supervisor's stdout and stderr are redirected to two files of this launch's own, and the wait is
on the launched process alone: Start-Process returns as soon as the process is started when it is
not given -Wait, and WaitForExit with a timeout returns the moment that one process exits. -Wait
waits for every descendant instead, and a supervisor that exits 5 has left one by definition, so the
wrapper would not see that exit until the survivor died and would then count the survivor's life as
the supervisor's uptime.

The process's handle is read as the next statement after the start, because the exit code is
readable afterwards only where the first read of the handle happened while the process was still
alive. A supervisor that exits inside that gap, which is the time one statement takes against a
process that has still to load its image, reports no exit code, and the caller treats that as a
wrapper fault rather than feeding it to the policy.

The two streams are captured separately because the hold marker names the supervisor's last stderr
line, which is knowable only from a stream carrying stderr alone. Both files are appended to
supervisor.out, stdout first, and then removed, so the record the operator reads is one file per run
directory. Each name carries this wrapper's capture id and this launch's number: a descendant that
outlives the supervisor keeps writing into the file handle it inherited, and a name no later launch
and no other wrapper reuses is what keeps that writing out of the next launch's capture and makes
the file it holds open safe to leave until a later launch can remove it. A launch that cannot start
is a wrapper fault and ends the run.
#>
function Invoke-Supervisor {
    param(
        [Parameter(Mandatory)][string]$BashExe,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][int]$Launch
    )
    Remove-KeeperCaptureLeftovers -OutputPath $OutputPath
    $stdoutPath = "$OutputPath.$script:CaptureId.$Launch.stdout"
    $stderrPath = "$OutputPath.$script:CaptureId.$Launch.stderr"
    # One command line, each argument quoted the way CreateProcess parsing expects.
    $native = @($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ })
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $process = Start-Process -FilePath $BashExe -ArgumentList $native -WorkingDirectory $WorkingDirectory `
            -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -ErrorAction Stop
        $null = $process.Handle
    } catch {
        Stop-KeeperWithError "launch failed: '$BashExe' $($Arguments -join ' '): $($_.Exception.Message)"
    }
    while (-not $process.WaitForExit($script:ExitWaitMilliseconds)) { }
    $stopwatch.Stop()
    $exitCode = $process.ExitCode
    $process.Dispose()

    $lastError = ''
    foreach ($path in @($stdoutPath, $stderrPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            Copy-KeeperCaptureFile -Path $path -Destination $OutputPath
            if ($path -eq $stderrPath) { $lastError = Get-KeeperCaptureLastLine -Path $path }
        } catch {
            # The output copy is not what the persona is for, so a run whose capture could not be
            # read or appended is recorded and carries on.
            Write-KeeperLog "CAPTURE failed: '$path' $($_.Exception.Message)"
            continue
        }
        try {
            Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        } catch {
            Write-KeeperLog "CAPTURE held: '$path' $($_.Exception.Message)"
        }
    }

    return @{
        ExitCode = $exitCode
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

# Every refusal until the run directory is ready has no keeper.log to reach, and a scheduled task
# gives stderr no console either, so each one is also written beside the roster file. That is the one
# location known without reading anything the roster says, so it is resolved before the first refusal
# rather than after it.
$rosterDir = Split-Path -Parent $Roster
if ([string]::IsNullOrWhiteSpace($rosterDir)) { $rosterDir = '.' }
# Resolved against PowerShell's own current location before anything writes it. Write-KeeperLog
# checks the size through the provider and appends through .NET, which resolve a relative path
# against different roots, so a path resolved here is the one both halves act on.
$fallbackLog = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
    (Join-Path $rosterDir 'keeper-refused.log'))

if ([string]::IsNullOrWhiteSpace($Name)) {
    Write-KeeperLog -Path $fallbackLog -Text 'ROSTER error: -Name is required.'
    [Console]::Error.WriteLine('Start-Persona: -Name is required.')
    exit 1
}

try {
    $entry = Read-KeeperRoster -Path $Roster -Name $Name
} catch {
    Write-KeeperLog -Path $fallbackLog -Text "ROSTER error: $($_.Exception.Message)"
    [Console]::Error.WriteLine("Start-Persona: $($_.Exception.Message)")
    exit 1
}

# The roster's spelling of the name, not the command line's: -Name matches case-insensitively, and
# the state file and the supervisor argument both name the persona the roster runs.
$personaName = [string]$entry.name

# The wrapper's own paths keep the Windows spelling the roster carries, because .NET resolves these;
# only the arguments handed to bash are converted (Build-SupervisorInvocation).
$runDir = [string]$entry.rundir
if ([string]::IsNullOrWhiteSpace($runDir)) { $runDir = Join-Path ([string]$entry.workdir) 'run' }
# Resolved for the same reason $fallbackLog is: the run directory is created through .NET and the
# logs under it are rotated through the provider.
$runDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($runDir)
try {
    if (-not (Test-Path -LiteralPath $runDir -PathType Container)) {
        # .NET takes the path literally, as the guard above does. New-Item -Path would instead read
        # a run directory whose name carries [ or ] as a wildcard and create some other directory,
        # or none.
        [void][System.IO.Directory]::CreateDirectory($runDir)
    }
} catch {
    Write-KeeperLog -Path $fallbackLog -Text "ROSTER error: run directory '$runDir' could not be created: $($_.Exception.Message)"
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
# bash is the only reader of this path, so it is spelled the way bash resolves it, as every other
# argument in the list is.
$supervisorPath = ConvertTo-BashPath (Join-Path $repoRoot 'bin/supervise.sh')
$arguments = @($supervisorPath) + $invocation.Arguments

$launchCount = 0
$delay = $script:KeeperBaseDelaySeconds
$exit1Count = 0
while ($true) {
    $launchCount++
    $started = [DateTime]::UtcNow
    Write-KeeperLog "LAUNCH $launchCount $bashExe $($arguments -join ' ')"
    $run = Invoke-Supervisor -BashExe $bashExe -Arguments $arguments -WorkingDirectory $repoRoot -OutputPath $outputPath -Launch $launchCount
    $ended = [DateTime]::UtcNow
    Write-KeeperLog "EXIT $launchCount code=$($run.ExitCode) uptime=$($run.UptimeSeconds)"

    # No exit code means the policy has no input: passing $null to its Mandatory [int] would be an
    # uncaught binding error, which would end the wrapper with no DECIDE line, no state file and no
    # hold marker. It is a fault of the wrapper's own instead.
    if ($null -eq $run.ExitCode) {
        Stop-KeeperWithError "supervisor '$bashExe' reported no exit code after launch $launchCount"
    }

    $decision = Get-KeeperDecision -ExitCode $run.ExitCode -UptimeSeconds $run.UptimeSeconds -PreviousDelaySeconds $delay -ConsecutiveExit1Count $exit1Count
    $holdReason = $null
    if ($decision.Action -eq 'hold') { $holdReason = $decision.Reason }
    Write-KeeperState -Path $statePath -State @{
        persona = $personaName
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
                # Exit 0 even though the marker is missing: the task carries RestartCount 999 at a
                # one-minute interval, so exiting 1 here would have the scheduler relaunch a persona
                # the policy just said to stop, within the minute. That restart is for the wrapper
                # faulting, not for a supervisor that said stop. The ERROR line is the record, and
                # without the marker the next start launches again.
                Write-KeeperLog "ERROR hold marker '$holdPath' could not be written: $($_.Exception.Message)"
                [Console]::Error.WriteLine("Start-Persona: hold marker '$holdPath' could not be written: $($_.Exception.Message)")
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
