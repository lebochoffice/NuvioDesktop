# Populate this public SHA-256 pin only after authenticating the Fork code-signing certificate.
$familySignerSha256 = ''

function Assert-FamilyMsiSignature([string]$MsiPath) {
    if ($familySignerSha256 -cnotmatch '^[a-f0-9]{64}\z') { throw 'Fork signing certificate is not configured.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $MsiPath
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
        !$signature.SignerCertificate -or !$signature.TimeStamperCertificate) {
        throw 'Expected a valid timestamped Authenticode signature.'
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $certificateHash = [BitConverter]::ToString($sha256.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant()
    } finally { $sha256.Dispose() }
    if ($certificateHash -cne $familySignerSha256) { throw 'MSI signer does not match the pinned Fork certificate.' }
}
