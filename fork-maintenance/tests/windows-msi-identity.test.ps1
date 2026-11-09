# Exercises the package policy without opening or creating an MSI.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../windows-msi-identity.ps1')

function Assert-Rejected([scriptblock]$Check, [string]$ExpectedMessage) {
    try { & $Check }
    catch {
        if ($_.Exception.Message -like $ExpectedMessage) { return }
        throw
    }
    throw "Expected rejection: $ExpectedMessage"
}

$pinnedUpgradeCode = '{DFE71C5B-C265-42CE-A025-396193575A13}'
$legacyUpgradeCode = '{395990EE-9B8A-3548-922C-E7A23A495B8D}'
$gradle = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../composeApp/build.gradle.kts') -Raw
$gradleUpgradeCode = [regex]::Match($gradle, '(?m)^val windowsMsiUpgradeUuid = "([^"]+)"').Groups[1].Value
$gradleProductName = [regex]::Match($gradle, '(?m)^val windowsMsiProductName = "([^"]+)"').Groups[1].Value
if ($familyMsiUpgradeCode -ne [guid]$pinnedUpgradeCode -or [guid]$gradleUpgradeCode -ne $familyMsiUpgradeCode -or
    $gradleProductName -cne 'Nuvio Family' -or $familyMsiProductName -cne $gradleProductName -or
    $familyMsiLauncher -cne 'Nuvio Family.exe' -or $familyMsiProgId -cne 'Nuvio.Family.Party') {
    throw 'The fork packaging and verification identities must match the pinned Family identity.'
}

$properties = @{
    ProductName = 'Nuvio Family'; ProductCode = '{A60F00D2-B0C9-418B-8D2D-58AD80B58A6C}'
    UpgradeCode = $pinnedUpgradeCode; ProductVersion = '1.1.63'
    ALLUSERS = '1'
    SecureCustomProperties = 'JP_UPGRADABLE_FOUND;JP_DOWNGRADABLE_FOUND'
}
$older = @{
    UpgradeCode = $pinnedUpgradeCode; Min = $null; Max = '1.1.63'; Attributes = 257
    Language = ''; RemovesAll = $true; Action = 'JP_UPGRADABLE_FOUND'
}
$newer = $older.Clone()
$newer.Min = '1.1.63'
$newer.Max = $null
$newer.Attributes = 258
$newer.Action = 'JP_DOWNGRADABLE_FOUND'
$rules = @($older, $newer)
Assert-FamilyMsiIdentity $properties 'x64;1033' $rules '1.1.63'

foreach ($change in @(
    @{ Key = 'ProductName'; Value = 'Nuvio' }
    @{ Key = 'UpgradeCode'; Value = $legacyUpgradeCode }
    @{ Key = 'ProductCode'; Value = $pinnedUpgradeCode }
    @{ Key = 'ProductCode'; Value = 'invalid' }
)) {
    $invalid = $properties.Clone()
    $invalid[$change.Key] = $change.Value
    Assert-Rejected { Assert-FamilyMsiIdentity $invalid 'x64;1033' $rules } 'Unexpected Nuvio Family*'
}
foreach ($invalidVersion in @('', '1.1.63.0', '256.1.63', '1.1.65536')) {
    $invalid = $properties.Clone()
    $invalid.ProductVersion = $invalidVersion
    Assert-Rejected { Assert-FamilyMsiIdentity $invalid 'x64;1033' $rules } 'MSI ProductVersion*'
}
Assert-Rejected { Assert-FamilyMsiIdentity $properties 'x64;1033' $rules '1.1.62' } 'MSI ProductVersion differs*'
Assert-Rejected { Assert-FamilyMsiIdentity $properties 'Intel;1033' $rules } 'Expected an x64 MSI*'
Assert-Rejected { Assert-FamilyMsiIdentity $properties 'Arm64;1033' $rules } 'Expected an x64 MSI*'
Assert-Rejected { Assert-FamilyMsiIdentity $properties 'x64;1033' @($newer) } 'MSI lacks a removal rule*'

$foreign = $newer.Clone()
$foreign.UpgradeCode = $legacyUpgradeCode
Assert-Rejected { Assert-FamilyMsiIdentity $properties 'x64;1033' @($older, $foreign) } 'MSI Upgrade table contains a rule outside*'
foreach ($change in @(
    @{ Key = 'Max'; Value = '1.1.64' }
    @{ Key = 'Attributes'; Value = 0x201 }
    @{ Key = 'Attributes'; Value = 5 }
    @{ Key = 'RemovesAll'; Value = $false }
)) {
    $invalid = $older.Clone()
    $invalid[$change.Key] = $change.Value
    Assert-Rejected { Assert-FamilyMsiIdentity $properties 'x64;1033' @($invalid, $newer) } 'MSI Upgrade table contains an unexpected*'
}
$sequence = @{
    FindRelatedProducts = @{ Number = 25; Condition = '' }
    JpFindRelatedProducts = @{ Number = 26; Condition = '' }
    LaunchConditions = @{ Number = 27; Condition = '' }
    CostInitialize = @{ Number = 800; Condition = '' }
    InstallValidate = @{ Number = 1400; Condition = '' }
    RemoveExistingProducts = @{ Number = 1401; Condition = '' }
    InstallInitialize = @{ Number = 1500; Condition = '' }
    InstallFiles = @{ Number = 4000; Condition = '' }
}
Assert-FamilyMsiLaunchSequence $sequence 'InstallExecuteSequence'
foreach ($launch in @(@{ Number = 24; Condition = '' }, @{ Number = 27; Condition = 'Installed' })) {
    $bad = $sequence.Clone()
    $bad.LaunchConditions = $launch
    Assert-Rejected { Assert-FamilyMsiLaunchSequence $bad 'InstallExecuteSequence' } 'MSI LaunchConditions must run unconditionally*'
}
$bad = $sequence.Clone()
$bad.RemoveExistingProducts = @{ Number = 1501; Condition = '' }
Assert-Rejected { Assert-FamilyMsiLaunchSequence $bad 'InstallExecuteSequence' } 'MSI RemoveExistingProducts must run between*'
if ($familyMsiLaunchCondition -cne 'Installed OR NOT JP_DOWNGRADABLE_FOUND') {
    throw 'Expected a launch condition that blocks a new package and permits maintenance.'
}
Write-Host 'Nuvio Family MSI identity policy checks passed.'
