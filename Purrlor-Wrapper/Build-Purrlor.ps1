$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$project = Join-Path $root "Purrlor\Purrlor.csproj"
$installerDir = Join-Path $root "installer"
$distDir = Join-Path $root "dist"
$publishDir = Join-Path $root "Purrlor\bin\Release\net8.0-windows\win-x64\publish"
$nsis = "C:\Program Files (x86)\NSIS\makensis.exe"

if (!(Test-Path $nsis)) { throw "NSIS not found at $nsis" }
if (!(Test-Path (Join-Path $installerDir "purrlor.ico"))) { throw "Installer icon missing: $installerDir\purrlor.ico" }
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

dotnet clean $project -c Release
dotnet publish $project -c Release -r win-x64 --self-contained true /p:PublishSingleFile=false
if (!(Test-Path (Join-Path $publishDir "Purrlor.exe"))) { throw "Publish failed: Purrlor.exe was not found in $publishDir" }

Push-Location $installerDir
try {
    & $nsis ".\Purrlor.nsi"
    if ($LASTEXITCODE -ne 0) { throw "NSIS failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

Write-Host "Done. Installer: $distDir\Purrlor-Setup.exe"
