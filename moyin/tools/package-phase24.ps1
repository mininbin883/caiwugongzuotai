$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = (Resolve-Path (Join-Path $root 'release28-v2.4.0/win-unpacked')).Path
$destination = Join-Path $root 'release28-v2.4.0/VeilForge-2.4.0-win-unpacked.zip'
if (-not $source.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'PACKAGE_SOURCE_OUTSIDE_WORKSPACE' }
if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $source,
  $destination,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false,
  [System.Text.Encoding]::UTF8
)
$item = Get-Item -LiteralPath $destination
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
Write-Output "PACKAGE_OK path=$destination bytes=$($item.Length) sha256=$hash"
