# Read-only Windows Installer database inspection; never invokes msiexec.
[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$MsiPath
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$msis = if ($MsiPath) { @(Get-Item -LiteralPath $MsiPath) } else { @(Get-ChildItem (Join-Path $repo 'composeApp/build/compose/release-msis') -Filter '*.msi') }
if ($msis.Count -ne 1) { throw "Expected one published MSI, found $($msis.Count)" }
$msi = $msis[0]
if ($msi.PSIsContainer -or $msi.Extension -ne '.msi') { throw 'Expected an MSI file' }
$stream = [IO.File]::OpenRead($msi.FullName)
try {
    $bytes = New-Object byte[] 8
    if ($stream.Read($bytes, 0, 8) -ne 8 -or (-join ($bytes | ForEach-Object { $_.ToString('X2') })) -ne 'D0CF11E0A1B11AE1') { throw 'Not an MSI compound document' }
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
# Bind the staged inspection to the selected MSI File table, rather than only
# checking an unrelated staging directory. Cabinet bytes are not extracted.
$view = $db.OpenView('SELECT `FileName`, `FileSize` FROM `File`')
$view.Execute()
$matchingJars = 0
while ($record = $view.Fetch()) {
    if ($record.StringData(1).Split('|')[-1] -eq $jars[0].Name) {
        if ($record.IntegerData(2) -ne $jars[0].Length) { throw 'MSI application JAR size differs from staged JAR' }
        $matchingJars++
    }
}
$view.Close()
if ($matchingJars -ne 1) { throw 'Selected MSI does not contain the staged application JAR name' }
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
    # 0.1.37: IntroDB must be configured (empty URL disables "Skip intro").
    $introEntry = $zip.GetEntry('com/nuvio/app/features/player/skip/IntroDbConfig.class')
    if (-not $introEntry) { throw 'IntroDbConfig missing from packaged application' }
    $reader = New-Object IO.StreamReader($introEntry.Open(), [Text.Encoding]::UTF8)
    try { $introText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $introText.Contains('https://api.introdb.app')) { throw 'IntroDB URL missing from packaged application' }
    # Invitation links must point to the browser watch party.
    $partyClass = $zip.GetEntry('com/nuvio/app/features/party/PartyRepositoryKt.class')
    if (-not $partyClass) { throw 'PartyRepositoryKt missing from packaged application' }
    $reader = New-Object IO.StreamReader($partyClass.Open(), [Text.Encoding]::UTF8)
    try { $partyText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $partyText.Contains('https://nuvio-watch-friends.pages.dev')) { throw 'Browser watch party invite origin missing from packaged application' }
} finally { $zip.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $app 'runtime/bin/server/jvm.dll'))) { throw 'Packaged Java runtime missing' }
$manifest = [ordered]@{
    file = $msi.Name; bytes = $msi.Length; sha256 = (Get-FileHash -LiteralPath $msi.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    product = $properties['ProductName']; productVersion = $properties['ProductVersion']; signature = [string](Get-AuthenticodeSignature -LiteralPath $msi.FullName).Status
    appJar = $jars[0].Name; requiredNativeEntries = $required; watchInBrowser = $true; javaRuntimePresent = $true
    installedOrLaunched = $false; msiInspectedReadOnly = $true; stagedAppInspected = $true; msiJarMetadataMatchesStage = $true; publicBackendConfigured = $true; introDbConfigured = $true; browserInviteOrigin = 'https://nuvio-watch-friends.pages.dev'; sourceCommit = $env:GITHUB_SHA
}
$path = Join-Path $msi.DirectoryName ($msi.BaseName + '-verification.json')
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
$manifest | ConvertTo-Json -Depth 4
