$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$release = (Resolve-Path (Join-Path $root 'release27-v2.3.0')).Path
$source = (Resolve-Path (Join-Path $release 'win-unpacked')).Path
$zip = [IO.Path]::GetFullPath((Join-Path $release 'VeilForge-2.3.0-win-unpacked.zip'))
$allowedPrefix = $release.TrimEnd('\') + '\'
if (-not $zip.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "unsafe zip target: $zip"
}
if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}
[IO.Compression.ZipFile]::CreateFromDirectory(
  $source,
  $zip,
  [IO.Compression.CompressionLevel]::Optimal,
  $true
)

function Get-StreamSha256([IO.Stream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '') }
  finally { $sha.Dispose() }
}

$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entries = @($archive.Entries)
  $exeEntry = $entries | Where-Object FullName -eq 'win-unpacked/墨隐本地脱敏.exe'
  $asarEntry = $entries | Where-Object FullName -eq 'win-unpacked/resources/app.asar'
  if (-not $exeEntry -or -not $asarEntry) {
    throw "required zip entries missing: exe=$([bool]$exeEntry) asar=$([bool]$asarEntry)"
  }
  $exeStream = $exeEntry.Open()
  try { $zipExeHash = Get-StreamSha256 $exeStream } finally { $exeStream.Dispose() }
  $asarStream = $asarEntry.Open()
  try { $zipAsarHash = Get-StreamSha256 $asarStream } finally { $asarStream.Dispose() }
}
finally {
  $archive.Dispose()
}

$exeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source '墨隐本地脱敏.exe')).Hash
$asarHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'resources/app.asar')).Hash
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
$zipSize = (Get-Item -LiteralPath $zip).Length
$verified = $exeHash -eq $zipExeHash -and $asarHash -eq $zipAsarHash

Write-Output "ZIP_PATH=$zip"
Write-Output "ZIP_SHA256=$zipHash"
Write-Output "ZIP_BYTES=$zipSize"
Write-Output "ZIP_ENTRIES=$($entries.Count)"
Write-Output "EXE_SHA256=$exeHash"
Write-Output "ZIP_EXE_SHA256=$zipExeHash"
Write-Output "ASAR_SHA256=$asarHash"
Write-Output "ZIP_ASAR_SHA256=$zipAsarHash"
Write-Output "ZIP_VERIFY=$([int]$verified)"
if (-not $verified) { exit 1 }
