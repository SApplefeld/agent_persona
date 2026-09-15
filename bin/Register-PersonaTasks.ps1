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
# do, without calling a ScheduledTasks cmdlet that writes, so it runs the elevation check and
# nothing else without elevation.
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
# path resolves against nothing reliable. It defaults to the parent of this script's own directory,
# which is right when the operator runs this script from the root checkout at D:/agent_persona and
# wrong from a worktree, since a task pointed at a worktree breaks when that worktree is removed.
#
# [CmdletBinding()] is what makes an unknown switch a binding error (exit 1) rather than a value
# that lands in $args while the body runs anyway.
[CmdletBinding()]
param(
    [string]$Roster = 'D:/personas/fleet.json',
    [string]$EnvFile = 'D:/personas/keeper.env',
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
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
string is always the same canonical form regardless of how it was typed.
#>
function Resolve-AbsolutePath {
    param([Parameter(Mandatory)][string]$Path)
    $unresolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [IO.Path]::GetFullPath($unresolved)
}

<#
.SYNOPSIS
Reads and validates the roster JSON array, throwing on every shape a task action must not be built
from.

.DESCRIPTION
The file must exist, parse as JSON, and hold a top-level array (checked on the raw text, since
ConvertFrom-Json collapses a single-element array back to a scalar object and a type check on the
parsed result would miss that case). Every entry must carry `name` and `enabled`; a `name` outside
letters, digits, underscore and hyphen is refused here, mirroring valid_persona_name's character
class in bin/agentic-common.sh, since that name reaches a scheduled task's command line as an
unquoted argument and this is the boundary where an unsafe one would break out of it.
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
    if (-not $text.TrimStart().StartsWith('[')) {
        throw "Read-PersonaRoster: roster '$Path' must be a top-level JSON array."
    }
    try {
        $parsed = ConvertFrom-Json -InputObject $text -ErrorAction Stop
    } catch {
        throw "Read-PersonaRoster: roster '$Path' is not valid JSON: $($_.Exception.Message)"
    }
    $entries = @($parsed)
    foreach ($entry in $entries) {
        $propertyNames = @($entry.PSObject.Properties.Name)
        if ($propertyNames -notcontains 'name') {
            throw "Read-PersonaRoster: an entry in roster '$Path' is missing 'name'."
        }
        if ($propertyNames -notcontains 'enabled') {
            throw "Read-PersonaRoster: entry '$($entry.name)' in roster '$Path' is missing 'enabled'."
        }
        if ($entry.name -notmatch '^[A-Za-z0-9_-]+$') {
            throw "Read-PersonaRoster: entry name '$($entry.name)' in roster '$Path' holds a " +
                "character outside letters, digits, underscore and hyphen."
        }
    }
    return $entries
}

<#
.SYNOPSIS
Builds one scheduled-task definition per enabled roster entry, touching no cmdlet that writes.

.DESCRIPTION
New-ScheduledTaskAction, New-ScheduledTaskTrigger, New-ScheduledTaskPrincipal and
New-ScheduledTaskSettingsSet build CIM objects in memory and never touch the Task Scheduler
service, the same way D:/discord-channels/install/Register-BrokerTask.ps1 uses them under -WhatIf,
which is what lets a test call this function and inspect what it built with no elevation and no
side effect. RepoRoot, Roster and EnvFile all land inside the action's quoted argument string, so
each is refused here if it carries a double quote, the same boundary the roster name is refused at
in Read-PersonaRoster: a path or a name that could break out of its quoted argument never reaches
the command line this builds.
#>
function Get-PersonaTaskDefinitions {
    param(
        [Parameter(Mandatory)][array]$Entries,
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$Roster,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$User
    )
    $startScript = Join-Path (Join-Path $RepoRoot 'bin') 'Start-Persona.ps1'
    foreach ($path in @($RepoRoot, $Roster, $EnvFile, $startScript)) {
        if ($path.Contains('"')) {
            throw "Get-PersonaTaskDefinitions: path '$path' carries a double quote and cannot " +
                "sit inside a quoted task argument."
        }
    }

    $definitions = New-Object System.Collections.Generic.List[object]
    foreach ($entry in $Entries) {
        if (-not $entry.enabled) { continue }
        $name = $entry.name
        $argumentString = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " +
            "`"$startScript`" -Name $name -Roster `"$Roster`" -EnvFile `"$EnvFile`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentString
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
first.

The only destructive act here is Unregister-ScheduledTask, taken only when -Prune is present,
-WhatIf is absent, and the task name matches AgentPersona-* with no roster entry: an unrequested
unregister would take a persona's task away with no roster change behind it, so pruning is opt-in
on every run rather than a side effect of a plain registration pass.
#>
function Register-PersonaTasks {
    param(
        [Parameter(Mandatory)][array]$Entries,
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
        $existingTasks = @(Get-ScheduledTask -TaskName 'AgentPersona-*' -ErrorAction SilentlyContinue)
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
            } else {
                if ($existing -contains $taskName) {
                    Set-ScheduledTask -TaskName $taskName -Action $definition.Action `
                        -Trigger $definition.Trigger -Principal $definition.Principal `
                        -Settings $definition.Settings | Out-Null
                    Write-Output "updated $taskName"
                } else {
                    Register-ScheduledTask -TaskName $taskName -Action $definition.Action `
                        -Trigger $definition.Trigger -Principal $definition.Principal `
                        -Settings $definition.Settings | Out-Null
                    Write-Output "registered $taskName"
                }
                if ($Start) {
                    Start-ScheduledTask -TaskName $taskName
                    Write-Output "started $taskName"
                }
            }
        } else {
            if ($existing -contains $taskName) {
                if ($WhatIf) {
                    Write-Output "disable $taskName"
                } else {
                    Disable-ScheduledTask -TaskName $taskName | Out-Null
                    Write-Output "disabled $taskName"
                }
            } else {
                Write-Output "no task for disabled entry $($entry.name)"
            }
        }
    }

    foreach ($taskName in $existing) {
        if (-not ($taskName -like 'AgentPersona-*')) { continue }
        if ($rosterTaskNames -contains $taskName) { continue }
        if ($WhatIf) {
            if ($Prune) {
                Write-Output "orphan $taskName`: would unregister under -Prune"
            } else {
                Write-Output "orphan $taskName`: left in place; pass -Prune to unregister"
            }
        } elseif ($Prune) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false | Out-Null
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
        $repoRootResolved = Resolve-AbsolutePath -Path $RepoRoot
        $rosterResolved = Resolve-AbsolutePath -Path $Roster
        $envFileResolved = Resolve-AbsolutePath -Path $EnvFile

        $entries = Read-PersonaRoster -Path $rosterResolved

        Register-PersonaTasks -Entries $entries -RepoRoot $repoRootResolved -Roster $rosterResolved `
            -EnvFile $envFileResolved -User $User -Prune:$Prune -Start:$Start -WhatIf:$WhatIf
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
