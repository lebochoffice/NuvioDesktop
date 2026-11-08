# No installation, deployment, execution-policy change or app launch.
[CmdletBinding()]
param(
    [string]$RepoPath,
    [string]$PythonPath,
    [string]$Branch = 'feature/watch-in-browser',
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
if (!$PSBoundParameters.ContainsKey('RepoPath')) {
    $parent = Split-Path -Parent $PSScriptRoot
    $RepoPath = if (Test-Path -LiteralPath (Join-Path $parent 'gradlew.bat')) { $parent } else { Join-Path $parent 'NuvioDesktop' }
}
Set-StrictMode -Version Latest

function Assert-NativeSuccess([string]$Action) {
    if ($LASTEXITCODE -ne 0) { throw "$Action failed (exit $LASTEXITCODE)." }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is missing. Install Git for Windows first.' }
& git --version
Assert-NativeSuccess 'Git check'

# Test actual execution: Windows Store aliases can exist without a working Python.
$candidates = @()
if ($PythonPath) { $candidates += $PythonPath }
else {
    $candidates += @('python', 'python3', 'py')
    $candidates += @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python*\python.exe') -ErrorAction SilentlyContinue | ForEach-Object FullName)
    # Optional Codex-bundled runtime; no dependency on a fixed bundle version.
    $candidates += @(Get-ChildItem 'C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime*\dependencies\python\python.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName)
    if ($env:NUVIO_PYTHON) { $candidates = @($env:NUVIO_PYTHON) + $candidates }
    # Package roots may be executable by path but not enumerable. Query the
    # current user's registered runtime when Windows exposes that information.
    try {
        $packages = @(Get-AppxPackage '*CodexPrimaryRuntime*' -ErrorAction Stop)
        $candidates += @($packages | ForEach-Object { Join-Path $_.InstallLocation 'dependencies\python\python.exe' })
    } catch { # Explicit -PythonPath remains available in restricted sessions.
    }
}
$python = $null
foreach ($candidate in $candidates) {
    try {
        $version = & $candidate -c 'import sys; print(sys.version); sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) { $python = $candidate; Write-Host "Python: $candidate ($version)"; break }
    } catch { continue }
}
if (-not $python) { throw 'No working Python 3.9+. Supply -PythonPath C:\path\to\python.exe. Store aliases alone are not an installation.' }

$repo = [IO.Path]::GetFullPath($RepoPath)
if (-not (Test-Path -LiteralPath $repo)) {
    & git clone --branch Dev --single-branch https://github.com/NuvioMedia/NuvioDesktop.git $repo
    Assert-NativeSuccess 'Clone'
}
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "Not a Git checkout: $repo" }
$origin = & git -C $repo remote get-url origin
Assert-NativeSuccess 'Origin check'
if ($origin -notmatch 'github\.com[:/]NuvioMedia/NuvioDesktop(?:\.git)?$') {
    $upstream = & git -C $repo remote get-url upstream
    Assert-NativeSuccess 'Upstream check'
    if ($upstream -notmatch 'github\.com[:/]NuvioMedia/NuvioDesktop(?:\.git)?$') { throw "Unexpected repository origin/upstream: $origin" }
}
if (-not (Test-Path -LiteralPath (Join-Path $repo 'gradlew.bat'))) { throw 'Gradle wrapper missing.' }

if (-not $Check) {
    $current = & git -C $repo branch --show-current
    Assert-NativeSuccess 'Branch check'
    if ($current -ne $Branch) {
        & git -C $repo show-ref --verify --quiet "refs/heads/$Branch"
        if ($LASTEXITCODE -eq 0) { throw "Branch $Branch already exists. Switch to it explicitly, then rerun. No checkout was changed." }
        & git -C $repo switch -c $Branch
        Assert-NativeSuccess 'Create local branch'
    }
}
& $python (Join-Path $PSScriptRoot 'apply_to_nuvio.py') $repo --check
Assert-NativeSuccess 'Patch validation'
if (-not $Check) {
    & $python (Join-Path $PSScriptRoot 'apply_to_nuvio.py') $repo
    Assert-NativeSuccess 'Patch'
}
Write-Host "Checkout: $repo"
if ($env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\javac.exe'))) {
    & (Join-Path $env:JAVA_HOME 'bin\javac.exe') -version
} else { Write-Warning 'JAVA_HOME must point to a full JDK, not a JRE.' }
Write-Host 'Preparation verified. See README and build_on_windows.ps1 for tests/MSI. Nothing was installed or launched.'
