# Bundled after the identity and trust scripts. All input comes from the calling process.
$ErrorActionPreference = 'Stop'
function Get-VerifiedFamilyUpdate {
    $msi = $env:NUVIO_VERIFY_UPDATE_PATH
    if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant() -cne $env:NUVIO_VERIFY_UPDATE_SHA256) {
        throw 'Update checksum does not match the release.'
    }
    Assert-FamilyMsiSignature $msi
    $installer = New-Object -ComObject WindowsInstaller.Installer
    try {
        $db = $installer.OpenDatabase($msi, 0)
        try { $properties = Get-VerifiedFamilyMsiProperties $db $env:NUVIO_VERIFY_UPDATE_VERSION }
        finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db) }

        $related = $installer.RelatedProducts($familyMsiUpgradeCode.ToString('B').ToUpperInvariant())
        try {
            if ($related.Count -ne 1) { throw 'Exactly one installed Nuvio Family product is required.' }
            $installed = $related.Item(0)
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($related) }
        $installedVersion = $installer.ProductInfo($installed, 'VersionString')
        $location = $installer.ProductInfo($installed, 'InstallLocation')
        if (!$location -or $installer.ProductState($installed) -ne 5 -or
            $installer.ProductInfo($installed, 'InstalledProductName') -cne $familyMsiProductName -or
            $installedVersion -cne $env:NUVIO_VERIFY_INSTALLED_VERSION -or
            [version]$properties['ProductVersion'] -le [version]$installedVersion -or
            [guid]$properties['ProductCode'] -eq [guid]$installed) {
            throw 'The package is not an upgrade for the installed Nuvio Family product.'
        }
        $launcher = Get-Item -LiteralPath (Join-Path $location $familyMsiLauncher)
        if ($launcher.PSIsContainer -or $launcher.FullName -ine $env:NUVIO_VERIFY_RUNNING_LAUNCHER) {
            throw 'The running launcher does not match the installed Nuvio Family product.'
        }
        return $properties
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }
}
