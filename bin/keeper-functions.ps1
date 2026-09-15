# Pure functions shared by the process keeper's scripts. Dot-sourced by bin/Start-Persona.ps1 (the
# wrapper the scheduled task runs) and bin/keeper-probe.ps1 (the recorder that measures what a
# task delivers), so the allowlist, the env file reader, the file-writers predicate, the roster
# reader, the supervisor invocation builder and the exit-code policy each exist once.
#
#   . (Join-Path $PSScriptRoot 'keeper-functions.ps1')
#
# Nothing here writes a file, sets an environment variable or launches a process. A function that
# cannot produce its answer throws, and the error names the path it was reading, so the caller
# logs it and decides what to do. Both callers run under Windows PowerShell 5.1.

# Every environment variable the keeper is willing to take from the env file. Named explicitly so
# that no key outside this list reaches the process that launches the supervisor. The list narrows
# what is exported and is not the security boundary: KEEPER_BASH_EXE names the executable that
# runs and KEEPER_PATH_PREPEND decides where node and claude resolve, so whoever can write the file
# controls what runs as the persona at every boot. The file's ACL is what guards that: the wrapper
# refuses the file when Get-ForeignWriters names anyone, and the probe records the same reading.
# KEEPER_BASH_EXE is not exported; KEEPER_PATH_PREPEND is prepended to the process PATH rather than
# set as a variable of its own.
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
entry carries, or an entry whose enabled field is not true is a thrown error naming the roster
path and the name, so a wrapper started for a persona the roster does not run stops with a message
rather than launching something.
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
    if ($match.enabled -ne $true) {
        throw "roster '$Path' entry '$Name' is not enabled"
    }
    return $match
}

<#
.SYNOPSIS
Builds the supervisor's argument list and environment map from one roster entry.

.DESCRIPTION
Follows the roster table: the three positional arguments in the order bin/supervise.sh parses
them (<workdir> <persona> <permission-mode>), then --rundir and --channel-name where the entry
carries them, then the args field verbatim. model, effort, controllerTickMs and coordinatorPersona
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
    $arguments.Add([string]$Entry.workdir)
    $arguments.Add($name)
    $arguments.Add([string]$Entry.permissionMode)
    if (-not [string]::IsNullOrWhiteSpace([string]$Entry.rundir)) {
        $arguments.Add('--rundir'); $arguments.Add([string]$Entry.rundir)
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
separator, so a value may itself contain = or ;. The key is trimmed of surrounding whitespace; the
value is kept as written. A line with no =, or with nothing before it, is skipped. A key that
appears twice takes the last value and is named in the Duplicates list, so the caller can record
that the earlier value was overridden. The file is read as UTF-8 (Windows PowerShell 5.1 would
otherwise read a BOM-less file in the ANSI code page) and a read failure throws so the caller
records it rather than treating the file as empty.
#>
function Read-KeeperEnvFile {
    param([Parameter(Mandatory)][string]$Path)
    $result = [ordered]@{}
    $duplicates = New-Object System.Collections.Generic.List[string]
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $key = $parts[0].Trim()
        if ($key.Length -eq 0) { continue }
        if ($result.Contains($key) -and -not $duplicates.Contains($key)) { $duplicates.Add($key) }
        $result[$key] = $parts[1]
    }
    return @{ Values = $result; Duplicates = $duplicates }
}

<#
.SYNOPSIS
Names every principal holding a write grant on a file or directory, from its DACL.

.DESCRIPTION
A grant counts as write when it carries any right that changes the file's content or lets the
holder make itself a writer: WriteData, AppendData, WriteAttributes, WriteExtendedAttributes,
Delete, ChangePermissions or TakeOwnership, or a composite that includes one (Modify, FullControl).
On a directory, DeleteSubdirectoriesAndFiles counts too, since it lets the holder remove a file
beneath the directory without holding Delete on the file itself. An ACE can also carry the generic
access bits (GENERIC_WRITE 0x40000000, GENERIC_ALL 0x10000000, MAXIMUM_ALLOWED 0x02000000), which
the FileSystemRights enum does not name and a specific-rights mask would miss, so those count as
write too. Inherited and explicit grants count alike, because the file is written under either.
Deny entries are not subtracted: the reading names who is granted, and a deny that happens to
cancel a grant is for the reader to weigh.
#>
function Get-FileWriters {
    param([Parameter(Mandatory)][string]$Path)
    $writeMask = [int]([System.Security.AccessControl.FileSystemRights]::WriteData -bor
        [System.Security.AccessControl.FileSystemRights]::AppendData -bor
        [System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership)
    $genericMask = 0x40000000 -bor 0x10000000 -bor 0x02000000
    $isContainer = Test-Path -LiteralPath $Path -PathType Container
    if ($isContainer) {
        $writeMask = $writeMask -bor [int][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    }
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $writers = New-Object System.Collections.Generic.List[string]
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
        # On a directory an InheritOnly rule grants nothing on the directory itself, only on what is
        # created beneath it, so it is not a writer of the directory.
        if ($isContainer -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
        $rights = [int]$rule.FileSystemRights
        if (($rights -band $writeMask) -eq 0 -and ($rights -band $genericMask) -eq 0) { continue }
        $name = [string]$rule.IdentityReference
        if (-not $writers.Contains($name)) { $writers.Add($name) }
    }
    return ($writers -join ';')
}

<#
.SYNOPSIS
Names the principals that can write a file and are not the process's own account, Administrators or SYSTEM.

.DESCRIPTION
This is the predicate the keeper wrapper refuses on. Two sources count: every DACL writer, and the
file's owner, who holds WRITE_DAC and READ_CONTROL implicitly with no ACE at all and so can grant
itself write in one call. Without the owner leg, a principal that created the file while it was
absent and wrote a clean-looking DACL would pass. The exempt set is fixed rather than "the owner"
for that same reason, and it is compared by SID (Administrators S-1-5-32-544, SYSTEM S-1-5-18, the
current user's own SID) rather than by display name, so a localized or untranslatable name cannot
make the file read as foreign. The file check alone is a partial guard: a principal with write on
the file's directory can create or replace the file, so the caller records the directory's writers
beside this reading. The return is the foreign principals joined by ';', an owner outside the set
spelled owner:<name>.

-OwnerSid substitutes the given SID for the owner the ACL reports. It exists for the unit test,
which runs unelevated and so cannot make a file owned by another principal; the wrapper and the
probe never pass it.
#>
function Get-ForeignWriters {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$OwnerSid
    )
    $exempt = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        'S-1-5-32-544',
        'S-1-5-18'
    )
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $foreign = New-Object System.Collections.Generic.List[string]
    foreach ($name in ((Get-FileWriters -Path $Path) -split ';')) {
        if ($name.Length -eq 0) { continue }
        if ($exempt -contains (ConvertTo-Sid $name)) { continue }
        $foreign.Add($name)
    }
    $owner = [string]$acl.Owner
    if (-not [string]::IsNullOrEmpty($OwnerSid)) { $owner = $OwnerSid }
    if ($owner.Length -gt 0 -and $exempt -notcontains (ConvertTo-Sid $owner)) {
        $foreign.Add("owner:$owner")
    }
    return ($foreign -join ';')
}

<#
.SYNOPSIS
Translates an account name to its SID string, or returns the input when it is already a SID or cannot translate.
#>
function ConvertTo-Sid {
    param([Parameter(Mandatory)][string]$Account)
    if ($Account -match '^S-1-') { return $Account }
    try {
        $nt = [System.Security.Principal.NTAccount]::new($Account)
        return $nt.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $Account
    }
}
