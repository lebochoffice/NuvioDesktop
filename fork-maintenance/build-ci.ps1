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
& .\gradlew.bat :composeApp:packageReleaseMsi "-Pnuvio.webview2.dir=$env:NUVIO_WEBVIEW2_DIR" '-Dorg.gradle.jvmargs=-Xmx4g' '-Pkotlin.daemon.jvmargs=-Xmx3g' --max-workers=2 --no-configuration-cache --console=plain --stacktrace
if ($LASTEXITCODE -ne 0) { throw 'MSI build failed' }
& "$PSScriptRoot/verify-msi.ps1"
