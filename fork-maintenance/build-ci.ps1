# GitHub-hosted build only. No app launch, signing service, deployment or release.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_REPOSITORY -ne 'lebochoffice/NuvioDesktop' -or $env:GITHUB_REF -ne 'refs/heads/Dev' -or $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch') {
    throw 'MSI CI is restricted to an explicit manual run on the personal fork Dev branch.'
}
foreach ($name in @('NUVIO_SUPABASE_URL', 'NUVIO_SUPABASE_ANON_KEY', 'NUVIO_WEBVIEW2_DIR')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Required public configuration/build input missing: $name" }
}
if ($env:NUVIO_SUPABASE_URL -ne 'https://api.nuvio.tv' -or $env:NUVIO_SUPABASE_ANON_KEY -notlike 'sb_publishable_*') {
    throw 'Set the authorized official public backend URL and Publishable Key as repository Variables, never a private key.'
}
$env:SENTRY_AUTH_TOKEN = $null
# IntroDbConfig is generated from local.properties only; without it "Skip intro"
# is disabled and packageReleaseMsi fails fast. Public URL, not a secret.
if ($env:NUVIO_INTRODB_API_URL -ne 'https://api.introdb.app') { throw 'Set repository Variable NUVIO_INTRODB_API_URL=https://api.introdb.app.' }
Add-Content -LiteralPath 'local.properties' -Value "`nINTRODB_API_URL=$($env:NUVIO_INTRODB_API_URL)" -Encoding utf8
$versionArgs = @()
if ($env:NUVIO_FORK_VERSION) {
    if ($env:NUVIO_FORK_VERSION -notmatch '^\d+\.\d+\.\d+-watchparty$') { throw 'NUVIO_FORK_VERSION must look like 0.1.38-watchparty.' }
    $core = $env:NUVIO_FORK_VERSION.Split('-')[0].Split('.') | ForEach-Object { [int]$_ }
    $versionArgs = @("-Pnuvio.desktop.versionName=$($env:NUVIO_FORK_VERSION)", "-Pnuvio.desktop.versionCode=$($core[0] * 10000 + $core[1] * 100 + $core[2])")
}
& .\gradlew.bat :composeApp:packageReleaseMsi "-Pnuvio.webview2.dir=$env:NUVIO_WEBVIEW2_DIR" @versionArgs '-Dorg.gradle.jvmargs=-Xmx4g' '-Pkotlin.daemon.jvmargs=-Xmx3g' --max-workers=2 --no-configuration-cache --console=plain --stacktrace
if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
& "$PSScriptRoot/verify-msi.ps1"
