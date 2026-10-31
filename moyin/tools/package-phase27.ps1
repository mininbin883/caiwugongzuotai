$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releaseRoot = Join-Path $root 'release31-v2.7.0'
$appSource = (Resolve-Path (Join-Path $releaseRoot 'win-unpacked')).Path
$runtimeSource = (Resolve-Path (Join-Path $root 'runtime-packs/rapidocr-python-win-x64-v1')).Path
$appZip = Join-Path $releaseRoot 'VeilForge-2.7.0-win-unpacked.zip'
$runtimeZip = Join-Path $releaseRoot 'VeilForge-RapidOCR-Runtime-1.0.0-win-x64.zip'
if (-not $appSource.StartsWith($releaseRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'PACKAGE_SOURCE_OUTSIDE_RELEASE' }
if (-not $runtimeSource.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'RUNTIME_SOURCE_OUTSIDE_WORKSPACE' }
foreach ($target in @($appZip, $runtimeZip)) {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($appSource, $appZip, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
[System.IO.Compression.ZipFile]::CreateFromDirectory($runtimeSource, $runtimeZip, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
foreach ($target in @($appZip, $runtimeZip)) {
  $item = Get-Item -LiteralPath $target
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  Write-Output "PACKAGE_OK path=$target bytes=$($item.Length) sha256=$hash"
}
