[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$MsiPath,
    [Parameter(Mandatory = $true)][string]$TimestampUrl
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-update-trust.ps1')
if ($familySignerSha256 -cnotmatch '^[a-f0-9]{64}\z') { throw 'The trusted Fork signing certificate pin is not configured.' }
$timestamp = [uri]$TimestampUrl
if (!$timestamp.IsAbsoluteUri -or $timestamp.Scheme -ne 'https' -or !$timestamp.Host -or $timestamp.UserInfo) {
    throw 'An approved HTTPS RFC 3161 timestamp endpoint is required.'
}

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $certificates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
        $_.HasPrivateKey -and [BitConverter]::ToString($sha256.ComputeHash($_.RawData)).Replace('-', '').ToLowerInvariant() -ceq $familySignerSha256
    })
} finally { $sha256.Dispose() }
if ($certificates.Count -ne 1) { throw 'The approved Fork signing identity is unavailable in the runner certificate store.' }

$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$tool = Get-ChildItem -LiteralPath $sdkBin -Directory | Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (!$tool) { throw 'Windows SDK SignTool is unavailable.' }
$msi = (Get-Item -LiteralPath $MsiPath).FullName
& $tool sign /sha1 $certificates[0].Thumbprint /fd SHA256 /tr $timestamp.AbsoluteUri /td SHA256 $msi
if ($LASTEXITCODE -ne 0) { throw 'MSI signing failed.' }
& $tool verify /pa /all /tw $msi
if ($LASTEXITCODE -ne 0) { throw 'MSI signature or timestamp verification failed.' }
Assert-FamilyMsiSignature $msi
