# Private Windows signing

Use Windows PowerShell and the Windows SDK Signing Tools. Create a separate identity from the Lab certificate.

## One-time setup

Connect an offline backup drive and choose an existing folder outside Git and cloud-synced storage. The script creates a new subfolder, stores the private key in the current user's personal certificate store, and writes an AES-encrypted PFX backup. Keep the password separately and disconnect the drive after setup.

    .\fork-maintenance\new-private-windows-signing-certificate.ps1 -OfflineBackupDirectory 'E:\OfflineBackup'

Keep a copy of the public .cer and its SHA-256 pin outside the checkout. Compare the DER certificate hash to the pin recorded at creation before importing it. The import trusts that certificate as a root for this Windows user. Approve the Windows trust prompt only for the matching certificate.

    $cer = 'C:\PrivateSigning\nuvio-family-signing.cer'
    $pin = '<64-character public pin recorded at creation>'
    if ((Get-FileHash -LiteralPath $cer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin) {
        throw 'Unexpected signing certificate.'
    }
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root

To recover the identity, import the offline PFX into Cert:\CurrentUser\My using the original password. Omit -Exportable on restore. Compare the restored certificate against the recorded pin and reestablish public trust if needed. A newly generated certificate has a different pin.

    $password = Read-Host 'Offline PFX password' -AsSecureString
    try {
        Import-PfxCertificate -FilePath 'E:\OfflineBackup\Nuvio-Family-Private-Signing\nuvio-family-signing.pfx' -CertStoreLocation Cert:\CurrentUser\My -Password $password | Out-Null
    } finally {
        $password.Dispose()
    }

Keep the PFX and password out of Git, GitHub Secrets and release assets. If setup is interrupted after creating the certificate, recover or finish backing up that same identity before creating another.

## For each private MSI

Complete MSI postprocessing first. Use a fresh unsigned Family MSI, its numeric Windows product version, the verified public pin, and an approved RFC 3161 endpoint. Prefer HTTPS when SignTool accepts it. If SignTool rejects HTTPS URLs, use the documented Microsoft endpoint below. It is the only HTTP endpoint the script accepts, with or without the trailing slash. Keep the MSI private.

    $ErrorActionPreference = 'Stop'
    $msi = 'C:\PrivateSigning\Nuvio-Family.msi'
    $version = '<MSI product version>'
    $pin = '<64-character public SHA-256 pin>'
    $timestampUrl = 'http://timestamp.acs.microsoft.com'
    .\fork-maintenance\verify-msi.ps1 -MsiPath $msi -ExpectedProductVersion $version
    .\fork-maintenance\sign-family-release.ps1 -MsiPath $msi -TimestampUrl $timestampUrl -LocalSignerSha256 $pin
    Get-FileHash -LiteralPath $msi -Algorithm SHA256

SignTool verifies the final signature, and the app's Authenticode verifier checks the exact signer and requires a timestamp. Stop on any verification failure. The timestamp authority receives the timestamp request, with no MSI or private key upload. The local pin applies only to the signing script. The bundled app pin remains empty and installation remains disabled.

The existing GitHub release source cannot discover private local MSI files. A private update source and a separate activation decision are required before in-app installation.
