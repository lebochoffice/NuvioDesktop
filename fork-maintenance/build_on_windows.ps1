[CmdletBinding()]
param(
    [string]$RepoPath = $(if (Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'gradlew.bat')) { Split-Path -Parent $PSScriptRoot } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'NuvioDesktop' }),
    [string]$WebView2Path,
    [switch]$Msi,
    [switch]$AllowUnconfiguredBuild
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo 'gradlew.bat'))) { throw 'Run this against the NuvioDesktop checkout.' }
$previousGradleHome = $env:GRADLE_USER_HOME
$previousAndroidHome = $env:ANDROID_HOME
try {
    $env:GRADLE_USER_HOME = Join-Path $repo '.gradle-home'
    if (-not $env:ANDROID_HOME -and (Test-Path (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
    if ($Msi -and -not $AllowUnconfiguredBuild) {
        $props = Join-Path $repo 'local.properties'
        $text = if (Test-Path -LiteralPath $props) { Get-Content -LiteralPath $props -Raw } else { '' }
        foreach ($name in @('NUVIO_SUPABASE_URL', 'NUVIO_SUPABASE_ANON_KEY')) {
            if (-not [Environment]::GetEnvironmentVariable($name) -and $text -notmatch "(?m)^\s*$name\s*=\s*\S+") {
                throw "$name missing. Set the public backend configuration. -AllowUnconfiguredBuild permits diagnostic packaging only."
            }
        }
        # Empty IntroDB configuration silently disables "Skip intro" (fail fast).
        if ($text -notmatch '(?m)^\s*INTRODB_API_URL\s*=\s*https://\S+') {
            throw 'INTRODB_API_URL (https) missing in local.properties. Skip intro would be disabled. -AllowUnconfiguredBuild permits diagnostic packaging only.'
        }
    }
    $arguments = @('--console=plain', '--stacktrace', '--no-configuration-cache', '--max-workers=4', '-Dorg.gradle.jvmargs=-Xmx4g', '-Pkotlin.daemon.jvmargs=-Xmx3g')
    if ($WebView2Path) { $arguments += "-Pnuvio.webview2.dir=$((Resolve-Path -LiteralPath $WebView2Path).Path)" }
    Push-Location $repo
    try {
        & .\gradlew.bat :composeApp:desktopTest --tests '*Party*Test' @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Party tests failed. MSI build was not started.' }
        if ($Msi) {
            & .\gradlew.bat :composeApp:packageReleaseMsi @arguments
            if ($LASTEXITCODE -ne 0) { throw 'MSI packaging failed; see the first Gradle failure above.' }
            $outputs = @(Get-ChildItem 'composeApp\build\compose\release-msis\*.msi' -ErrorAction SilentlyContinue)
            if (-not $outputs) { throw 'Gradle returned success but no published MSI was found.' }
            $outputs | ForEach-Object { Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 }
        }
    } finally { Pop-Location }
} finally {
    $env:GRADLE_USER_HOME = $previousGradleHome
    $env:ANDROID_HOME = $previousAndroidHome
}
