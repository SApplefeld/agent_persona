# Measures what a process keeper task inherits on this box. Run by hand from a PowerShell session,
# or as the action of a scratch scheduled task, under Windows PowerShell 5.1:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File bin\keeper-probe.ps1 -OutFile <path> [-EnvFile <path>]
#
# The out file is plain text, one key=value per line, so a reader can grep it. It records the
# running user, the session id, the elevation state, the environment as the process received it,
# then applies the keeper env file by the same allowlist rule bin/Start-Persona.ps1 uses and records
# whether bash, node and claude resolve and report a version through that bash.
#
# The probe is a recorder, never a gate. Everything it can record it records instead of throwing,
# and it exits 0 whenever the out file was written so the scheduler's last-result column stays
# readable. Failing to write the out file is the only exit 1.
#
# [CmdletBinding()] is what makes an unknown switch a binding error (exit 1) rather than a value
# that lands in $args while the body runs anyway.
[CmdletBinding()]
param(
    # Required. Checked in the body rather than marked Mandatory, because a Mandatory parameter
    # left off the command line opens an interactive prompt, and under a scheduled task there is
    # no console to answer it, so the run would hang rather than fail.
    [string]$OutFile,
    [string]$EnvFile = 'D:/personas/keeper.env'
)

# Every environment variable this probe, and bin/Start-Persona.ps1, is willing to take from the env
# file. Named explicitly rather than applying whatever key the file holds: write access to the file
# would otherwise be arbitrary environment injection into the process that launches the supervisor.
# KEEPER_BASH_EXE names the bash to run and is not exported; KEEPER_PATH_PREPEND is prepended to
# the process PATH rather than set as a variable of its own.
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

# The six delivered variables the Approach names, plus TMP, which is on the allowlist and so is
# also a value the task may or may not deliver.
$script:DeliveredKeys = @('USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PATH')

# The lines the out file will carry, in the order they were recorded.
$script:Lines = New-Object System.Collections.Generic.List[string]

function Add-ProbeLine {
    param([Parameter(Mandatory)][string]$Key, [AllowNull()][AllowEmptyString()][string]$Value)
    if ($null -eq $Value) { $Value = '<unset>' }
    $script:Lines.Add("$Key=$Value")
}

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
Reads a KEY=value env file into an ordered hashtable.

.DESCRIPTION
Blank lines and lines whose first non-blank character is # are skipped. The first = is the
separator, so a value may itself contain = or ;. The key is trimmed of surrounding whitespace; the
value is kept as written. A line with no = is skipped.
#>
function Read-KeeperEnvFile {
    param([Parameter(Mandatory)][string]$Path)
    $result = [ordered]@{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $result[$parts[0].Trim()] = $parts[1]
    }
    return $result
}

<#
.SYNOPSIS
Applies the allowlisted keys of an env file to this process and records what happened.

.DESCRIPTION
Returns the value of KEEPER_BASH_EXE when the file carries one, else $null. Every key outside the
allowlist is recorded on an env.ignored line and not applied. A missing file records
env.file=missing and leaves the process environment as delivered.
#>
function Set-KeeperEnvironment {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-ProbeLine 'env.file' 'missing'
        return $null
    }
    Add-ProbeLine 'env.file' $Path

    $values = Read-KeeperEnvFile -Path $Path
    $bashExe = $null
    foreach ($key in $values.Keys) {
        if ($script:KeeperEnvAllowlist -notcontains $key) {
            Add-ProbeLine 'env.ignored' $key
            continue
        }
        $value = [string]$values[$key]
        switch ($key) {
            'KEEPER_BASH_EXE' {
                $bashExe = $value
                Add-ProbeLine 'env.bash_exe' $value
            }
            'KEEPER_PATH_PREPEND' {
                $delivered = [Environment]::GetEnvironmentVariable('PATH', 'Process')
                if ([string]::IsNullOrEmpty($delivered)) {
                    $env:PATH = $value
                } else {
                    $env:PATH = $value + ';' + $delivered
                }
                Add-ProbeLine 'env.path_prepend' $value
            }
            default {
                Set-Item -Path "env:$key" -Value $value
                Add-ProbeLine "env.applied.$key" $value
            }
        }
    }
    return $bashExe
}

<#
.SYNOPSIS
Runs one native command and records its exit code and first output line under a label.

.DESCRIPTION
The whole output is captured to a variable and $LASTEXITCODE is read before the first line is
taken, never through a live pipeline into Select-Object. Stderr is merged into the capture so a
version banner printed there is still the recorded line. A failure to start the process is
recorded as the exit value rather than thrown.
#>
function Invoke-ProbeCommand {
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )
    $previous = $ErrorActionPreference
    # A native command's stderr arrives as ErrorRecord objects under 2>&1, and under Stop the first
    # one would terminate the call before its exit code is read.
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $Exe @Arguments 2>&1)
        $code = $LASTEXITCODE
    } catch {
        Add-ProbeLine "$Label.exit" "cannot run: $($_.Exception.Message)"
        Add-ProbeLine "$Label.line" ''
        return
    } finally {
        $ErrorActionPreference = $previous
    }
    $first = ''
    foreach ($item in $output) {
        $text = ([string]$item).Trim()
        if ($text.Length -gt 0) { $first = $text; break }
    }
    Add-ProbeLine "$Label.exit" ([string]$code)
    Add-ProbeLine "$Label.line" $first
}

<#
.SYNOPSIS
Records the version probes for bash, node and claude through the given bash, or their absence.
#>
function Invoke-ToolchainProbes {
    param([AllowNull()][string]$BashExe)

    $bash = $null
    if (-not [string]::IsNullOrWhiteSpace($BashExe)) {
        Add-ProbeLine 'bash.source' 'env'
        if (Test-Path -LiteralPath $BashExe -PathType Leaf) {
            $bash = $BashExe
        } else {
            Add-ProbeLine 'bash.env_missing' $BashExe
        }
    } else {
        Add-ProbeLine 'bash.source' 'path'
        $found = Get-Command 'bash.exe' -CommandType Application -ErrorAction SilentlyContinue
        if ($found) { $bash = @($found)[0].Source }
    }

    if ($null -eq $bash) {
        Add-ProbeLine 'bash.resolved' 'none'
        foreach ($label in @('bash', 'node', 'claude')) {
            Add-ProbeLine "$label.exit" 'cannot run: no bash'
            Add-ProbeLine "$label.line" ''
        }
        return
    }

    Add-ProbeLine 'bash.resolved' $bash
    Invoke-ProbeCommand -Label 'bash' -Exe $bash -Arguments @('--version')
    # -lc so PATH resolution happens inside bash, the way the supervisor's own children resolve.
    Invoke-ProbeCommand -Label 'node' -Exe $bash -Arguments @('-lc', 'node --version')
    Invoke-ProbeCommand -Label 'claude' -Exe $bash -Arguments @('-lc', 'claude --version')
}

<#
.SYNOPSIS
Writes the recorded lines to the out file as UTF-8 without a byte-order mark, creating its directory.
#>
function Write-ProbeFile {
    param([Parameter(Mandatory)][string]$Path)
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
    }
    $full = [System.IO.Path]::GetFullPath($Path)
    [System.IO.File]::WriteAllLines($full, $script:Lines, [System.Text.UTF8Encoding]::new($false))
}

if ([string]::IsNullOrWhiteSpace($OutFile)) {
    Write-Error 'keeper-probe: -OutFile is required.'
    exit 1
}

try {
    Add-ProbeLine 'probe.time' ([DateTime]::UtcNow.ToString('o'))
    Add-ProbeLine 'probe.script' $PSCommandPath
    Add-ProbeLine 'probe.powershell' $PSVersionTable.PSVersion.ToString()
    Add-ProbeLine 'user' ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    Add-ProbeLine 'session.id' ([string](Get-Process -Id $PID).SessionId)
    Add-ProbeLine 'elevated' ((Test-IsElevated).ToString().ToLowerInvariant())
    foreach ($key in $script:DeliveredKeys) {
        Add-ProbeLine "delivered.$key" ([Environment]::GetEnvironmentVariable($key, 'Process'))
    }

    $bashExe = Set-KeeperEnvironment -Path $EnvFile
    Add-ProbeLine 'applied.PATH' ([Environment]::GetEnvironmentVariable('PATH', 'Process'))

    Invoke-ToolchainProbes -BashExe $bashExe
} catch {
    # Nothing above is meant to throw; if something does, the out file still says so.
    Add-ProbeLine 'probe.error' $_.Exception.Message
}

try {
    Write-ProbeFile -Path $OutFile
} catch {
    Write-Error "keeper-probe: could not write '$OutFile': $($_.Exception.Message)"
    exit 1
}
exit 0
