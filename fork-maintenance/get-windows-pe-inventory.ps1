# Read-only PE inventory. Run in Windows PowerShell 5.1.
[CmdletBinding()]
param(
    [string]$AppImage,
    [Parameter(Mandatory = $true)][string]$MsiPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-msi-identity.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Test-PeFile([string]$Path) {
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($Path))
    try {
        if ($reader.BaseStream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { return $false }
        $reader.BaseStream.Position = 60
        $offset = $reader.ReadInt32()
        if ($offset -lt 64 -or $offset -gt ($reader.BaseStream.Length - 4)) { return $false }
        $reader.BaseStream.Position = $offset
        return $reader.ReadUInt32() -eq 0x00004550
    } finally { $reader.Dispose() }
}

function Get-PeInventoryRow([string]$Path, [string]$Origin, [string]$Location, [string]$Execution) {
    if (!(Test-PeFile $Path)) { return }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    $signer = $null
    $signerSha256 = $null
    if ($signature.SignerCertificate) {
        $signer = $signature.SignerCertificate.Subject
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $signerSha256 = [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    }
    [pscustomobject]@{
        origin = $Origin
        location = $Location
        execution = $Execution
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        signature = [string]$signature.Status
        signatureType = [string]$signature.SignatureType
        signer = $signer
        signerSha256 = $signerSha256
        timestampPresent = [bool]$signature.TimeStamperCertificate
    }
}

function Read-MsiRows($Database, [string]$Table, [int]$Columns) {
    $view = $Database.OpenView(('SELECT * FROM {0}{1}{0}' -f [char]96, $Table))
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try {
                $row = @(for ($i = 1; $i -le $Columns; $i++) { $record.StringData($i) })
                ,$row
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
        }
    } finally { Close-MsiView $view }
}

$root = if ($AppImage) { Get-Item -LiteralPath $AppImage }
$msi = Get-Item -LiteralPath $MsiPath
if (($root -and !$root.PSIsContainer) -or $msi.PSIsContainer -or $msi.Extension -ine '.msi') { throw 'Expected an app-image directory and an MSI file.' }
if ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'App-image root must not be a reparse point.' }
$msiHash = (Get-FileHash -LiteralPath $msi.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
# One temporary filename under a new directory. Never execute an extracted file.
$scratch = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N')))
$sample = Join-Path $scratch.FullName 'payload.dll'
try {
    $imageFiles = if ($root) { Get-ChildItem -LiteralPath $root.FullName -File -Recurse -Force }
    $imagePe = @(foreach ($file in $imageFiles) {
        if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected app-image reparse point.' }
        $relative = $file.FullName.Substring($root.FullName.Length + 1)
        Get-PeInventoryRow $file.FullName 'app-image' $relative 'launcher or loadable image'
        if ($file.Extension -ine '.jar') { continue }
        $archiveHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $archive = [IO.Compression.ZipFile]::OpenRead($file.FullName)
        try {
            foreach ($entry in $archive.Entries) {
                if ($entry.Length -lt 2) { continue }
                if ($entry.FullName -match '\.jar$') { throw "Nested JAR requires separate inventory: $relative!/$($entry.FullName)" }
                $stream = $entry.Open()
                try {
                    if ($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { continue }
                } finally { $stream.Dispose() }
                $stream = $entry.Open()
                try {
                    $output = [IO.File]::Create($sample)
                    try { $stream.CopyTo($output) } finally { $output.Dispose() }
                } finally { $stream.Dispose() }
                $row = Get-PeInventoryRow $sample 'jar-resource' "$relative!/$($entry.FullName)" 'loadable after extraction'
                if ($row) {
                    $row | Add-Member -NotePropertyName archiveSha256 -NotePropertyValue $archiveHash -PassThru
                }
            }
        } finally { $archive.Dispose() }
    })

    $installer = New-Object -ComObject WindowsInstaller.Installer
    try {
        $db = $installer.OpenDatabase($msi.FullName, 0)
        try {
            $tables = @(Read-MsiRows $db '_Tables' 1 | ForEach-Object { $_[0] })
            $actions = @(if ('CustomAction' -in $tables) {
                foreach ($row in Read-MsiRows $db 'CustomAction' 4) {
                    [pscustomobject]@{ name = $row[0]; type = [int]$row[1]; source = $row[2]; target = $row[3] }
                }
            })
            $schedule = @(foreach ($table in 'InstallUISequence','InstallExecuteSequence','AdminUISequence','AdminExecuteSequence','AdvtExecuteSequence') {
                if ($table -notin $tables) { continue }
                foreach ($row in Read-MsiRows $db $table 3) {
                    if ($row[0] -in $actions.name) {
                        [pscustomobject]@{ location = $table; action = $row[0]; condition = $row[1]; order = $row[2] }
                    }
                }
            })
            $controls = @(if ('ControlEvent' -in $tables) {
                foreach ($row in Read-MsiRows $db 'ControlEvent' 6) {
                    if ($row[2] -eq 'DoAction') {
                        [pscustomobject]@{ location = "$($row[0])/$($row[1])"; action = $row[3]; condition = $row[4]; order = $row[5] }
                    }
                }
            })
            $binaryPe = @(if ('Binary' -in $tables) {
                $view = $db.OpenView(('SELECT {0}Name{0}, {0}Data{0} FROM {0}Binary{0}' -f [char]96))
                try {
                    [void]$view.Execute()
                    while ($record = $view.Fetch()) {
                        try {
                            $name = $record.StringData(1)
                            $length = $record.DataSize(2)
                            if ($length -lt 2) { continue }
                            $header = $record.ReadStream(2, 2, 1)
                            if ($header -cne 'MZ') { continue }
                            $raw = $record.ReadStream(2, $length - 2, 1)
                            if ($raw.Length -ne $length - 2) { throw "Incomplete MSI stream: $name" }
                            $bytes = [byte[]]::new($length)
                            $bytes[0] = 77
                            $bytes[1] = 90
                            for ($n = 2; $n -lt $length; $n++) { $bytes[$n] = [byte][char]$raw[$n - 2] }
                            [IO.File]::WriteAllBytes($sample, $bytes)
                            $refs = @($actions | Where-Object { ($_.type -band 63) -in 1,2 -and $_.source -ceq $name })
                            $execution = if ($refs.Count) { $refs.name -join ', ' } else { 'PE stream with no direct Binary action reference' }
                            Get-PeInventoryRow $sample 'msi-binary' "Binary/$name" $execution
                        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($record) }
                    }
                } finally { Close-MsiView $view }
            })
        } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($db) }
    } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($installer) }

    if ((Get-FileHash -LiteralPath $msi.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $msiHash) { throw 'MSI changed during inventory.' }
    [pscustomobject]@{
        schema = 1
        appImageScanned = [bool]$root
        msiSha256 = $msiHash
        peFiles = @($imagePe + $binaryPe)
        customActions = $actions
        actionReferences = @($schedule + $controls)
    } | ConvertTo-Json -Depth 6
} finally {
    if ([IO.File]::Exists($sample)) { [IO.File]::Delete($sample) }
    [IO.Directory]::Delete($scratch.FullName)
}
