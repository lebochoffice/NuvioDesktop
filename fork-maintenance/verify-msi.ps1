# Read-only Windows Installer database inspection; never invokes msiexec.
[CmdletBinding()]
param([string]$RepoPath = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$msis = @(Get-ChildItem (Join-Path $repo 'composeApp/build/compose/release-msis') -Filter '*.msi')
if ($msis.Count -ne 1) { throw "Expected one published MSI, found $($msis.Count)" }
$msi = $msis[0]
$stream = [IO.File]::OpenRead($msi.FullName)
try {
    $bytes = New-Object byte[] 8
    if ($stream.Read($bytes, 0, 8) -ne 8 -or [Convert]::ToHexString($bytes) -ne 'D0CF11E0A1B11AE1') { throw 'Not an MSI compound document' }
} finally { $stream.Dispose() }
$installer = New-Object -ComObject WindowsInstaller.Installer
$db = $installer.OpenDatabase($msi.FullName, 0)
$view = $db.OpenView('SELECT `Property`, `Value` FROM `Property`')
$view.Execute()
$properties = @{}
while ($record = $view.Fetch()) { $properties[$record.StringData(1)] = $record.StringData(2) }
$view.Close()
if (-not $properties['ProductName'] -or -not $properties['ProductVersion']) { throw 'MSI product metadata missing' }

$app = Join-Path $repo 'composeApp/build/compose/binaries/main-release/app/Nuvio'
$jars = @(Get-ChildItem (Join-Path $app 'app') -Filter 'composeApp-desktop-*.jar')
if ($jars.Count -ne 1) { throw 'Expected one packaged desktop application JAR' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($jars[0].FullName)
try {
    $required = @('native/windows/player_bridge.dll','native/windows/libmpv-2.dll','native/windows/WebView2Loader.dll','native/windows/nuvio_engine.dll','native/windows/runtime-files.txt')
    foreach ($entry in $required) { if (-not $zip.GetEntry($entry)) { throw "Packaged native runtime entry missing: $entry" } }
    $partyJs = $zip.GetEntry('player-ui/party.js')
    if (-not $partyJs) { throw 'Party overlay missing from packaged application' }
    $reader = New-Object IO.StreamReader($partyJs.Open())
    try { if (-not $reader.ReadToEnd().Contains('NUVIO_BROWSER_PARTY_BRIDGE_V1')) { throw 'Watch in Browser modification missing from packaged app' } }
    finally { $reader.Dispose() }
    $configEntry = $zip.GetEntry('com/nuvio/app/core/network/SupabaseConfig.class')
    if (-not $configEntry) { throw 'Compiled backend configuration missing' }
    $reader = New-Object IO.StreamReader($configEntry.Open(), [Text.Encoding]::UTF8)
    try { $configText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $configText.Contains('https://api.nuvio.tv') -or -not $configText.Contains('sb_publishable_')) { throw 'Official public backend configuration missing from staged application' }
} finally { $zip.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $app 'runtime/bin/server/jvm.dll'))) { throw 'Packaged Java runtime missing' }
$manifest = [ordered]@{
    file = $msi.Name; bytes = $msi.Length; sha256 = (Get-FileHash -LiteralPath $msi.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    product = $properties['ProductName']; productVersion = $properties['ProductVersion']; signature = [string](Get-AuthenticodeSignature -LiteralPath $msi.FullName).Status
    appJar = $jars[0].Name; requiredNativeEntries = $required; watchInBrowser = $true; javaRuntimePresent = $true
    installedOrLaunched = $false; msiInspectedReadOnly = $true; stagedAppInspected = $true; publicBackendConfigured = $true; sourceCommit = $env:GITHUB_SHA
}
$path = Join-Path $msi.DirectoryName ($msi.BaseName + '-verification.json')
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
$manifest | ConvertTo-Json -Depth 4
