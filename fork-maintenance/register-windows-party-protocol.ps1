# Author the Windows URI registration in the generated MSI before it is published.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$MsiPath,
    [switch]$VerifyOnly,
    [switch]$WatchPartyTest
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-msi-identity.ps1') -WatchPartyTest:$WatchPartyTest
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$msi = Get-Item -LiteralPath $MsiPath
if ($msi.Extension -ne '.msi' -or $msi.PSIsContainer) { throw 'Expected a generated MSI file.' }
if (!$VerifyOnly -and (Get-AuthenticodeSignature -LiteralPath $msi.FullName).Status -ne 'NotSigned') {
    throw 'Register the party protocol before signing the MSI.'
}
$installer = New-Object -ComObject WindowsInstaller.Installer
function Get-MsiErrorDetail {
    try {
        $errorRecord = $installer.LastErrorRecord()
        if ($null -eq $errorRecord) { return }
        try {
            $code = $errorRecord.IntegerData(1)
            $message = $errorRecord.FormatText()
            "Windows Installer ($code): $message"
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($errorRecord) }
    } catch { "MSI diagnostics unavailable: $($_.Exception.Message)" }
}

function Invoke-MsiStatement($Database, [string]$Sql, $Record = $null) {
    $statement = $Database.OpenView($Sql)
    try {
        if ($null -eq $Record) { $statement.Execute() } else { $statement.Execute($Record) }
    } finally { Close-MsiView $statement }
}

$db = $null
$stage = "opening MSI '$($msi.FullName)' (VerifyOnly=$VerifyOnly)"
try {
    $mode = if ($VerifyOnly) { 0 } else { 1 }
    $db = $installer.OpenDatabase($msi.FullName, $mode)
    $stage = 'checking the MSI product and upgrade family'
    $null = Get-VerifiedFamilyMsiProperties $db -BeforeUpgradePolicy:(!$VerifyOnly)
    $stage = 'reading the launcher File row'
    $view = $db.OpenView('SELECT `File`, `Component_`, `FileName` FROM `File`')
    $launchers = @()
    try {
        $view.Execute()
        while ($record = $view.Fetch()) {
            try {
                if ($record.StringData(3).Split('|')[-1] -ceq $familyMsiLauncher) {
                    $launchers += @{ File = $record.StringData(1); Component = $record.StringData(2) }
                }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
    if ($launchers.Count -ne 1) { throw "Expected one $familyMsiLauncher in the MSI File table." }
    $file = $launchers[0].File
    $component = $launchers[0].Component
    $command = '"[#{0}]" --party-link "%1"' -f $file

    $rows = @(
        @{ Id = 'Fork'; Root = 0; Key = $familyMsiProgId; Name = $null; Value = "URL:$familyMsiProductName Party" }
        @{ Id = 'ForkMarker'; Root = 0; Key = $familyMsiProgId; Name = 'URL Protocol'; Value = '[NUVIOPARTYPROTOCOLMARKER]' }
        @{ Id = 'ForkCommand'; Root = 0; Key = "$familyMsiProgId\shell\open\command"; Name = $null; Value = $command }
        @{ Id = 'Capabilities'; Root = -1; Key = $familyMsiCapabilities; Name = 'ApplicationName'; Value = $familyMsiProductName }
        @{ Id = 'Description'; Root = -1; Key = $familyMsiCapabilities; Name = 'ApplicationDescription'; Value = 'Open Nuvio watch party invitations.' }
        @{ Id = 'Associations'; Root = -1; Key = "$familyMsiCapabilities\URLAssociations"; Name = $familyMsiScheme; Value = $familyMsiProgId }
        @{ Id = 'Registered'; Root = -1; Key = 'Software\RegisteredApplications'; Name = $familyMsiProductName; Value = $familyMsiCapabilities }
    )

    $stage = 'checking component and feature'
    $v = $db.OpenView('SELECT `Component`, `Attributes`, `KeyPath`, `Directory_` FROM `Component`')
    $launcherComponent = $false
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try {
                if ($r.StringData(1) -cne $component) { continue }
                $launcherComponent = $r.StringData(3) -ceq $file -and
                    $r.StringData(4) -ceq 'INSTALLDIR' -and ($r.IntegerData(2) -band 20) -eq 0
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
        }
    } finally { Close-MsiView $v }
    if (!$launcherComponent) { throw "$familyMsiLauncher must be the key path of a removable file component in INSTALLDIR." }

    $v = $db.OpenView('SELECT `FeatureComponents`.`Component_`, `Feature`.`Level` FROM `FeatureComponents`, `Feature` WHERE `FeatureComponents`.`Feature_` = `Feature`.`Feature`')
    $included = $false
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try {
                if ($r.StringData(1) -ceq $component -and $r.IntegerData(2) -eq 1) { $included = $true }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
        }
    } finally { Close-MsiView $v }
    if (!$included) { throw "$familyMsiLauncher component is absent from default install features." }

    $stage = 'checking registry install and uninstall actions'
    $v = $db.OpenView('SELECT `Action`, `Sequence` FROM `InstallExecuteSequence`')
    $actions = @{}
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try { $actions[$r.StringData(1)] = $r.IntegerData(2) }
            finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
        }
    } finally { Close-MsiView $v }
    if ($actions['WriteRegistryValues'] -le 0 -or $actions['RemoveRegistryValues'] -le 0) {
        throw 'Windows Installer registry actions are missing.'
    }
    if (!$actions.ContainsKey('FindRelatedProducts') -or !$actions.ContainsKey('RemoveExistingProducts') -or
        $actions['FindRelatedProducts'] -le 0 -or $actions['RemoveExistingProducts'] -le $actions['FindRelatedProducts']) {
        throw 'Windows Installer major upgrade actions are missing or out of order.'
    }
    $removeSequence = $actions['RemoveExistingProducts']
    if (!$VerifyOnly) {
        $validateSequence = $actions['InstallValidate']
        $removeSequence = $validateSequence + 1
        if ($validateSequence -le 0 -or $removeSequence -ge $actions['InstallInitialize'] -or
            @($actions.Keys | Where-Object { $_ -ne 'RemoveExistingProducts' -and $actions[$_] -eq $removeSequence }).Count) {
            throw 'No safe MSI slot for RemoveExistingProducts between InstallValidate and InstallInitialize.'
        }
    }
    if (!$VerifyOnly) {
        $stage = 'scheduling RemoveExistingProducts after InstallValidate'
        Invoke-MsiStatement $db ('UPDATE `InstallExecuteSequence` SET `Sequence` = {0} WHERE `Action` = ''RemoveExistingProducts''' -f $removeSequence)

        $stage = 'replacing the downgrade rule in Upgrade'
        $upgrade = $db.OpenView('SELECT `UpgradeCode`, `VersionMin`, `VersionMax`, `Language`, `Attributes`, `Remove`, `ActionProperty` FROM `Upgrade` WHERE `ActionProperty` = ''JP_DOWNGRADABLE_FOUND''')
        $record = $null
        try {
            $upgrade.Execute()
            $record = $upgrade.Fetch()
            if (!$record) { throw 'Missing validated JP_DOWNGRADABLE_FOUND row.' }
            if ($record.IntegerData(5) -ne 258) {
                # Attributes belongs to the key. Replace the fetched row and keep its nullable key fields.
                $record.IntegerData(5) = 258 # OnlyDetect | VersionMinInclusive
                $upgrade.Modify(4, $record) # msiViewModifyReplace
            }
        } catch {
            $failure = $_.Exception
            $detail = Get-MsiErrorDetail
            if ($detail) { throw [InvalidOperationException]::new($detail, $failure) }
            throw
        } finally {
            try {
                if ($null -ne $record) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
            } finally { Close-MsiView $upgrade }
        }
        $stage = 'authoring the declarative Family launch condition'
        if (!(Test-MsiTable $db 'LaunchCondition')) {
            Invoke-MsiStatement $db 'CREATE TABLE `LaunchCondition` (`Condition` CHAR(255) NOT NULL, `Description` CHAR(255) NOT NULL LOCALIZABLE PRIMARY KEY `Condition`)'
        }
        $record = $installer.CreateRecord(2)
        try {
            $record.StringData(1) = $familyMsiLaunchCondition
            $record.StringData(2) = 'An equal or newer Nuvio Family version is already installed.'
            Invoke-MsiStatement $db 'INSERT INTO `LaunchCondition` (`Condition`, `Description`) VALUES (?, ?)' $record
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }

        foreach ($table in $familyMsiVersionTables) {
            $sequence = Get-FamilyMsiSequence $db $table
            $find = $sequence['FindRelatedProducts']
            if (!$find) { throw "Missing FindRelatedProducts in $table." }
            $extended = $sequence['JpFindRelatedProducts']
            $launchSequence = if ($extended) { [Math]::Max($find.Number, $extended.Number) + 1 } else { $find.Number + 1 }
            if ($sequence.ContainsKey('LaunchConditions') -or
                @($sequence.Values | Where-Object Number -eq $launchSequence).Count) {
                throw "Unexpected LaunchConditions or occupied sequence slot in $table."
            }
            Invoke-MsiStatement $db ('INSERT INTO `{0}` (`Action`, `Sequence`) VALUES (''LaunchConditions'', {1})' -f $table, $launchSequence)
        }
        $null = Get-VerifiedFamilyMsiProperties $db

        $stage = 'removing obsolete package rows'
        foreach ($old in @('Scheme', 'SchemeMarker', 'SchemeCommand') + @($rows.Id)) {
            $existing = $db.OpenView(('DELETE FROM `Registry` WHERE `Registry` = ''NuvioFamilyParty{0}''' -f $old))
            try { $existing.Execute() } finally { Close-MsiView $existing }
        }
        foreach ($row in $rows) {
            $stage = "writing Registry row $($row.Id)"
            $record = $installer.CreateRecord(6)
            try {
                $record.StringData(1) = 'NuvioFamilyParty' + $row.Id
                $record.IntegerData(2) = $row.Root
                $record.StringData(3) = $row.Key
                if ($null -ne $row.Name) { $record.StringData(4) = $row.Name }
                $record.StringData(5) = $row.Value
                $record.StringData(6) = $component
                $insert = $db.OpenView('INSERT INTO `Registry` (`Registry`, `Root`, `Key`, `Name`, `Value`, `Component_`) VALUES (?, ?, ?, ?, ?, ?)')
                try { $insert.Execute($record) } finally { Close-MsiView $insert }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
        $stage = 'committing MSI transaction'
        $db.Commit()
        # Gradle starts a fresh process for read-only verification after this writer exits.
        Write-Host 'Windows party protocol: MSI registration committed.'
        return
    }

    $stage = 'verifying committed registry contract'
    $v = $db.OpenView('SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`')
    $actual = @{}
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try {
                $key = $r.StringData(3)
                if ($WatchPartyTest -and ($key -match '^(?:Software\\Classes\\)?Nuvio\.Family\.Party(?:\\|$)|^Software\\NuvioFamily(?:\\|$)' -or
                    ($key -ieq 'Software\RegisteredApplications' -and $r.StringData(4) -ieq 'Nuvio Family'))) {
                    throw "Unexpected Family registry entry in the test MSI: $key"
                }
                if ($key -match '^(?:Software\\Classes\\)?nuvio(?:\\|$)') {
                    throw "Unexpected shared protocol key in MSI: $key"
                }
                if ($key -match '(?:^|\\)UrlAssociations\\(?:nuvio|nuvio-watch-test)\\UserChoice(?:\\|$)') {
                    throw 'MSI must not set the Windows user default for nuvio://.'
                }
                $actual[$r.StringData(1)] = @{
                    Root = $r.IntegerData(2); Key = $key; Name = $r.StringData(4)
                    Value = $r.StringData(5); Component = $r.StringData(6)
                }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
        }
    } finally { Close-MsiView $v }
    foreach ($row in $rows) {
        $id = 'NuvioFamilyParty' + $row.Id
        $entry = $actual[$id]
        if (!$entry) { throw "Missing MSI Registry row $id." }
        foreach ($field in @('Root', 'Key', 'Name', 'Value')) {
            if ([string]$entry[$field] -cne [string]$row[$field]) { throw "Incorrect $field in MSI Registry row $id." }
        }
        if ($entry.Component -cne $component) { throw "Registry row $id does not belong to the $familyMsiLauncher component." }
    }
    Write-Host 'Windows party protocol: Package-specific association verified in the MSI. Installed behavior requires a live check.'
} catch {
    $failure = $_.Exception.ToString()
    $detail = Get-MsiErrorDetail
    if ($detail) { $failure += "`n$detail" }
    throw "Windows party protocol failed while ${stage}: $failure"
} finally {
    try {
        if ($null -ne $db) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db) }
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer)
    }
}
