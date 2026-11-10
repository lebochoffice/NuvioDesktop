# Read-only Windows Installer database inspection; never invokes msiexec.
[CmdletBinding()]
param(
    [string]$RepoPath,
    [string]$MsiPath,
    # Test builds only: accept the feature-preview invitation origin.
    [switch]$AllowPreviewOrigin,
    # Retained for older invocations. Package protocol verification is always on.
    [switch]$RequirePartyProtocol,
    [string]$InstalledExePath,
    [string]$ExpectedProductVersion,
    [switch]$WatchPartyTest
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-msi-identity.ps1') -WatchPartyTest:$WatchPartyTest
if (!$PSBoundParameters.ContainsKey('RepoPath')) {
    $RepoPath = Split-Path -Parent $PSScriptRoot
}
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$buildDirectory = if ($WatchPartyTest) { 'composeApp/build/windows-watch-party-test' } else { 'composeApp/build' }
$msis = if ($MsiPath) { @(Get-Item -LiteralPath $MsiPath) } else { @(Get-ChildItem (Join-Path $repo "$buildDirectory/compose/release-msis") -Filter '*.msi') }
if ($msis.Count -ne 1) { throw "Expected one published MSI, found $($msis.Count)" }
$msi = $msis[0]
if ($msi.PSIsContainer -or $msi.Extension -ne '.msi') { throw 'Expected an MSI file' }
$stream = [IO.File]::OpenRead($msi.FullName)
try {
    $bytes = New-Object byte[] 8
    if ($stream.Read($bytes, 0, 8) -ne 8 -or (-join ($bytes | ForEach-Object { $_.ToString('X2') })) -ne 'D0CF11E0A1B11AE1') { throw 'Not an MSI compound document' }
} finally { $stream.Dispose() }
& (Join-Path $PSScriptRoot 'register-windows-party-protocol.ps1') -MsiPath $msi.FullName -VerifyOnly -WatchPartyTest:$WatchPartyTest

$app = Join-Path $repo "$buildDirectory/compose/binaries/main-release/app/$familyMsiProductName"
$jars = @(Get-ChildItem (Join-Path $app 'app') -Filter 'composeApp-desktop-*.jar')
if ($jars.Count -ne 1) { throw 'Expected one packaged desktop application JAR' }

$installer = New-Object -ComObject WindowsInstaller.Installer
try {
    $db = $installer.OpenDatabase($msi.FullName, 0)
    try {
        $properties = Get-VerifiedFamilyMsiProperties $db $ExpectedProductVersion
        # Bind the staged inspection to the selected MSI File table, rather than only
        # checking an unrelated staging directory. Cabinet bytes are not extracted.
        $view = $db.OpenView('SELECT `FileName`, `FileSize` FROM `File`')
        try {
            $view.Execute()
            $matchingJars = 0
            while ($record = $view.Fetch()) {
                try {
                    if ($record.StringData(1).Split('|')[-1] -eq $jars[0].Name) {
                        if ($record.IntegerData(2) -ne $jars[0].Length) { throw 'MSI application JAR size differs from staged JAR' }
                        $matchingJars++
                    }
                } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
            }
        } finally { Close-MsiView $view }
        if ($matchingJars -ne 1) { throw 'Selected MSI does not contain the staged application JAR name' }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db) }
} finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($jars[0].FullName)
try {
    $required = @('native/windows/player_bridge.dll','native/windows/libmpv-2.dll','native/windows/WebView2Loader.dll','native/windows/nuvio_engine.dll','native/windows/runtime-files.txt')
    foreach ($entry in $required) { if (-not $zip.GetEntry($entry)) { throw "Packaged native runtime entry missing: $entry" } }
    if ($zip.Entries | Where-Object { $_.FullName.StartsWith('fork-updater/', [StringComparison]::OrdinalIgnoreCase) }) {
        throw 'Unexpected in-app updater resources in the packaged application'
    }
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
    if (-not $partyText.Contains('https://family-beta.nuvio-watch-friends.pages.dev')) { throw 'Browser watch party invite origin missing from packaged application' }
    # The origin actually used for invitations (generated PartyBrowserConfig).
    $originEntry = $zip.GetEntry('com/nuvio/app/features/party/PartyBrowserConfig.class')
    if (-not $originEntry) { throw 'PartyBrowserConfig missing from packaged application' }
    $reader = New-Object IO.StreamReader($originEntry.Open(), [Text.Encoding]::UTF8)
    try { $originText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    $previewOrigin = 'https://family-beta.nuvio-watch-friends.pages.dev'
    $inviteOrigin = if ($originText.Contains($previewOrigin)) { $previewOrigin } elseif ($originText.Contains('https://nuvio-watch-friends.pages.dev')) { 'https://nuvio-watch-friends.pages.dev' } else { throw 'Unknown browser invite origin in PartyBrowserConfig' }
    if ($inviteOrigin -eq $previewOrigin -and -not $AllowPreviewOrigin) { throw 'Packaged invite origin is the feature preview; only test builds may use it (-AllowPreviewOrigin).' }
    # 0.1.39: the host sequences browser commands (command ID + ack).
    foreach ($entry in @('com/nuvio/app/features/party/PartyCommandLedger.class', 'com/nuvio/app/features/party/PartyCommand.class')) {
        if (-not $zip.GetEntry($entry)) { throw "Guest command sequencer missing from packaged application: $entry" }
    }
    # Frame-accurate paused party seek: the bridge DLL must export it (a stale
    # DLL would silently fall back to keyframe seeks).
    $bridgeEntry = $zip.GetEntry('native/windows/player_bridge.dll')
    $memory = New-Object IO.MemoryStream
    $stream = $bridgeEntry.Open()
    try { $stream.CopyTo($memory) } finally { $stream.Dispose() }
    $bridgeText = [Text.Encoding]::ASCII.GetString($memory.ToArray())
    if (-not $bridgeText.Contains('Java_com_nuvio_app_features_player_desktop_NativePlayerBridge_seekToExact')) { throw 'Packaged player_bridge.dll lacks the exact seek export (stale bridge build)' }
    $bridgeClass = $zip.GetEntry('com/nuvio/app/features/player/desktop/NativePlayerBridge.class')
    if (-not $bridgeClass) { throw 'NativePlayerBridge class missing from packaged application' }
    $reader = New-Object IO.StreamReader($bridgeClass.Open(), [Text.Encoding]::UTF8)
    try { $bridgeClassText = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not $bridgeClassText.Contains('seekToExact')) { throw 'NativePlayerBridge.seekToExact missing from packaged application' }
} finally { $zip.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $app 'runtime/bin/server/jvm.dll'))) { throw 'Packaged Java runtime missing' }

# This optional section inspects the installed machine. It never launches a URI.
if ($InstalledExePath) {
    $exe = Get-Item -LiteralPath $InstalledExePath
    if ($exe.PSIsContainer -or $exe.Name -ine $familyMsiLauncher) { throw "Expected the installed $familyMsiLauncher." }
    $command = '"{0}" --party-link "%1"' -f $exe.FullName
    $classes = 'Registry::HKEY_CLASSES_ROOT'
    $capabilities = "HKLM:\$familyMsiCapabilities"
    function Assert-RegistryValue([string]$Path, [string]$Name, [string]$Expected) {
        $key = Get-Item -LiteralPath $Path
        if ($key.GetValueNames() -notcontains $Name -or $key.GetValue($Name) -ine $Expected) {
            throw "Unexpected installed registry value '$Name' in $Path. Expected '$Expected'."
        }
    }
    Assert-RegistryValue "$classes\$familyMsiProgId" 'URL Protocol' ''
    Assert-RegistryValue "$classes\$familyMsiProgId\shell\open\command" '' $command
    Assert-RegistryValue $capabilities 'ApplicationName' $familyMsiProductName
    Assert-RegistryValue $capabilities 'ApplicationDescription' 'Open Nuvio watch party invitations.'
    Assert-RegistryValue "$capabilities\URLAssociations" $familyMsiScheme $familyMsiProgId
    Assert-RegistryValue 'HKLM:\SOFTWARE\RegisteredApplications' $familyMsiProductName $familyMsiCapabilities
    Write-Host 'Installed registry verified. Open a party URI separately to verify Windows routing.'
}

$manifest = [ordered]@{
    file = $msi.Name; bytes = $msi.Length; sha256 = (Get-FileHash -LiteralPath $msi.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    product = $properties['ProductName']; productVersion = $properties['ProductVersion']; signature = [string](Get-AuthenticodeSignature -LiteralPath $msi.FullName).Status
    upgradeCode = $properties['UpgradeCode']; productCode = $properties['ProductCode']; architecture = 'x64'
    appJar = $jars[0].Name; requiredNativeEntries = $required; watchInBrowser = $true; javaRuntimePresent = $true
    installedOrLaunched = $false; msiInspectedReadOnly = $true; stagedAppInspected = $true; msiJarMetadataMatchesStage = $true; publicBackendConfigured = $true; introDbConfigured = $true; browserInviteOrigin = $inviteOrigin; guestCommandSequencer = $true; exactPausedSeek = $true; sourceCommit = $env:GITHUB_SHA
    familyPartyRegistryInspected = $true; installedPartyRegistryInspected = [bool]$InstalledExePath
}
$path = Join-Path $msi.DirectoryName ($msi.BaseName + '-verification.json')
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
$manifest | ConvertTo-Json -Depth 4
