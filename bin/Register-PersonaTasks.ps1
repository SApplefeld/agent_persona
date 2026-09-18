# Registers, updates, disables and reports on one Windows scheduled task per enabled persona in
# the roster.
#
#   .\bin\Register-PersonaTasks.ps1 [-Roster <path>] [-EnvFile <path>] [-RepoRoot <path>]
#       [-User <name>] [-Prune] [-Start] [-WhatIf]
#
# Requires an elevated PowerShell session, the same requirement
# D:/discord-channels/install/Register-BrokerTask.ps1 carries for the same reason: registering a
# scheduled task under the Task Scheduler root fails without it, with an access-denied error that
# does not say why. -WhatIf is the unelevated inspection path: it reads the roster, builds every
# task definition, reads the scheduler for the tasks that already exist, and prints what it would
# do. It skips the elevation throw entirely, because it calls no ScheduledTasks cmdlet that writes,
# so there is nothing for the throw to protect on that path.
#
# Each enabled roster entry becomes one task named AgentPersona-<name>, an existing task of that
# name updated with Set-ScheduledTask rather than unregistered and re-registered, for the same
# reason the broker script gives: unregister-then-register leaves nothing behind if the process is
# interrupted between the two calls, which is worse than the duplicate-name problem removing first
# was meant to solve. A disabled roster entry's existing task is turned off with
# Disable-ScheduledTask; one with no task is reported and nothing is created for it, since a
# disabled entry never needs a task at all. A task named AgentPersona-* with no roster entry is an
# orphan: reported always, unregistered only when -Prune is given, because an unregister is the one
# destructive act this script can take and it runs only on an explicit request.
#
# -RepoRoot pins the absolute path to this checkout into the task's own action, the same reason
# the broker script pins -EnvFile: the task runs outside any interactive logon, where a relative
# path resolves against nothing reliable. Left unbound, it resolves in the script body, after the
# param block runs, to the parent of this script's own directory. That default is right when the
# operator runs this script from the root checkout at D:/agent_persona and wrong from a worktree,
# since a task pointed at a worktree breaks when that worktree is removed.
#
# [CmdletBinding()] is what makes an unknown switch a binding error (exit 1) rather than a value
# that lands in $args while the body runs anyway.
[CmdletBinding()]
param(
    [string]$Roster = 'D:/personas/fleet.json',
    [string]$EnvFile = 'D:/personas/keeper.env',
    [string]$RepoRoot,
    [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [switch]$Prune,
    [switch]$Start,
    [switch]$WhatIf
)

<#
.SYNOPSIS
True when the current process is running elevated.
#>
function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.SYNOPSIS
Resolves a possibly-relative path to an absolute one, against the caller's own location.

.DESCRIPTION
GetUnresolvedProviderPathFromPSPath resolves a relative path against PowerShell's own current
location rather than the .NET process directory, which is what makes a relative -Roster resolve
against where the operator is standing rather than some other root. GetFullPath afterward collapses
any `..` or `.` segments and normalizes the separators, so the path that lands in a task's action
string is always the same canonical form regardless of how it was typed. The trailing separator
GetFullPath leaves on an input like `D:/agent_persona/` is trimmed off, since a task action built
from that path must compose with a further segment the same way whether or not the operator typed
one; a bare drive root (`D:` after trimming) gets its separator put back, because a drive letter
with no trailing separator names the current directory on that drive to .NET, not the root.
#>
function Resolve-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    $unresolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $resolved = [IO.Path]::GetFullPath($unresolved)
    $trimmed = $resolved.TrimEnd('\', '/')
    if ($trimmed -match '^[A-Za-z]:$') { $trimmed += '\' }
    return $trimmed
}

<#
.SYNOPSIS
Reads and validates the roster JSON array, throwing on every shape a task action must not be built
from.

.DESCRIPTION
The file must exist, parse as JSON, and hold a top-level array. That array check reads the raw text
rather than the parsed result, because a top-level JSON object parses to a single PSCustomObject
which `@($parsed)` below then wraps into a one-element array, and that reads downstream as one
valid roster entry and registers a task for it. Every entry must carry `name` and `enabled`; a
`name` outside letters, digits, underscore and hyphen is refused here, the same character class
valid_persona_name in bin/agentic-common.sh accepts. A name starting with a hyphen is refused too,
which valid_persona_name alone would not catch, because that name reaches a task's command line
as an unquoted argument and a leading hyphen would compose as a second flag rather than a value;
valid_persona_name has no such command-line boundary to protect and so places no restriction on the
first character, and a leading underscore is accordingly accepted here exactly as it is there.
\A...\z (rather than ^...$) refuses a name ending in a newline, which ^...$ alone would still pass
under .NET's regex engine. `enabled` must be a JSON boolean, not merely present, because
PowerShell's truthiness reads the string "false" as true; a JSON `null` is reported by name rather
than by its .NET type, since a null value has no type to read here. A `name` repeated across two
entries is refused too, naming the roster path, since the second registration of a repeated name
would otherwise throw mid-pass with some tasks already written and the rest untouched.
#>
function Read-PersonaRoster {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Read-PersonaRoster: roster not found at '$Path'."
    }
    try {
        $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    } catch {
        throw "Read-PersonaRoster: could not read roster '$Path': $($_.Exception.Message)"
    }
    # Get-Content -Raw on a zero-byte file returns $null under Windows PowerShell 5.1 rather than an
    # empty string, so the null-or-whitespace check runs before TrimStart and keeps an empty roster
    # on this same refusal instead of the engine's own null-valued-expression error.
    if ([string]::IsNullOrWhiteSpace($text) -or -not $text.TrimStart().StartsWith('[')) {
        throw "Read-PersonaRoster: roster '$Path' must be a top-level JSON array."
    }
    try {
        $parsed = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    } catch {
        throw "Read-PersonaRoster: roster '$Path' is not valid JSON: $($_.Exception.Message)"
    }
    $entries = @($parsed)
    # OrdinalIgnoreCase: $definitionsByTaskName in Get-PersonaTaskDefinitions keys on TaskName with
    # PowerShell's own case-insensitive hashtable, and Windows Task Scheduler task names are
    # themselves case-insensitive, so two entries differing only in case ("alpha", "Alpha") must be
    # refused here rather than silently collapsing downstream into one task built from whichever
    # entry's definition happened to be written to the hashtable last.
    $seenNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        $propertyNames = @($entry.PSObject.Properties.Name)
        if ($propertyNames -notcontains 'name') {
            throw "Read-PersonaRoster: an entry in roster '$Path' is missing 'name'."
        }
        if ($propertyNames -notcontains 'enabled') {
            throw "Read-PersonaRoster: entry '$($entry.name)' in roster '$Path' is missing 'enabled'."
        }
        if ($entry.name -notmatch '\A[A-Za-z0-9_][A-Za-z0-9_-]*\z') {
            throw "Read-PersonaRoster: entry name '$($entry.name)' in roster '$Path' must start " +
                "with a letter, digit or underscore and hold only letters, digits, underscore and " +
                "hyphen after that."
        }
        if ($null -eq $entry.enabled) {
            throw "Read-PersonaRoster: entry '$($entry.name)' in roster '$Path' field 'enabled' " +
                "must be a JSON boolean, not null."
        }
        if ($entry.enabled -isnot [bool]) {
            throw "Read-PersonaRoster: entry '$($entry.name)' in roster '$Path' field 'enabled' " +
                "must be a JSON boolean, not $($entry.enabled.GetType().Name)."
        }
        if (-not $seenNames.Add([string]$entry.name)) {
            throw "Read-PersonaRoster: roster '$Path' has more than one entry named '$($entry.name)'."
        }
    }
    # The unary comma prevents PowerShell's own pipeline unwrapping from collapsing a 0- or
    # 1-element array back to $null or a scalar on return, which would otherwise fail the caller's
    # Mandatory [array] binding for an empty roster and silently change shape for a one-entry one.
    # AllowEmptyCollection on Get-PersonaTaskDefinitions's and Register-PersonaTasks's own -Entries
    # parameters is the other half of this: a Mandatory array parameter refuses `@()` on its own,
    # comma-protected return value or not.
    return ,$entries
}

<#
.SYNOPSIS
Builds one scheduled-task definition per enabled roster entry, touching no cmdlet that writes.

.DESCRIPTION
New-ScheduledTaskAction, New-ScheduledTaskTrigger, New-ScheduledTaskPrincipal and
New-ScheduledTaskSettingsSet build CIM objects in memory and never touch the Task Scheduler
service, the same way D:/discord-channels/install/Register-BrokerTask.ps1 uses them under -WhatIf,
which is what lets a test call this function and inspect what it built with no elevation and no
side effect. Roster and EnvFile land inside the action's quoted argument string verbatim, and
RepoRoot reaches it as the root of the Start-Persona.ps1 path built from it, so all three are
refused here if they carry a double quote or end in a path separator (a trailing backslash before
the closing quote escapes that quote on the command line, silently merging two arguments into one),
the same boundary every entry's name is refused at, applied here too since this function is itself
dot-sourceable and composes the same command line for a caller that never went through
Read-PersonaRoster. A name repeated across two entries once case is ignored is refused here for the
same reason: $definitionsByTaskName below keys on TaskName with a case-insensitive hashtable, so a
direct caller supplying two case-variant names would otherwise collapse to one entry with no record
of which was dropped, exactly the hazard Read-PersonaRoster's own duplicate check exists to prevent
for a caller that goes through it. `enabled` is re-checked here as a JSON boolean for the third such
reason: PowerShell's truthiness reads the string "false" as true, so a direct caller's entry
carrying that string would pass the `if (-not $entry.enabled)` test below and build a definition for
a persona its own roster field disables. The target script and the env file must both exist: a missing Start-Persona.ps1
means -RepoRoot points at a worktree or a wrong root, and a missing env file means the task would
refuse to start at boot with nothing to say why until then. Neither check is skipped under -WhatIf,
since -WhatIf's purpose is to show what a real run would do and a real run would fail here too. The
action pins powershell.exe's own full path under System32 rather than the bare executable name, so
the task engine resolves the exact binary at every boot instead of searching PATH for it.
#>
function Get-PersonaTaskDefinitions {
    param(
        # AllowEmptyCollection: a Mandatory array parameter refuses `@()` on its own
        # ("Cannot bind argument ... because it is an empty collection"), which would otherwise
        # make an empty roster fail to bind here exactly as it did at Register-PersonaTasks below.
        [Parameter(Mandatory)][AllowEmptyCollection()][array]$Entries,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Roster,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$User
    )
    $startScript = Join-Path (Join-Path $RepoRoot 'bin') 'Start-Persona.ps1'
    # A bare drive root ("D:\" or "D:/") is exempt from the trailing-separator refusal for
    # -RepoRoot and for nothing else. Resolve-AbsolutePath puts that trailing separator back on
    # purpose, since .NET reads a drive letter with none as the current directory on that drive
    # rather than its root, so refusing it would refuse the one spelling Resolve-AbsolutePath
    # itself produces for a bare -RepoRoot; and -RepoRoot never reaches the action string on its
    # own, only as the root of $startScript, which composes a further segment onto it and so lands
    # in the action with no trailing separator. $Roster and $EnvFile are interpolated into the
    # action's quoted arguments verbatim, so a bare drive root on either would put a backslash
    # immediately before a closing quote, escaping it and merging the next argument into the value.
    $pathsToCheck = @(
        @{ Value = $RepoRoot;    BareDriveRootAllowed = $true },
        @{ Value = $Roster;      BareDriveRootAllowed = $false },
        @{ Value = $EnvFile;     BareDriveRootAllowed = $false },
        @{ Value = $startScript; BareDriveRootAllowed = $false }
    )
    foreach ($candidate in $pathsToCheck) {
        $path = [string]$candidate.Value
        if ($path.Contains('"')) {
            throw "Get-PersonaTaskDefinitions: path '$path' carries a double quote and cannot " +
                "sit inside a quoted task argument."
        }
        $isExemptBareDriveRoot = $candidate.BareDriveRootAllowed -and $path -match '^[A-Za-z]:[\\/]$'
        if (($path.EndsWith('\') -or $path.EndsWith('/')) -and -not $isExemptBareDriveRoot) {
            throw "Get-PersonaTaskDefinitions: path '$path' ends in a path separator, which " +
                "would escape the task action's closing quote and merge two arguments into one."
        }
    }
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
        throw "Get-PersonaTaskDefinitions: '$startScript' does not exist; -RepoRoot must name " +
            "the root checkout, since a task pointed at a worktree breaks when that worktree is removed."
    }
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        throw "Get-PersonaTaskDefinitions: env file '$EnvFile' does not exist."
    }

    # Pinned rather than the bare executable name: an unqualified -Execute resolves by PATH search
    # order at every boot, which is one more thing an S4U context with no loaded profile can get
    # wrong. $env:SystemRoot is checked for empty or null before it reaches Join-Path below, which
    # would otherwise raise the engine's own null-or-empty-argument binding error in place of this
    # function's own message. Checked here rather than left to fail silently at boot, so a wrong,
    # empty or missing SystemRoot value fails at registration, where an operator is watching,
    # instead of at the next unattended start.
    if ([string]::IsNullOrEmpty($env:SystemRoot)) {
        throw "Get-PersonaTaskDefinitions: `$env:SystemRoot is empty or unset; it does not " +
            "resolve to a working Windows installation on this session."
    }
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) {
        throw "Get-PersonaTaskDefinitions: '$psExe' does not exist; `$env:SystemRoot " +
            "('$env:SystemRoot') does not resolve to a working Windows installation on this session."
    }

    $definitions = New-Object System.Collections.Generic.List[object]
    $seenNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $Entries) {
        $name = [string]$entry.name
        if ($name -notmatch '\A[A-Za-z0-9_][A-Za-z0-9_-]*\z') {
            throw "Get-PersonaTaskDefinitions: entry name '$name' must start with a letter, " +
                "digit or underscore and hold only letters, digits, underscore and hyphen after that."
        }
        if ($null -eq $entry.enabled) {
            throw "Get-PersonaTaskDefinitions: entry '$name' field 'enabled' must be a JSON " +
                "boolean, not null."
        }
        if ($entry.enabled -isnot [bool]) {
            throw "Get-PersonaTaskDefinitions: entry '$name' field 'enabled' must be a JSON " +
                "boolean, not $($entry.enabled.GetType().Name)."
        }
        if (-not $seenNames.Add($name)) {
            throw "Get-PersonaTaskDefinitions: more than one entry named '$name' once case is ignored."
        }
        if (-not $entry.enabled) { continue }
        $argumentString = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " +
            "`"$startScript`" -Name $name -Roster `"$Roster`" -EnvFile `"$EnvFile`""
        $action = New-ScheduledTaskAction -Execute $psExe -Argument $argumentString
        # AtStartup, not the broker's AtLogOn: the goal is a fleet that needs no logon at all.
        $trigger = New-ScheduledTaskTrigger -AtStartup
        # S4U and RunLevel Limited for the same reasons the broker's own comment gives: no stored
        # password, no interactive desktop, and an elevated task would write files this repo's own
        # tree does not expect an Administrators-owned file inside.
        $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet `
            -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -MultipleInstances IgnoreNew `
            -StartWhenAvailable `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries
        $definitions.Add([pscustomobject]@{
            TaskName  = "AgentPersona-$name"
            Name      = $name
            Action    = $action
            Trigger   = $trigger
            Principal = $principal
            Settings  = $settings
        })
    }
    return $definitions
}

<#
.SYNOPSIS
Prints, under -WhatIf, the block of fields a task definition would register with.

.DESCRIPTION
Every value is read off the built CIM objects rather than off the caller's own literals, so the
printed block is evidence of what New-ScheduledTaskAction, New-ScheduledTaskTrigger,
New-ScheduledTaskPrincipal and New-ScheduledTaskSettingsSet actually built. The settings object's
own property names for the last two lines are DisallowStartIfOnBatteries and
StopIfGoingOnBatteries, inverted from the -AllowStartIfOnBatteries and -DontStopIfGoingOnBatteries
switches that built them, so the print negates them back to the switch names' own sense.
#>
function Write-PersonaTaskDefinition {
    param([Parameter(Mandatory)]$Definition)
    Write-Output "task $($Definition.TaskName)"
    Write-Output "  action: $($Definition.Action.Execute) $($Definition.Action.Arguments)"
    Write-Output "  trigger: $($Definition.Trigger.CimClass.CimClassName)"
    Write-Output "  account: $($Definition.Principal.UserId)"
    Write-Output "  logon: $($Definition.Principal.LogonType)"
    Write-Output "  runlevel: $($Definition.Principal.RunLevel)"
    Write-Output "  restartCount: $($Definition.Settings.RestartCount)"
    Write-Output "  restartInterval: $($Definition.Settings.RestartInterval)"
    Write-Output "  executionTimeLimit: $($Definition.Settings.ExecutionTimeLimit)"
    Write-Output "  multipleInstances: $($Definition.Settings.MultipleInstances)"
    Write-Output "  startWhenAvailable: $($Definition.Settings.StartWhenAvailable)"
    Write-Output "  allowStartIfOnBatteries: $(-not $Definition.Settings.DisallowStartIfOnBatteries)"
    Write-Output "  dontStopIfGoingOnBatteries: $(-not $Definition.Settings.StopIfGoingOnBatteries)"
}

<#
.SYNOPSIS
Builds every enabled entry's task definition, then registers, updates, disables, reports on and
(only under -Prune) removes tasks to match the roster.

.DESCRIPTION
$IsElevated and $ExistingTaskNames exist so a test can drive the elevation guard and the disabled,
absent and orphan branches with no scheduler read and no ScheduledTasks cmdlet that writes, the
same reason the broker script's Register-BrokerScheduledTask takes $IsElevated as a parameter.
$WhatIf skips the elevation throw and prints each definition and each planned action instead of
registering, disabling or unregistering anything; it is the unelevated inspection path. Without
-WhatIf the elevation check runs before any ScheduledTasks cmdlet, including the read that lists
existing AgentPersona-* tasks, since even that read is skipped when the elevation throw fires
first. Every scheduler read and write below carries -TaskPath '\' explicitly: Get-ScheduledTask
with no -TaskPath searches every folder in the Task Scheduler library, not just the root, so a
same-named task filed under a different folder would otherwise send this function down the wrong
branch (update instead of register, or a prune that targets a root-level task that was never
there) and a write with no -TaskPath lands at the root by default, which is right for every task
this script creates but is worth pinning rather than relying on the default staying that way.

The only destructive act here is Unregister-ScheduledTask, taken only when -Prune is present,
-WhatIf is absent, and the task name matches AgentPersona-* with no roster entry: an unrequested
unregister would take a persona's task away with no roster change behind it, so pruning is opt-in
on every run rather than a side effect of a plain registration pass. The orphan count is printed
before any of them are removed, and each removal is named as it happens, so a run that is
interrupted partway still leaves a record of what it meant to do and what it reached.
#>
function Register-PersonaTasks {
    param(
        # AllowEmptyCollection: see the same attribute on Get-PersonaTaskDefinitions's -Entries;
        # this is the parameter an empty roster with -Prune actually binds against first.
        [Parameter(Mandatory)][AllowEmptyCollection()][array]$Entries,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Roster,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$User,
        [switch]$Prune,
        [switch]$Start,
        [switch]$WhatIf,
        [bool]$IsElevated = (Test-IsElevated),
        [string[]]$ExistingTaskNames
    )

    if (-not $WhatIf -and -not $IsElevated) {
        throw "Register-PersonaTasks: this must run from an elevated PowerShell session " +
            "(right-click PowerShell, 'Run as Administrator'). Registering a scheduled task under " +
            "the Task Scheduler root fails without it, with an access-denied error that does not " +
            "say why."
    }

    $definitions = Get-PersonaTaskDefinitions -Entries $Entries -RepoRoot $RepoRoot -Roster $Roster `
        -EnvFile $EnvFile -User $User
    $definitionsByTaskName = @{}
    foreach ($definition in $definitions) { $definitionsByTaskName[$definition.TaskName] = $definition }

    if ($null -eq $ExistingTaskNames) {
        # A wildcard that matches no task is an error from Get-ScheduledTask whose id starts
        # CmdletizationQuery_NotFound, and that one error reads as an empty list. Every other read
        # failure refuses the run here, before any write: a run that read "no tasks" from a failed
        # query would call Register-ScheduledTask on a name that already exists and throw partway
        # through the roster.
        try {
            $existingTasks = @(Get-ScheduledTask -TaskName 'AgentPersona-*' -TaskPath '\' -ErrorAction Stop)
        } catch {
            if ($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*') {
                throw "Register-PersonaTasks: could not read the existing AgentPersona-* tasks from " +
                    "the Task Scheduler, so nothing was registered, updated, disabled or removed: " +
                    "$($_.Exception.Message)"
            }
            $existingTasks = @()
        }
        $existing = @($existingTasks | ForEach-Object { $_.TaskName })
    } else {
        $existing = @($ExistingTaskNames)
    }

    $rosterTaskNames = @($Entries | ForEach-Object { "AgentPersona-$($_.name)" })

    foreach ($entry in $Entries) {
        $taskName = "AgentPersona-$($entry.name)"
        if ($entry.enabled) {
            $definition = $definitionsByTaskName[$taskName]
            if ($WhatIf) {
                Write-PersonaTaskDefinition -Definition $definition
                # The same $existing test the real branch below takes, so a dry run tells the
                # operator whether the task would be created or updated in place rather than
                # naming only the entry.
                if ($existing -contains $taskName) {
                    Write-Output "would update $taskName"
                } else {
                    Write-Output "would register $taskName"
                }
                if ($Start) { Write-Output "would start $taskName" }
            } else {
                if ($existing -contains $taskName) {
                    Set-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $definition.Action `
                        -Trigger $definition.Trigger -Principal $definition.Principal `
                        -Settings $definition.Settings | Out-Null
                    Write-Output "updated $taskName"
                } else {
                    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $definition.Action `
                        -Trigger $definition.Trigger -Principal $definition.Principal `
                        -Settings $definition.Settings | Out-Null
                    Write-Output "registered $taskName"
                }
                # Enable-ScheduledTask costs nothing on a task that is already enabled, and it
                # exists for the entry that comes back to enabled=true after an earlier run
                # disabled its task: whether Set-ScheduledTask on its own would have re-enabled
                # that task is not something this comment claims either way, so the enable is
                # explicit rather than assumed.
                Enable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
                if ($Start) {
                    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
                    Write-Output "started $taskName"
                }
            }
        } else {
            if ($existing -contains $taskName) {
                if ($WhatIf) {
                    Write-Output "would disable $taskName"
                } else {
                    Disable-ScheduledTask -TaskName $taskName -TaskPath '\' | Out-Null
                    Write-Output "disabled $taskName"
                }
            } else {
                Write-Output "no task for disabled entry $($entry.name)"
            }
        }
    }

    $orphans = @($existing | Where-Object { $_ -like 'AgentPersona-*' -and ($rosterTaskNames -notcontains $_) })
    if ($Prune -and -not $WhatIf -and $orphans.Count -gt 0) {
        Write-Output "pruning $($orphans.Count) orphan task(s): $($orphans -join ', ')"
    }
    foreach ($taskName in $orphans) {
        if ($WhatIf) {
            if ($Prune) {
                Write-Output "orphan $taskName`: would unregister under -Prune"
            } else {
                Write-Output "orphan $taskName`: left in place; pass -Prune to unregister"
            }
        } elseif ($Prune) {
            Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false | Out-Null
            Write-Output "unregistered $taskName"
        } else {
            Write-Output "orphan $taskName`: left in place; pass -Prune to unregister"
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # Stop turns a thrown .NET exception (GetFullPath on an illegal path, among others) into a
    # terminating error in this scope, same as every `throw` above; without it a .NET method's own
    # exception is merely reported and the script would fall through to the next line instead of
    # stopping, which is how an illegal path would otherwise slip past its own refusal.
    $ErrorActionPreference = 'Stop'
    try {
        if ([string]::IsNullOrEmpty($RepoRoot)) {
            $RepoRoot = Split-Path -Parent $PSScriptRoot
        }
        # Resolve-AbsolutePath's GetUnresolvedProviderPathFromPSPath throws its own generic message
        # for a drive that does not exist ("Cannot find drive. A drive with the name 'Z' does not
        # exist."), naming neither the parameter nor the value that carried it. Each call is wrapped
        # so the operator sees which of -RepoRoot, -Roster or -EnvFile named the bad path.
        try {
            $repoRootResolved = Resolve-AbsolutePath -Path $RepoRoot
        } catch {
            throw "Register-PersonaTasks: -RepoRoot '$RepoRoot' could not be resolved: $($_.Exception.Message)"
        }
        try {
            $rosterResolved = Resolve-AbsolutePath -Path $Roster
        } catch {
            throw "Register-PersonaTasks: -Roster '$Roster' could not be resolved: $($_.Exception.Message)"
        }
        try {
            $envFileResolved = Resolve-AbsolutePath -Path $EnvFile
        } catch {
            throw "Register-PersonaTasks: -EnvFile '$EnvFile' could not be resolved: $($_.Exception.Message)"
        }

        $entries = Read-PersonaRoster -Path $rosterResolved

        Register-PersonaTasks -Entries $entries -RepoRoot $repoRootResolved -Roster $rosterResolved `
            -EnvFile $envFileResolved -User $User -Prune:$Prune -Start:$Start -WhatIf:$WhatIf
    } catch {
        # Console.Error.WriteLine, not Write-Error: Write-Error under $ErrorActionPreference =
        # 'Stop' raises a terminating error of its own, which skips the exit 1 below entirely (the
        # process still exits 1, but only via the unhandled-error path, and the message the host
        # prints is wrapped at console width even when the output is redirected, which breaks a
        # long path across lines). Console.Error.WriteLine writes the message once, unwrapped, to
        # stderr, and returns control so exit 1 actually runs. The message is written as thrown,
        # with no added prefix: every throw above already names the function that raised it, so an
        # outer prefix here would double it for a throw already spelled "Register-PersonaTasks: ...".
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
