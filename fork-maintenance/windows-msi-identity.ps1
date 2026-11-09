# Windows fork packaging contract. Keep the name and UpgradeCode in sync with Gradle.
$familyMsiProductName = 'Nuvio Family'
$familyMsiUpgradeCode = [guid]'dfe71c5b-c265-42ce-a025-396193575a13'
$familyMsiLauncher = "$familyMsiProductName.exe"
$familyMsiProgId = 'Nuvio.Family.Party'
$familyMsiCapabilities = 'Software\NuvioFamily\Capabilities'
$familyMsiLaunchCondition = 'Installed OR NOT JP_DOWNGRADABLE_FOUND'
$familyMsiVersionTables = @('InstallUISequence', 'InstallExecuteSequence')

function Close-MsiView($View) {
    try { [void]$View.Close() }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($View) }
}

function Assert-FamilyMsiIdentity($Properties, [string]$Template, [object[]]$UpgradeRules, [string]$ExpectedProductVersion, [switch]$BeforeUpgradePolicy) {
    $upgradeCode = [guid]::Empty
    $productCode = [guid]::Empty
    if ($Properties['ProductName'] -cne $familyMsiProductName -or
        ![guid]::TryParseExact($Properties['UpgradeCode'], 'B', [ref]$upgradeCode) -or $upgradeCode -ne $familyMsiUpgradeCode -or
        ![guid]::TryParseExact($Properties['ProductCode'], 'B', [ref]$productCode) -or
        $productCode -eq [guid]::Empty -or $productCode -eq $upgradeCode) {
        throw 'Unexpected Nuvio Family ProductName, UpgradeCode or ProductCode.'
    }
    if ($Properties['ALLUSERS'] -cne '1') { throw 'Nuvio Family requires a per-machine MSI.' }
    $version = $Properties['ProductVersion']
    if ($version -notmatch '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,5}\z') {
        throw 'MSI ProductVersion must have three numeric fields.'
    }
    $major, $minor, $build = $version.Split('.') | ForEach-Object { [int]$_ }
    if ($major -gt 255 -or $minor -gt 255 -or $build -gt 65535) { throw 'MSI ProductVersion exceeds Windows Installer limits.' }
    if ($ExpectedProductVersion -and $version -cne $ExpectedProductVersion) {
        throw 'MSI ProductVersion differs from the expected release version.'
    }
    if ($Template.Split(';')[0] -ine 'x64') { throw 'Expected an x64 MSI Template Summary.' }

    $seen = @{}
    foreach ($rule in $UpgradeRules) {
        $rowCode = [guid]::Empty
        if (![guid]::TryParseExact($rule.UpgradeCode, 'B', [ref]$rowCode) -or $rowCode -ne $upgradeCode) {
            throw 'MSI Upgrade table contains a rule outside the Nuvio Family upgrade family.'
        }
        # VersionMinInclusive has no effect when VersionMin is SQL NULL.
        $isOlder = $rule.Action -ceq 'JP_UPGRADABLE_FOUND' -and $null -eq $rule.Min -and $rule.Max -ceq $version -and
            $rule.Attributes -in @(1, 257)
        # Require OnlyDetect and an inclusive minimum. Raw jpackage output is allowed only before authoring.
        $isNewer = $rule.Action -ceq 'JP_DOWNGRADABLE_FOUND' -and $rule.Min -ceq $version -and $null -eq $rule.Max -and
            ($rule.Attributes -eq 258 -or ($BeforeUpgradePolicy -and $rule.Attributes -eq 1))
        if ((!$isOlder -and !$isNewer) -or $seen.ContainsKey($rule.Action) -or $rule.Language -or !$rule.RemovesAll) {
            throw 'MSI Upgrade table contains an unexpected version range, removal policy or action.'
        }
        $seen[$rule.Action] = $true
    }
    if (!$seen.ContainsKey('JP_UPGRADABLE_FOUND')) { throw 'MSI lacks a removal rule for earlier Nuvio Family releases.' }
    if (!$seen.ContainsKey('JP_DOWNGRADABLE_FOUND')) { throw 'MSI lacks a detection rule for equal or newer Nuvio Family releases.' }
    $secure = ([string]$Properties['SecureCustomProperties']).Split(';')
    if ('JP_UPGRADABLE_FOUND' -cnotin $secure -or 'JP_DOWNGRADABLE_FOUND' -cnotin $secure) {
        throw 'MSI upgrade detection properties must be available in the elevated execute sequence.'
    }
}

function Get-FamilyMsiSequence($Database, [ValidateSet('InstallUISequence', 'InstallExecuteSequence')][string]$Table) {
    $view = $Database.OpenView(('SELECT `Action`, `Condition`, `Sequence` FROM `{0}`' -f $Table))
    $sequence = @{}
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try {
                $sequence[$record.StringData(1)] = @{ Condition = $record.StringData(2); Number = $record.IntegerData(3) }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
    return $sequence
}

function Test-MsiTable($Database, [string]$Name) {
    $view = $Database.OpenView(('SELECT `Name` FROM `_Tables` WHERE `Name` = ''{0}''' -f $Name))
    try {
        [void]$view.Execute()
        $record = $view.Fetch()
        if (!$record) { return $false }
        try { return $true }
        finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
    } finally { Close-MsiView $view }
}

function Assert-FamilyMsiLaunchSequence($Sequence, [string]$Table) {
    $find = $Sequence['FindRelatedProducts']
    $extended = $Sequence['JpFindRelatedProducts']
    $launch = $Sequence['LaunchConditions']
    if (!$find -or $find.Number -le 0 -or $find.Condition -or !$launch -or
        $launch.Condition -or $launch.Number -le $find.Number -or
        ($extended -and ($extended.Condition -or $extended.Number -le $find.Number -or $extended.Number -ge $launch.Number)) -or
        @($Sequence.Values | Where-Object Number -eq $launch.Number).Count -ne 1) {
        throw "MSI LaunchConditions must run unconditionally after upgrade detection in $Table."
    }
    foreach ($name in @('CostInitialize', 'InstallValidate', 'InstallInitialize', 'RemoveExistingProducts', 'InstallFiles')) {
        $action = $Sequence[$name]
        if (($Table -eq 'InstallExecuteSequence' -and !$action) -or
            ($action -and $action.Number -le $launch.Number)) {
            throw "MSI LaunchConditions must precede $name in $Table."
        }
    }
    if ($Table -eq 'InstallExecuteSequence') {
        $validate = $Sequence['InstallValidate']
        $remove = $Sequence['RemoveExistingProducts']
        $initialize = $Sequence['InstallInitialize']
        if ($validate.Condition -or $remove.Condition -or $initialize.Condition -or
            $remove.Number -le $validate.Number -or $remove.Number -ge $initialize.Number -or
            @($Sequence.Values | Where-Object Number -eq $remove.Number).Count -ne 1) {
            throw 'MSI RemoveExistingProducts must run between InstallValidate and InstallInitialize.'
        }
    }
}

function Assert-FamilyMsiDeclarativeGuard($Database) {
    $found = $false
    $view = $Database.OpenView('SELECT `Condition` FROM `LaunchCondition`')
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try { if ($record.StringData(1) -ceq $familyMsiLaunchCondition) { $found = $true } }
            finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
    if (!$found) { throw 'Missing MSI launch condition blocking equal or newer Nuvio Family releases.' }

    foreach ($table in $familyMsiVersionTables) {
        $sequence = Get-FamilyMsiSequence $Database $table
        if ($sequence.ContainsKey('NuvioFamilyBlockSameOrNewer') -or $sequence.ContainsKey('NuvioPartySchema')) {
            throw "Unexpected legacy native Family action in $table."
        }
        Assert-FamilyMsiLaunchSequence $sequence $table
    }
    foreach ($sql in @(
        'SELECT `Action` FROM `CustomAction` WHERE `Action` = ''NuvioFamilyBlockSameOrNewer'' OR `Action` = ''NuvioPartySchema'' OR `Source` = ''NuvioPartySchema''',
        'SELECT `Name` FROM `Binary` WHERE `Name` = ''NuvioPartySchema'''
    )) {
        $view = $Database.OpenView($sql)
        try {
            [void]$view.Execute()
            $record = $view.Fetch()
            if ($record) {
                try { throw 'Unexpected legacy native Family action or DLL in MSI.' }
                finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
            }
        } finally { Close-MsiView $view }
    }
    if (Test-MsiTable $Database 'RemoveRegistry') { throw 'Unexpected MSI RemoveRegistry table.' }
}

function Get-VerifiedFamilyMsiProperties($Database, [string]$ExpectedProductVersion, [switch]$BeforeUpgradePolicy) {
    $properties = @{}
    $view = $Database.OpenView('SELECT `Property`, `Value` FROM `Property`')
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try { $properties[$record.StringData(1)] = $record.StringData(2) }
            finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }

    $summary = $Database.SummaryInformation(0)
    try { $template = [string]$summary.Property(7) }
    finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($summary) }

    $view = $Database.OpenView('SELECT `UpgradeCode`, `Attributes`, `VersionMin`, `VersionMax`, `Language`, `Remove`, `ActionProperty` FROM `Upgrade`')
    try {
        [void]$view.Execute()
        $rules = @(while ($record = $view.Fetch()) {
            try {
                @{
                    UpgradeCode = $record.StringData(1); Attributes = $record.IntegerData(2)
                    Min = if (!$record.IsNull(3)) { $record.StringData(3) } else { $null }
                    Max = if (!$record.IsNull(4)) { $record.StringData(4) } else { $null }
                    Language = $record.StringData(5)
                    RemovesAll = $record.IsNull(6) -or $record.StringData(6) -ceq 'ALL'
                    Action = $record.StringData(7)
                }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        })
    } finally { Close-MsiView $view }
    Assert-FamilyMsiIdentity $properties $template $rules $ExpectedProductVersion -BeforeUpgradePolicy:$BeforeUpgradePolicy
    if (!$BeforeUpgradePolicy) { Assert-FamilyMsiDeclarativeGuard $Database }

    $view = $Database.OpenView('SELECT `DefaultDir`, `Directory_Parent` FROM `Directory` WHERE `Directory` = ''INSTALLDIR''')
    try {
        [void]$view.Execute()
        $record = $view.Fetch()
        if (!$record) { throw 'MSI is missing the INSTALLDIR directory.' }
        try {
            $targetName = $record.StringData(1).Split(':')[0].Split('|')[-1]
            if ($targetName -cne $familyMsiProductName -or $record.StringData(2) -cne 'ProgramFiles64Folder') {
                throw 'MSI INSTALLDIR does not target the Nuvio Family directory under 64-bit Program Files.'
            }
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
    } finally { Close-MsiView $view }

    $view = $Database.OpenView('SELECT `File`.`FileName` FROM `File`, `Component` WHERE `File`.`Component_` = `Component`.`Component` AND `Component`.`Directory_` = ''INSTALLDIR''')
    $launcherCount = 0
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try {
                if ($record.StringData(1).Split('|')[-1] -ceq $familyMsiLauncher) { $launcherCount++ }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
    if ($launcherCount -ne 1) { throw 'MSI must contain exactly one Nuvio Family launcher in INSTALLDIR.' }

    return $properties
}
