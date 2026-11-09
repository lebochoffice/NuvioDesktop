[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OfflineBackupDirectory)
$ErrorActionPreference = 'Stop'

$root = Get-Item -LiteralPath $OfflineBackupDirectory
if ($root -isnot [IO.DirectoryInfo]) { throw 'Choose an existing directory on your offline backup drive.' }
for ($directory = $root; $null -ne $directory; $directory = $directory.Parent) {
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Test-Path -LiteralPath (Join-Path $directory.FullName '.git'))) {
        throw 'Keep signing material outside Git checkouts and linked directories.'
    }
}

$subject = 'CN=Nuvio Family Private Code Signing'
if (Get-ChildItem Cert:\CurrentUser\My | Where-Object Subject -CEQ $subject) {
    throw 'A private Family signing identity already exists. Use it or recover its offline backup.'
}
$password = Read-Host 'Enter a strong, unique password for the offline PFX' -AsSecureString
try {
    if ($password.Length -lt 16) { throw 'Use a backup password of at least 16 characters.' }
    $backup = New-Item -ItemType Directory -Path (Join-Path $root.FullName 'Nuvio-Family-Private-Signing')
    $options = @{
        Type = 'CodeSigningCert'
        Subject = $subject
        CertStoreLocation = 'Cert:\CurrentUser\My'
        KeyAlgorithm = 'RSA'
        KeyLength = 3072
        HashAlgorithm = 'SHA256'
        KeyExportPolicy = 'ExportableEncrypted'
        NotAfter = (Get-Date).AddYears(5)
    }
    $certificate = New-SelfSignedCertificate @options
    if (!$certificate.HasPrivateKey -or $certificate.EnhancedKeyUsageList.ObjectId -notcontains '1.3.6.1.5.5.7.3.3') {
        throw 'Expected a private key and the Code Signing EKU.'
    }

    $cer = Join-Path $backup.FullName 'nuvio-family-signing.cer'
    $pfx = Join-Path $backup.FullName 'nuvio-family-signing.pfx'
    Export-Certificate -Cert $certificate -FilePath $cer -Type CERT | Out-Null
    Export-PfxCertificate -Cert $certificate -FilePath $pfx -Password $password -CryptoAlgorithmOption AES256_SHA256 -NoClobber | Out-Null
    $pin = (Get-FileHash -LiteralPath $cer -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $backup.FullName 'certificate-sha256.txt') -Value $pin -Encoding Ascii
    Write-Output "Public certificate SHA-256 pin: $pin"
} finally {
    $password.Dispose()
}
