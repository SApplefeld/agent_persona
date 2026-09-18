# Pure functions shared by the process keeper's scripts. Dot-sourced by bin/Start-Persona.ps1 (the
# wrapper the scheduled task runs) and bin/keeper-probe.ps1 (the recorder that measures what a
# task delivers), so the allowlist, the env file reader, the roster reader, the supervisor
# invocation builder and the exit-code policy each exist once.
#
#   . (Join-Path $PSScriptRoot 'keeper-functions.ps1')
#
# Nothing here writes a file, sets an environment variable or launches a process. A function that
# cannot produce its answer throws, and the error names the path it was reading, so the caller
# logs it and decides what to do. Both callers run under Windows PowerShell 5.1.

# Every environment variable the keeper is willing to take from the env file. Named explicitly so
# that no key outside this list reaches the process that launches the supervisor. KEEPER_BASH_EXE
# names the executable that runs and is not exported; KEEPER_PATH_PREPEND decides where node and
# claude resolve and is prepended to the process PATH rather than set as a variable of its own.
$script:KeeperEnvAllowlist = @(
    'KEEPER_BASH_EXE',
    'KEEPER_PATH_PREPEND',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP'
)

# The exit-code policy's constants. The delay between relaunches starts at the base, doubles on a
# crash-class exit up to the cap, and returns to the base after a run that lasted the reset uptime.
# Exit 1 holds after the count below of consecutive exit-1 runs that each ended inside the short
# uptime, because a configuration error repeats at once while a launch-time fault a boot can hit
# once does not.
$script:KeeperBaseDelaySeconds = 300
$script:KeeperMaxDelaySeconds = 14400
$script:KeeperResetUptimeSeconds = 3600
$script:KeeperExit1HoldCount = 3
$script:KeeperExit1ShortUptimeSeconds = 60

<#
.SYNOPSIS
Decides what the keeper does after one supervisor exit, from the exit code and the run's shape.

.DESCRIPTION
Implements the policy table: exit 0 holds; exit 1 relaunches after the base delay and holds once
the consecutive short exit-1 count reaches the hold count; exit 2 relaunches after the base delay
with the ladder untouched; 130 and 143 exit without relaunching; every other code relaunches after
the current delay and doubles it up to the cap. A run that lasted the reset uptime or longer puts
the ladder back at the base before the row is applied, so a persona that ran for an hour and then
crashed waits the base delay, not whatever the ladder had climbed to.

Returns a hashtable: Action is 'hold', 'relaunch' or 'exit'; DelaySeconds is how long to wait
before the next launch (0 when not relaunching); NextDelaySeconds is the ladder value to carry into
the next decision; NextExit1Count is the consecutive short exit-1 count to carry; Reason is one
line of text with no newline, fit for the DECIDE log line and the hold marker.
#>
function Get-KeeperDecision {
    param(
        [Parameter(Mandatory)][int]$ExitCode,
        [Parameter(Mandatory)][int]$UptimeSeconds,
        [Parameter(Mandatory)][int]$PreviousDelaySeconds,
        [Parameter(Mandatory)][int]$ConsecutiveExit1Count
    )
    $delay = $PreviousDelaySeconds
    if ($delay -lt $script:KeeperBaseDelaySeconds) { $delay = $script:KeeperBaseDelaySeconds }
    if ($UptimeSeconds -ge $script:KeeperResetUptimeSeconds) { $delay = $script:KeeperBaseDelaySeconds }

    switch ($ExitCode) {
        0 {
            return @{
                Action = 'hold'; DelaySeconds = 0; NextDelaySeconds = $delay; NextExit1Count = 0
                Reason = 'supervisor exited 0: shutdown honored or stop complete'
            }
        }
        1 {
            $count = 0
            if ($UptimeSeconds -lt $script:KeeperExit1ShortUptimeSeconds) { $count = $ConsecutiveExit1Count + 1 }
            if ($count -ge $script:KeeperExit1HoldCount) {
                return @{
                    Action = 'hold'; DelaySeconds = 0; NextDelaySeconds = $delay; NextExit1Count = $count
                    Reason = "supervisor exited 1 on $count consecutive runs each under $($script:KeeperExit1ShortUptimeSeconds) seconds: usage or configuration error"
                }
            }
            return @{
                Action = 'relaunch'; DelaySeconds = $script:KeeperBaseDelaySeconds; NextDelaySeconds = $delay; NextExit1Count = $count
                Reason = "supervisor exited 1: usage, configuration or launch-time fault, short exit-1 run $count of $($script:KeeperExit1HoldCount)"
            }
        }
        2 {
            return @{
                Action = 'relaunch'; DelaySeconds = $script:KeeperBaseDelaySeconds; NextDelaySeconds = $delay; NextExit1Count = 0
                Reason = 'supervisor exited 2: pre-launch gate failed or timed out'
            }
        }
        { $_ -eq 130 -or $_ -eq 143 } {
            return @{
                Action = 'exit'; DelaySeconds = 0; NextDelaySeconds = $delay; NextExit1Count = 0
                Reason = "supervisor exited ${ExitCode}: signaled"
            }
        }
        default {
            $meaning = switch ($ExitCode) {
                3 { 'crash loop' }
                4 { 'restart budget exhausted' }
                5 { 'a child process survived the stop' }
                default { 'unknown exit code' }
            }
            $next = $delay * 2
            if ($next -gt $script:KeeperMaxDelaySeconds) { $next = $script:KeeperMaxDelaySeconds }
            return @{
                Action = 'relaunch'; DelaySeconds = $delay; NextDelaySeconds = $next; NextExit1Count = 0
                Reason = "supervisor exited ${ExitCode}: $meaning"
            }
        }
    }
}

<#
.SYNOPSIS
Reads the roster file and returns the enabled entry with the given name.

.DESCRIPTION
The roster is a JSON array of entry objects (see the roster table in the process keeper plan and
bin/fleet.example.json). The file is read as UTF-8. A file that cannot be read or parsed, a name no
entry carries, an entry that carries no enabled field, and an entry whose enabled field is not the
JSON boolean true are each a thrown error naming the roster path and the name, so a wrapper started
for a persona the roster does not run stops with a message rather than launching something.
#>
function Read-KeeperRoster {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Name
    )
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
        $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        # Windows PowerShell 5.1 returns a JSON array as one object[] rather than enumerating it,
        # so it is piped through ForEach-Object, which enumerates, before it is wrapped as a list.
        $entries = @($parsed | ForEach-Object { $_ })
    } catch {
        throw "roster '$Path' could not be read for persona '$Name': $($_.Exception.Message)"
    }
    $match = $null
    foreach ($entry in $entries) {
        if ($null -eq $entry) { continue }
        if ([string]$entry.name -eq $Name) { $match = $entry; break }
    }
    if ($null -eq $match) {
        throw "roster '$Path' has no entry named '$Name'"
    }
    # -ne coerces its right side to the left side's type, so a string "false" would compare against
    # "True" case-insensitively and pass as enabled. The field must be a JSON boolean. The property
    # is looked up rather than read through $match.enabled, so an entry that carries no such field
    # is told that, and one that carries the wrong type is told that instead.
    $enabledProperty = $match.PSObject.Properties['enabled']
    if ($null -eq $enabledProperty) {
        throw "roster '$Path' entry '$Name' has no 'enabled' field: write enabled true or false without quotes"
    }
    if ($enabledProperty.Value -isnot [bool]) {
        throw "roster '$Path' entry '$Name' has an 'enabled' field that is not a JSON boolean: write true or false without quotes"
    }
    if (-not $match.enabled) {
        throw "roster '$Path' entry '$Name' is not enabled"
    }
    return $match
}

<#
.SYNOPSIS
Spells a Windows path the way the bash that runs the supervisor resolves it.

.DESCRIPTION
bin/supervise.sh treats any --rundir that does not start with / as relative to the directory bash
was started in and prefixes it, so D:/personas/dev/run would become <repo>/D:/personas/dev/run and
the supervisor's own files would land somewhere the wrapper never looks. Git bash mounts each drive
at /<letter>, so D:/personas/dev/run and /d/personas/dev/run name the same directory to bash while
only the second is absolute to it. Backslashes become forward slashes; a UNC path keeps its leading
//server/share; a path already in the bash form, and anything with no drive letter, is returned
with its separators normalized and nothing else changed. This converts arguments only: the wrapper's
own keeper.log, keeper.hold and supervisor.out keep the Windows spelling the roster carries, which
is what .NET resolves.
#>
function ConvertTo-BashPath {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Path)
    if ($Path.Length -eq 0) { return $Path }
    $text = $Path -replace '\\', '/'
    if ($text -match '^([A-Za-z]):(/.*)?$') {
        $drive = $Matches[1].ToLowerInvariant()
        $rest = $Matches[2]
        return "/$drive$rest"
    }
    return $text
}

<#
.SYNOPSIS
Builds the supervisor's argument list and environment map from one roster entry.

.DESCRIPTION
Follows the roster table: the three positional arguments in the order bin/supervise.sh parses
them (<workdir> <persona> <permission-mode>), then --rundir and --channel-name where the entry
carries them, then the args field verbatim. workdir and rundir go through ConvertTo-BashPath,
because bash is the consumer of these two and a Windows spelling of the rundir reads to it as a
relative path. The args field is passed as written, since the keeper does not know what a flag it
has no row for means. model, effort, controllerTickMs and coordinatorPersona
become the MODEL, EFFORT, controllerTickMs and COORDINATOR_PERSONA environment variables, each
present only where the entry carries the field. A missing required field, or an args element that
is --prompt or starts with --prompt=, is a thrown error naming the roster path, because the roster
launches every persona passive and a prompt is not a thing a boot-time relaunch may carry.

Returns a hashtable: Arguments is a string array; Environment is an ordered hashtable.
#>
function Build-SupervisorInvocation {
    param(
        [Parameter(Mandatory)][object]$Entry,
        [Parameter(Mandatory)][string]$RosterPath
    )
    $name = [string]$Entry.name
    foreach ($required in @('name', 'workdir', 'permissionMode')) {
        $value = $Entry.$required
        if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
            throw "roster '$RosterPath' entry '$name' is missing the required field '$required'"
        }
    }
    $arguments = New-Object System.Collections.Generic.List[string]
    $arguments.Add((ConvertTo-BashPath ([string]$Entry.workdir)))
    $arguments.Add($name)
    $arguments.Add([string]$Entry.permissionMode)
    if (-not [string]::IsNullOrWhiteSpace([string]$Entry.rundir)) {
        $arguments.Add('--rundir'); $arguments.Add((ConvertTo-BashPath ([string]$Entry.rundir)))
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$Entry.channelName)) {
        $arguments.Add('--channel-name'); $arguments.Add([string]$Entry.channelName)
    }
    foreach ($extra in @($Entry.args)) {
        if ($null -eq $extra) { continue }
        $text = [string]$extra
        if ($text -eq '--prompt' -or $text.StartsWith('--prompt=')) {
            throw "roster '$RosterPath' entry '$name' carries --prompt in args, which the keeper refuses: every persona launches passive"
        }
        $arguments.Add($text)
    }

    $environment = [ordered]@{}
    $map = [ordered]@{
        model = 'MODEL'
        effort = 'EFFORT'
        controllerTickMs = 'controllerTickMs'
        coordinatorPersona = 'COORDINATOR_PERSONA'
    }
    foreach ($field in $map.Keys) {
        $value = $Entry.$field
        if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) { continue }
        $environment[$map[$field]] = [string]$value
    }
    return @{ Arguments = $arguments.ToArray(); Environment = $environment }
}

<#
.SYNOPSIS
Reads a KEY=value env file into an ordered hashtable.

.DESCRIPTION
Blank lines and lines whose first non-blank character is # are skipped. The first = is the
separator, so a value may itself contain = or ;. Key and value are both trimmed of surrounding
whitespace, since a space either side of the = is spacing in the file rather than part of a path,
and an untrimmed one reaches CreateProcess as a file name that does not exist. A line with no =, or
with nothing before it, is skipped. A key that appears twice takes the last
value and is named in the Duplicates list, so the caller can record that the earlier value was
overridden. The file is read as UTF-8 (Windows PowerShell 5.1 would otherwise read a BOM-less file
in the ANSI code page) and a read failure throws so the caller records it rather than treating the
file as empty.

A value wrapped in a matching pair of double or single quotes loses that pair and is named in the
Unquoted list. Quoting a path with spaces is how the same value would be written in a shell, and a
quoted value passed through as written reaches CreateProcess with the quotes inside the file name,
which fails as file-not-found. Only a matching outer pair is stripped: a value carrying one quote,
or two that do not match, is kept as written.

Returns a hashtable: Values is an ordered hashtable of key to value; Duplicates and Unquoted are
lists of key names.
#>
function Read-KeeperEnvFile {
    param([Parameter(Mandatory)][string]$Path)
    $result = [ordered]@{}
    $duplicates = New-Object System.Collections.Generic.List[string]
    $unquoted = New-Object System.Collections.Generic.List[string]
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $key = $parts[0].Trim()
        if ($key.Length -eq 0) { continue }
        $value = $parts[1].Trim()
        if ($value.Length -ge 2 -and ($value[0] -eq '"' -or $value[0] -eq "'") -and $value[-1] -eq $value[0]) {
            $value = $value.Substring(1, $value.Length - 2)
            if (-not $unquoted.Contains($key)) { $unquoted.Add($key) }
        }
        if ($result.Contains($key) -and -not $duplicates.Contains($key)) { $duplicates.Add($key) }
        $result[$key] = $value
    }
    return @{ Values = $result; Duplicates = $duplicates; Unquoted = $unquoted }
}
