[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [switch]$RequireConfigured
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoPath).Path
$propertiesFile = Join-Path $repo 'local.properties'
$properties = @{}

function ConvertFrom-JavaPropertyEscape([string]$Text) {
    [regex]::Replace($Text, '\\(u[0-9a-fA-F]{4}|.)', {
        param($match)
        $escaped = $match.Groups[1].Value
        if ($escaped.StartsWith('u') -and $escaped.Length -eq 5) {
            return [string][char][Convert]::ToInt32($escaped.Substring(1), 16)
        }
        switch ($escaped) {
            't' { return "`t" }
            'n' { return "`n" }
            'r' { return "`r" }
            'f' { return [string][char]12 }
            default { return $escaped }
        }
    })
}

# Match java.util.Properties: ISO-8859-1, escaped separators and continuation.
# Only this project-local file is read. No environment or external credential search.
if (Test-Path -LiteralPath $propertiesFile) {
    $pending = ''
    foreach ($physicalLine in [IO.File]::ReadAllLines($propertiesFile, [Text.Encoding]::GetEncoding(28591))) {
        $line = $pending + $physicalLine.TrimStart()
        $slashes = [regex]::Match($line, '\\*$').Length
        if ($slashes % 2 -eq 1) {
            $pending = $line.Substring(0, $line.Length - 1)
            continue
        }
        $pending = ''
        if ($line -match '^\s*[#!]' -or [string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^((?:\\.|[^\\\s=:])+)(?:\s*[:=]\s*|\s+)(.*)$') {
            $propertyName = ConvertFrom-JavaPropertyEscape $matches[1]
            $properties[$propertyName] = ConvertFrom-JavaPropertyEscape $matches[2]
        }
    }
}

function Test-PublicClientId([string]$Name) {
    $value = [string]$properties[$Name]
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    if ($value -match '(?i)^(your[_ -]|change[_ -]?me|placeholder|<|sb_secret_)') { return $false }
    return $value -match '^[A-Za-z0-9_-]+$'
}

$redirect = $null
$redirectReady = [Uri]::TryCreate([string]$properties['TRAKT_REDIRECT_URI'], [UriKind]::Absolute, [ref]$redirect)
if ($redirectReady) {
    $redirectReady = $redirect.Scheme -eq 'https' -and $redirect.Host -and
        -not $redirect.UserInfo -and -not $redirect.Fragment -and -not $redirect.IsLoopback
}
$ready = [ordered]@{
    Trakt = ((Test-PublicClientId 'TRAKT_CLIENT_ID') -and $redirectReady)
    Simkl = (Test-PublicClientId 'SIMKL_CLIENT_ID')
    MDBList = (Test-PublicClientId 'MDBLIST_CLIENT_ID')
}
foreach ($provider in $ready.Keys) {
    $status = if ($ready[$provider]) { 'KONFIGURIERT' } else { 'FEHLT' }
    Write-Output ("${provider}: $status")
}
if ($RequireConfigured -and $ready.Values -contains $false) {
    throw 'Tracking-Konfiguration unvollstaendig. Eigene App-IDs und registrierte Trakt-HTTPS-Redirect-URI in local.properties eintragen.'
}
