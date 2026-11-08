# Author the Windows URI registration in the generated MSI before it is published.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$MsiPath,
    [string]$SchemaActionDll,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$msi = Get-Item -LiteralPath $MsiPath
if ($msi.Extension -ne '.msi' -or $msi.PSIsContainer) { throw 'Expected a generated MSI file.' }
if (!$VerifyOnly -and (Get-AuthenticodeSignature -LiteralPath $msi.FullName).Status -ne 'NotSigned') {
    throw 'Register the party protocol before signing the MSI.'
}
$installer = New-Object -ComObject WindowsInstaller.Installer
function Close-MsiView($View) {
    try { $View.Close() }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($View) }
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
    $stage = 'reading the launcher File row'
    $view = $db.OpenView('SELECT `File`, `Component_`, `FileName` FROM `File`')
    $launchers = @()
    try {
        $view.Execute()
        while ($record = $view.Fetch()) {
            try {
                if ($record.StringData(3).Split('|')[-1] -eq 'Nuvio.exe') {
                    $launchers += @{ File = $record.StringData(1); Component = $record.StringData(2) }
                }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
    if ($launchers.Count -ne 1) { throw 'Expected one Nuvio.exe in the MSI File table.' }
    $file = $launchers[0].File
    $component = $launchers[0].Component
    $command = '"[#{0}]" --party-link "%1"' -f $file

    $rows = @(
        @{ Id = 'Fork'; Root = 0; Key = 'Nuvio.FamilyBeta.Party'; Name = $null; Value = 'URL:Nuvio Family Beta Party' }
        @{ Id = 'ForkMarker'; Root = 0; Key = 'Nuvio.FamilyBeta.Party'; Name = 'URL Protocol'; Value = '[NUVIOPARTYPROTOCOLMARKER]' }
        @{ Id = 'ForkCommand'; Root = 0; Key = 'Nuvio.FamilyBeta.Party\shell\open\command'; Name = $null; Value = $command }
        @{ Id = 'Capabilities'; Root = -1; Key = 'Software\NuvioFamilyBeta\Capabilities'; Name = 'ApplicationName'; Value = 'Nuvio Family Beta' }
        @{ Id = 'Description'; Root = -1; Key = 'Software\NuvioFamilyBeta\Capabilities'; Name = 'ApplicationDescription'; Value = 'Open Nuvio watch party invitations.' }
        @{ Id = 'Associations'; Root = -1; Key = 'Software\NuvioFamilyBeta\Capabilities\URLAssociations'; Name = 'nuvio'; Value = 'Nuvio.FamilyBeta.Party' }
        @{ Id = 'Registered'; Root = -1; Key = 'Software\RegisteredApplications'; Name = 'Nuvio Family Beta'; Value = 'Software\NuvioFamilyBeta\Capabilities' }
    )

    $stage = 'checking component and feature'
    $v = $db.OpenView('SELECT `Component`, `Attributes`, `KeyPath` FROM `Component`')
    $launcherComponent = $false
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try {
                if ($r.StringData(1) -cne $component) { continue }
                # A removable file component with Nuvio.exe as its key path.
                $launcherComponent = $r.StringData(3) -ceq $file -and ($r.IntegerData(2) -band 20) -eq 0
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
        }
    } finally { Close-MsiView $v }
    if (!$launcherComponent) { throw 'Nuvio.exe must be the key path of a removable file component.' }

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
    if (!$included) { throw 'Nuvio.exe component is absent from default install features.' }

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
    $schemaAction = 'NuvioPartySchema'
    $schemaSequence = $actions['RemoveRegistryValues'] - 1
    if ($schemaSequence -le $actions['InstallInitialize'] -or
        $schemaSequence -le $actions['CostFinalize'] -or
        $schemaSequence -le $actions['RemoveExistingProducts'] -or
        $schemaSequence -ge $actions['WriteRegistryValues'] -or
        @($actions.Keys | Where-Object { $_ -ne $schemaAction -and $actions[$_] -eq $schemaSequence }).Count) {
        throw 'No safe MSI slot for the schema action between upgrade removal and registry processing.'
    }

    if (!$VerifyOnly) {
        $stage = 'embedding the conditional URI schema action'
        $dll = Get-Item -LiteralPath $SchemaActionDll
        if ($dll.PSIsContainer -or !$dll.Length) { throw 'The native MSI schema action is missing or empty.' }
        Invoke-MsiStatement $db 'DELETE FROM `InstallExecuteSequence` WHERE `Action` = ''NuvioPartySchema'''
        Invoke-MsiStatement $db 'DELETE FROM `CustomAction` WHERE `Action` = ''NuvioPartySchema'''
        Invoke-MsiStatement $db 'DELETE FROM `Binary` WHERE `Name` = ''NuvioPartySchema'''
        $record = $installer.CreateRecord(2)
        try {
            $record.StringData(1) = $schemaAction
            $record.SetStream(2, $dll.FullName)
            Invoke-MsiStatement $db 'INSERT INTO `Binary` (`Name`, `Data`) VALUES (?, ?)' $record
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        Invoke-MsiStatement $db 'INSERT INTO `CustomAction` (`Action`, `Type`, `Source`, `Target`) VALUES (''NuvioPartySchema'', 1, ''NuvioPartySchema'', ''NuvioPartySchema'')'
        Invoke-MsiStatement $db ('INSERT INTO `InstallExecuteSequence` (`Action`, `Sequence`) VALUES (''NuvioPartySchema'', {0})' -f $schemaSequence)

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

    $stage = 'verifying the conditional URI schema action'
    if ($actions[$schemaAction] -ne $schemaSequence) { throw 'Missing or misplaced URI schema action.' }
    $v = $db.OpenView('SELECT `Type`, `Source`, `Target` FROM `CustomAction` WHERE `Action` = ''NuvioPartySchema''')
    try {
        $v.Execute()
        $r = $v.Fetch()
        if (!$r) { throw 'Missing NuvioPartySchema custom action.' }
        try {
            if ($r.IntegerData(1) -ne 1 -or $r.StringData(2) -cne $schemaAction -or $r.StringData(3) -cne $schemaAction) {
                throw 'Incorrect NuvioPartySchema custom action contract.'
            }
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
    } finally { Close-MsiView $v }
    $v = $db.OpenView('SELECT `Data` FROM `Binary` WHERE `Name` = ''NuvioPartySchema''')
    try {
        $v.Execute()
        $r = $v.Fetch()
        if (!$r) { throw 'Missing embedded NuvioPartySchema DLL.' }
        try {
            if ($r.DataSize(1) -le 0) { throw 'Empty embedded NuvioPartySchema DLL.' }
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($r) }
    } finally { Close-MsiView $v }

    $stage = 'verifying committed registry contract'
    $v = $db.OpenView('SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`')
    $actual = @{}
    try {
        $v.Execute()
        while ($r = $v.Fetch()) {
            try {
                $key = $r.StringData(3)
                if ($key -match '^(?:Software\\Classes\\)?nuvio(?:\\|$)') {
                    throw "Unexpected shared protocol key in MSI: $key"
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
        if ($entry.Component -cne $component) { throw "Registry row $id does not belong to the Nuvio.exe component." }
    }
    Write-Host 'Windows party protocol: conditional schema action and Family Beta association verified in the MSI. Installed behavior requires a live check.'
} catch {
    $failure = $_.Exception.ToString()
    $detail = $null
    try {
        $errorRecord = $installer.LastErrorRecord()
        if ($null -ne $errorRecord) {
            try { $detail = $errorRecord.FormatText() }
            finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($errorRecord) }
        }
    } catch {
        $detail = "MSI diagnostics unavailable: $($_.Exception.Message)"
    }
    if ($detail) { $failure += "`nWindows Installer: $detail" }
    throw "Windows party protocol failed while ${stage}: $failure"
} finally {
    try {
        if ($null -ne $db) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db) }
    } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer)
    }
}
