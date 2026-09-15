# Measures what a process keeper task inherits on this box. Run by hand from a PowerShell session,
# or as the action of a scratch scheduled task, under Windows PowerShell 5.1:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File bin\keeper-probe.ps1 -OutFile <path> [-EnvFile <path>]
#
# The out file is plain text, one key=value per line, so a reader can grep it. It records the
# running user, the session id, the elevation state, the environment as the process received it,
# then applies the keeper env file by the keeper's allowlist rule and records whether bash, node and
# claude resolve and report a version through that bash.
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

# Every environment variable the keeper is willing to take from the env file. Named explicitly so
# that no key outside this list reaches the process that launches the supervisor. The list narrows
# what is exported and is not the security boundary: KEEPER_BASH_EXE names the executable that
# runs and KEEPER_PATH_PREPEND decides where node and claude resolve, so whoever can write the file
# controls what runs as the persona at every boot. The file's ACL is what guards that, so the probe
# records the file's owner and every principal holding a write grant on it, and the reading that
# shows whether the guard holds is env.file.foreign_writers: the writers and the owner outside the
# exempt set the keeper refuses on (see Get-ForeignWriters). KEEPER_BASH_EXE is not exported;
# KEEPER_PATH_PREPEND is prepended to the process PATH rather than set as a variable of its own.
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

# $Value is typed [object], not [string]: binding $null to a [string] parameter coerces it to '',
# which would make an undelivered variable read the same as one delivered empty, the distinction
# the delivered.* lines exist to show.
function Add-ProbeLine {
    param([Parameter(Mandatory)][string]$Key, [AllowNull()][object]$Value)
    if ($null -eq $Value) { $text = '<unset>' } else { $text = [string]$Value }
    $script:Lines.Add("$Key=$text")
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
Names every principal holding a write grant on a file, from its DACL.

.DESCRIPTION
A grant counts as write when it carries any right that changes the file's content or lets the
holder make itself a writer: WriteData, AppendData, WriteAttributes, WriteExtendedAttributes,
Delete, ChangePermissions or TakeOwnership, or a composite that includes one (Modify, FullControl).
An ACE can also carry the generic access bits (GENERIC_WRITE 0x40000000, GENERIC_ALL 0x10000000,
MAXIMUM_ALLOWED 0x02000000), which the FileSystemRights enum does not name and a specific-rights
mask would miss, so those count as write too. Inherited and explicit grants count alike, because
the file is written under either. Deny entries are not subtracted: the reading names who is
granted, and a deny that happens to cancel a grant is for the reader to weigh.
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
#>
function Get-ForeignWriters {
    param([Parameter(Mandatory)][string]$Path)
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

<#
.SYNOPSIS
Applies the allowlisted keys of an env file to this process and records what happened.

.DESCRIPTION
Returns the value of KEEPER_BASH_EXE when the file carries one, else $null. Every key outside the
allowlist is recorded on an env.ignored line and not applied. An allowlisted key with an empty value
is recorded on an env.empty line and not applied, because Set-Item on env: with an empty value
removes the variable under Windows PowerShell 5.1 rather than setting it empty, and a probe that
recorded that as applied would be lying. A missing file records env.file=missing and leaves the
process environment as delivered.
#>
function Set-KeeperEnvironment {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-ProbeLine 'env.file' 'missing'
        return $null
    }
    Add-ProbeLine 'env.file' $Path
    # One try per reading, so a failure on one still leaves the others recorded.
    try { Add-ProbeLine 'env.file.owner' ([string](Get-Acl -LiteralPath $Path -ErrorAction Stop).Owner) }
    catch { Add-ProbeLine 'env.file.owner.error' $_.Exception.Message }
    try { Add-ProbeLine 'env.file.writers' (Get-FileWriters -Path $Path) }
    catch { Add-ProbeLine 'env.file.writers.error' $_.Exception.Message }
    try { Add-ProbeLine 'env.file.foreign_writers' (Get-ForeignWriters -Path $Path) }
    catch { Add-ProbeLine 'env.file.foreign_writers.error' $_.Exception.Message }
    try { Add-ProbeLine 'env.dir.writers' (Get-FileWriters -Path (Split-Path -Parent $Path)) }
    catch { Add-ProbeLine 'env.dir.writers.error' $_.Exception.Message }

    try {
        $read = Read-KeeperEnvFile -Path $Path
    } catch {
        Add-ProbeLine 'env.read.error' $_.Exception.Message
        return $null
    }
    $values = $read.Values
    foreach ($dup in $read.Duplicates) { Add-ProbeLine 'env.duplicate' $dup }
    $bashExe = $null
    foreach ($key in $values.Keys) {
        if ($script:KeeperEnvAllowlist -notcontains $key) {
            Add-ProbeLine 'env.ignored' $key
            continue
        }
        $value = [string]$values[$key]
        if ([string]::IsNullOrWhiteSpace($value)) {
            Add-ProbeLine 'env.empty' $key
            continue
        }
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
                try {
                    Set-Item -Path "env:$key" -Value $value -ErrorAction Stop
                    Add-ProbeLine "env.applied.$key" $value
                } catch {
                    Add-ProbeLine "env.failed.$key" $_.Exception.Message
                }
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
        # Under a task with no user PATH, the first bash.exe on the system PATH can be WSL's launcher
        # in System32 rather than Git's, on a box that has WSL. bash.resolved records which one won.
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
    # -c, not -lc: the keeper launches the supervisor as a plain `bash supervise.sh`, so its children
    # resolve on the PATH the process delivered, converted by bash, with no login profile rewriting
    # it first. Probing through a login shell would measure a PATH the supervisor never sees.
    Invoke-ProbeCommand -Label 'node' -Exe $bash -Arguments @('-c', 'node --version')
    Invoke-ProbeCommand -Label 'claude' -Exe $bash -Arguments @('-c', 'claude --version')
}

<#
.SYNOPSIS
Writes the recorded lines to the out file as UTF-8 without a byte-order mark, creating its directory.
#>
function Write-ProbeFile {
    param([Parameter(Mandatory)][string]$Path)
    # Resolved once against PowerShell's own current location, then used for both the directory and
    # the file. [IO.Path]::GetFullPath would resolve against the .NET process directory, which differs
    # from $PWD after a Set-Location, so a relative path could create the directory in one place and
    # write the file in another.
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $directory = Split-Path -Parent $full
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -LiteralPath $directory -Force -ErrorAction Stop | Out-Null
    }
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
