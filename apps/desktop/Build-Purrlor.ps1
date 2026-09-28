$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$project = Join-Path $root "Purrlor\Purrlor.csproj"
$installerDir = Join-Path $root "installer"
$distDir = Join-Path $root "dist"
$publishDir = Join-Path $root "Purrlor\bin\Release\net8.0-windows\win-x64\publish"
$bootstrapper = Join-Path $installerDir "MicrosoftEdgeWebview2Setup.exe"

# makensis: on PATH, from the NSIS installer's registry entry, or the default install location.
$nsis = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
if (!$nsis) {
    $nsisDir = (Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\NSIS" -ErrorAction SilentlyContinue).'(default)'
    if ($nsisDir) { $nsis = Join-Path $nsisDir "makensis.exe" }
}
if (!$nsis -or !(Test-Path $nsis)) { $nsis = "C:\Program Files (x86)\NSIS\makensis.exe" }
if (!(Test-Path $nsis)) { throw "NSIS not found. Install it from https://nsis.sourceforge.io or put makensis.exe on PATH." }
if (!(Test-Path (Join-Path $installerDir "purrlor.ico"))) { throw "Installer icon missing: $installerDir\purrlor.ico" }

$version = ([xml](Get-Content $project)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Purrlor.csproj <Version> must be MAJOR.MINOR.PATCH, got '$version'" }

# Microsoft's WebView2 bootstrapper, bundled so the installer can add the runtime on machines
# that lack it. Downloaded at build time (not committed) and only accepted with a valid
# Microsoft signature.
if (!(Test-Path $bootstrapper)) {
    Invoke-WebRequest "https://go.microsoft.com/fwlink/p/?LinkId=2124703" -OutFile $bootstrapper -UseBasicParsing
}
$sig = Get-AuthenticodeSignature $bootstrapper
if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "O=Microsoft Corporation") {
    Remove-Item $bootstrapper -Force
    throw "WebView2 bootstrapper signature check failed ($($sig.Status))."
}

if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }
dotnet publish $project -c Release -r win-x64 --self-contained true /p:PublishSingleFile=false
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
if (!(Test-Path (Join-Path $publishDir "Purrlor.exe"))) { throw "Publish failed: Purrlor.exe was not found in $publishDir" }

Push-Location $installerDir
try {
    & $nsis "/DAPPVERSION=$version" ".\Purrlor.nsi"
    if ($LASTEXITCODE -ne 0) { throw "NSIS failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Write-Host "Done. Purrlor $version installer: $distDir\Purrlor-Setup.exe"
