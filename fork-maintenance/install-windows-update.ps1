# Runs in a separate, non-elevated process after the confirmed desktop handoff.
$ErrorActionPreference = 'Stop'
$directory = $env:NUVIO_UPDATE_HANDOFF
$result = Join-Path (Split-Path -Parent $directory) 'result'
$gate = Join-Path (Split-Path -Parent $directory) 'instance.lock'
$launcherName = [IO.Path]::GetFileNameWithoutExtension($familyMsiLauncher)
$exitCode = $null
$stage = 'handoff'
$outcome = 'failed'
$armed = $false
$lease = $null

function Assert-NoOtherFamilyProcess([int]$AllowedId) {
    foreach ($process in [Diagnostics.Process]::GetProcessesByName($launcherName)) {
        try {
            if ($process.Id -ne $AllowedId -and !$process.HasExited) {
                throw 'Another Nuvio Family process is running.'
            }
        } finally { $process.Dispose() }
    }
}

try {
    $parent = [Diagnostics.Process]::GetProcessById([int]$env:NUVIO_UPDATE_PARENT)
    try {
        # Open the handle before signaling readiness, so PID reuse cannot change the wait target.
        $null = $parent.Handle
        try { Assert-NoOtherFamilyProcess $parent.Id }
        catch {
            [IO.File]::WriteAllText((Join-Path $directory 'other-instance'), '')
            throw
        }
        [IO.File]::WriteAllText((Join-Path $directory 'ready'), '')
        if (!$parent.WaitForExit(30000)) { throw 'Nuvio Family did not close.' }
    } finally { $parent.Dispose() }
    $armed = [IO.File]::Exists((Join-Path $directory 'armed'))
    if (!$armed) { return }
    $lease = [IO.File]::Open($gate, 'Open', 'ReadWrite', 'None')
    Assert-NoOtherFamilyProcess 0
    $msi = $env:NUVIO_VERIFY_UPDATE_PATH
    # Deny writes and replacement until Windows Installer has finished reading the file.
    $package = [IO.File]::Open($msi, 'Open', 'Read', 'Read')
    try {
        $stage = 'verification'
        $verified = Get-VerifiedFamilyUpdate
        $stage = 'installer'
        Assert-NoOtherFamilyProcess 0
        $tool = Join-Path ([Environment]::SystemDirectory) 'msiexec.exe'
        $installerProcess = Start-Process -FilePath $tool -ArgumentList ('/i "' + $msi + '" /norestart') -Wait -PassThru
        try { $exitCode = $installerProcess.ExitCode } finally { $installerProcess.Dispose() }
        if ($exitCode -eq 1602) {
            $outcome = 'cancelled'
        } elseif ($exitCode -in @(0, 3010, 1641)) {
            $stage = 'registration'
            $registration = New-Object -ComObject WindowsInstaller.Installer
            try {
                $related = $registration.RelatedProducts($familyMsiUpgradeCode.ToString('B').ToUpperInvariant())
                try {
                    $product = $verified['ProductCode']
                    if ($related.Count -ne 1 -or $related.Item(0) -ine $product -or
                        $registration.ProductState($product) -ne 5 -or
                        $registration.ProductInfo($product, 'VersionString') -cne $verified['ProductVersion']) {
                        throw 'The expected Family version was not registered.'
                    }
                } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($related) }
            } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($registration) }
            $outcome = if ($exitCode -eq 0) { 'installed' } else { 'restart' }
        }
    } finally { $package.Dispose() }
} catch {
    # No paths, command lines, environment values or exception text in the result.
} finally {
    try {
        if ($armed -or [IO.File]::Exists((Join-Path $directory 'armed'))) {
            $temporaryResult = Join-Path $directory 'result'
            [IO.File]::WriteAllText($temporaryResult, "$outcome|${stage}|$exitCode")
            if ([IO.File]::Exists($result)) {
                $priorResult = Join-Path $directory 'prior-result'
                [IO.File]::Replace($temporaryResult, $result, $priorResult)
                [IO.File]::Delete($priorResult)
            } else { [IO.File]::Move($temporaryResult, $result) }
            [IO.File]::Delete((Join-Path $directory 'armed'))
            [IO.File]::Delete((Join-Path $directory 'ready'))
            [IO.Directory]::Delete($directory)
        }
    } finally { if ($lease) { $lease.Dispose() } }
}
