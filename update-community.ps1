[CmdletBinding()]
param(
    [string]$GitExe = "",
    [string]$NpmExe = "",
    [string]$ReceiverTaskName = "Hasunosora Community Receiver",
    [ValidateRange(1, 65535)]
    [int]$HealthPort = 8790,
    [ValidateRange(1, 65535)]
    [int]$AdminPort = 8766
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$ProjectDir = [IO.Path]::GetFullPath($PSScriptRoot)
$ServerFile = [IO.Path]::GetFullPath((Join-Path $ProjectDir "community-server.mjs"))
$StateDirectory = Join-Path $ProjectDir "private\community-update"
$StateFile = Join-Path $StateDirectory "deployed-commit.txt"
$DependencyStateFile = Join-Path $StateDirectory "dependency-hash.txt"
$DependencyLockFile = Join-Path $StateDirectory "dependencies.lock"
$DependencyPendingFile = Join-Path $StateDirectory "dependencies-pending.txt"
$LogFile = Join-Path $StateDirectory "update.log"
$LockFile = Join-Path $StateDirectory "update.lock"
$HealthUrl = "http://127.0.0.1:${HealthPort}/health"
$ExpectedOrigin = "https://github.com/Yukachiii/hasunosora-pilgrimage.git"
$LockStream = $null
$DependencyLockStream = $null

New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
if ((Test-Path -LiteralPath $LogFile) -and
    (Get-Item -LiteralPath $LogFile).Length -gt 1MB) {
    Move-Item -LiteralPath $LogFile -Destination "${LogFile}.1" -Force
}

function Write-UpdateLog([string]$Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Resolve-Tool([string]$ConfiguredPath, [string]$CommandName) {
    if ($ConfiguredPath) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
            throw "Configured tool was not found: $ConfiguredPath"
        }
        return (Get-Item -LiteralPath $ConfiguredPath).FullName
    }

    $command = Get-Command $CommandName -ErrorAction Stop
    return $command.Source
}

function Invoke-RepoGit {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $script:ResolvedGitExe `
            -c "safe.directory=$script:ProjectDir" `
            -c "core.hooksPath=NUL" `
            -C $script:ProjectDir `
            @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if (($exitCode -ne 0) -and (-not $AllowFailure)) {
        throw "git $($Arguments -join ' ') failed (${exitCode}): $($output -join ' ')"
    }
    return @{
        ExitCode = $exitCode
        Output = $output
    }
}

function Get-Commit([string]$Revision) {
    $result = Invoke-RepoGit -Arguments @("rev-parse", $Revision)
    return ([string]$result.Output[0]).Trim()
}

function Remove-FirstVersionFields([string]$Content, [int]$Count) {
    $matches = [Text.RegularExpressions.Regex]::Matches(
        $Content,
        '(?m)^(\s*"version"\s*:\s*)"[^"]+"'
    )
    if ($matches.Count -lt $Count) {
        throw "A dependency manifest has an unexpected format."
    }

    for ($index = $Count - 1; $index -ge 0; $index -= 1) {
        $match = $matches[$index]
        $replacement = $match.Groups[1].Value + '""'
        $Content = $Content.Remove($match.Index, $match.Length).Insert(
            $match.Index,
            $replacement
        )
    }
    return $Content
}

function Get-DependencyHash([string]$Revision = "") {
    if ($Revision) {
        $packageResult = Invoke-RepoGit -Arguments @("show", "${Revision}:package.json")
        $lockResult = Invoke-RepoGit -Arguments @("show", "${Revision}:package-lock.json")
        $package = ($packageResult.Output -join "`n") + "`n"
        $lock = ($lockResult.Output -join "`n") + "`n"
    }
    else {
        $package = Get-Content -LiteralPath (Join-Path $script:ProjectDir "package.json") -Raw
        $lock = Get-Content -LiteralPath (Join-Path $script:ProjectDir "package-lock.json") -Raw
    }
    $package = $package.Replace("`r`n", "`n").Replace("`r", "`n")
    $lock = $lock.Replace("`r`n", "`n").Replace("`r", "`n")
    $normalizedPackage = Remove-FirstVersionFields $package 1
    $normalizedLock = Remove-FirstVersionFields $lock 2
    $manifest = $normalizedPackage + "`n--- package-lock.json ---`n" + $normalizedLock
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($manifest)
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
    }
}

function Test-ReceiverHealth {
    try {
        $health = Invoke-RestMethod -Uri $script:HealthUrl -TimeoutSec 2
        return $health.status -eq "ok" -and
            $health.application -eq "hasunosora-community-receiver" -and
            $health.schemaVersion -eq 1
    }
    catch {
        return $false
    }
}

function Test-AdminRunning {
    try {
        $identity = Invoke-RestMethod -Uri "http://127.0.0.1:${AdminPort}/api/admin/identity" -TimeoutSec 2
        return $identity.application -eq "hasunosora-pilgrimage-admin" -and $identity.schemaVersion -eq 1
    }
    catch { return $false }
}

function Get-VerifiedReceiverTask {
    $task = Get-ScheduledTask -TaskName $script:ReceiverTaskName -ErrorAction Stop
    $actions = @($task.Actions)
    if ($actions.Count -ne 1) {
        throw "The receiver task must have exactly one action."
    }

    $action = $actions[0]
    $actionExecutable = [Environment]::ExpandEnvironmentVariables(
        ([string]$action.Execute).Trim()
    ).Trim('"')
    $actionArguments = [Environment]::ExpandEnvironmentVariables(
        ([string]$action.Arguments).Trim()
    ).Trim('"')
    $workingDirectory = [Environment]::ExpandEnvironmentVariables(
        ([string]$action.WorkingDirectory).Trim()
    )
    if (-not $workingDirectory) {
        throw "The receiver task has no working directory."
    }

    if (([IO.Path]::GetFileName($actionExecutable) -ine "node.exe") -or
        ([IO.Path]::GetFullPath($actionArguments) -ne $script:ServerFile) -or
        ([IO.Path]::GetFullPath($workingDirectory) -ne $script:ProjectDir)) {
        throw "The receiver task does not point to this project."
    }
    return $task
}

function Stop-ReceiverTask($Task) {
    if ($Task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $script:ReceiverTaskName
    }
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $state = (Get-ScheduledTask -TaskName $script:ReceiverTaskName).State
        if (($state -ne "Running") -and (-not (Test-ReceiverListening))) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "The receiver task or its loopback listener did not stop within 10 seconds. Stop any manually launched receiver before retrying."
}

function Test-ReceiverListening {
    $client = New-Object Net.Sockets.TcpClient
    $connect = $null
    try {
        $connect = $client.BeginConnect("127.0.0.1", $script:HealthPort, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(3000)) { return $true }
        $client.EndConnect($connect)
        return $true
    }
    catch [Net.Sockets.SocketException] {
        $socketException = $_.Exception.GetBaseException()
        if (($socketException -is [Net.Sockets.SocketException]) -and
            ($socketException.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused)) { return $false }
        throw
    }
    finally {
        if ($null -ne $connect) { $connect.AsyncWaitHandle.Close() }
        $client.Close()
    }
}

function Start-ReceiverTaskAndWait {
    Start-ScheduledTask -TaskName $script:ReceiverTaskName
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        Start-Sleep -Seconds 1
        if (((Get-ScheduledTask -TaskName $script:ReceiverTaskName).State -eq "Running") -and
            (Test-ReceiverHealth)) {
            return
        }
    }
    throw "The receiver did not pass its health check within 30 seconds."
}

try {
    try {
        $LockStream = [IO.File]::Open(
            $LockFile,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch [IO.IOException] {
        exit 0
    }

    $ResolvedGitExe = Resolve-Tool $GitExe "git.exe"
    $ResolvedNpmExe = Resolve-Tool $NpmExe "npm.cmd"

    if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir ".git"))) {
        throw "The project directory is not a Git repository."
    }
    if (-not (Test-Path -LiteralPath $ServerFile -PathType Leaf)) {
        throw "community-server.mjs was not found."
    }

    $status = Invoke-RepoGit -Arguments @("status", "--porcelain", "--untracked-files=no")
    $localCommit = Get-Commit "HEAD"
    $remoteCommit = $localCommit
    if ($status.Output.Count -gt 0) {
        Write-UpdateLog "Tracked local changes exist; automatic pull was skipped."
    }
    else {
        $originResult = Invoke-RepoGit -Arguments @("remote", "get-url", "origin")
        $origin = ([string]$originResult.Output[0]).Trim().TrimEnd('/')
        if ($origin -ine $ExpectedOrigin) {
            throw "The origin remote is not the trusted pilgrimage repository."
        }

        $fetch = Invoke-RepoGit `
            -Arguments @("fetch", "--quiet", "origin", "main") `
            -AllowFailure
        if ($fetch.ExitCode -eq 0) {
            $remoteCommit = Get-Commit "refs/remotes/origin/main"
        }
        else {
            Write-UpdateLog "GitHub could not be reached; update check will retry later."
        }
    }

    $deployedCommit = ""
    if (Test-Path -LiteralPath $StateFile) {
        $deployedCommit = ([string](Get-Content -LiteralPath $StateFile -Raw)).Trim()
    }
    $storedDependencyHash = ""
    if (Test-Path -LiteralPath $DependencyStateFile) {
        $storedDependencyHash = ([string](Get-Content -LiteralPath $DependencyStateFile -Raw)).Trim()
    }
    $nodeModulesMissing = -not (Test-Path -LiteralPath (Join-Path $ProjectDir "node_modules"))
    # Inspect the candidate manifests before merge: a deferred update must leave
    # the checkout, running receiver and successful-deployment state untouched.
    $candidateRevision = ""
    if ($localCommit -ne $remoteCommit) { $candidateRevision = $remoteCommit }
    $currentDependencyHash = Get-DependencyHash $candidateRevision
    $installDependencies = $nodeModulesMissing -or (-not $storedDependencyHash) -or
        ($storedDependencyHash -ne $currentDependencyHash) -or
        (Test-Path -LiteralPath $DependencyPendingFile)

    if ($installDependencies) {
        try {
            $DependencyLockStream = [IO.File]::Open($DependencyLockFile,
                [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch [IO.IOException] {
            Write-UpdateLog "Dependency update deferred: the visible admin launcher is using node_modules. Retry after closing its window."
            exit 0
        }
        # Also protect admins started with an older, non-cooperating launcher.
        if (Test-AdminRunning) {
            Write-UpdateLog "Dependency update deferred: an admin server is still running. Retry after stopping it."
            exit 0
        }
    }

    if ($localCommit -ne $remoteCommit) {
        $ancestor = Invoke-RepoGit `
            -Arguments @("merge-base", "--is-ancestor", $localCommit, $remoteCommit) `
            -AllowFailure
        if ($ancestor.ExitCode -ne 0) {
            throw "Local main is not behind origin/main by a fast-forward update."
        }
        Invoke-RepoGit -Arguments @("merge", "--ff-only", $remoteCommit) | Out-Null
        Write-UpdateLog "Updated repository from $localCommit to $remoteCommit."
    }

    $currentCommit = Get-Commit "HEAD"

    $restartRequired = ($deployedCommit -ne $currentCommit) -or
        $installDependencies -or
        (-not (Test-ReceiverHealth))
    if ($restartRequired) {
        $receiverTask = Get-VerifiedReceiverTask
        $restartError = $null
        $dependenciesReady = -not $installDependencies
        $receiverStopped = $false
        try {
            if ($installDependencies) {
                Set-Content -LiteralPath $DependencyPendingFile -Value $currentCommit -Encoding ASCII
            }
            Stop-ReceiverTask $receiverTask
            $receiverStopped = $true
            if ($installDependencies) {
                Write-UpdateLog "Installing dependencies for $currentCommit."
                $previousErrorActionPreference = $ErrorActionPreference
                Push-Location -LiteralPath $ProjectDir
                try {
                    $ErrorActionPreference = "Continue"
                    $npmOutput = @(& $ResolvedNpmExe ci --no-audit --no-fund 2>&1)
                    $npmExitCode = $LASTEXITCODE
                }
                finally {
                    $ErrorActionPreference = $previousErrorActionPreference
                    Pop-Location
                }
                if ($npmExitCode -ne 0) {
                    throw "npm ci failed: $($npmOutput -join ' ')"
                }
                $dependenciesReady = $true
            }
        }
        catch {
            $restartError = $_
        }
        finally {
            # npm ci may have partially removed node_modules on failure. Keep
            # the receiver stopped and the admin waiting until a later repair.
            if ($receiverStopped -and $dependenciesReady) { Start-ReceiverTaskAndWait }
        }

        if ($null -ne $restartError) {
            throw $restartError
        }

        if ($currentDependencyHash) {
            Set-Content -LiteralPath $DependencyStateFile -Value $currentDependencyHash -Encoding ASCII
        }
        Set-Content -LiteralPath $StateFile -Value $currentCommit -Encoding ASCII
        if (Test-Path -LiteralPath $DependencyPendingFile) {
            Remove-Item -LiteralPath $DependencyPendingFile
        }
        Write-UpdateLog "Receiver restarted successfully at $currentCommit."
    }
}
catch {
    try {
        Write-UpdateLog "ERROR: $($_.Exception.Message)"
    }
    catch {}
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
finally {
    if ($null -ne $DependencyLockStream) { $DependencyLockStream.Dispose() }
    if ($null -ne $LockStream) {
        $LockStream.Dispose()
    }
}

exit 0
