param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$expected = @{
  'PACKAGE-MANIFEST.json' = '377DD982B22A845545D04E102E64AC3A6B053FE9F5E22EEBE08F69D40476B45F'
  'runtime-config.json' = '3A35CF8BE40A08A8D1435D6ADDDA9B92B6CE2E99D158AFCF03D9028FACA4CDF1'
  'unins000.dat' = '3A24F7BF8EDC5CAE123FE86E23D842A9B806126F0528E1C83838B10105D54B8F'
  'unins000.exe' = 'E1A173B100ED6BB39B04C301B1C31476CFBE4CD664DA5D546C1F69DE59B587FB'
  '使用说明.txt' = 'DFE5AB43AE3140E58C7EE78C21B2B945C175C8EC5C17A0390CCA9336C7A27A30'
  '隐页.exe' = '26B3F1FB2A4A32C247258E3ADF54DE24C20A34AEDB7F23F3E2A6494F3C57F803'
}
$base = Join-Path $Root 'yinye/package-files'
$failed = [System.Collections.Generic.List[string]]::new()
foreach($name in $expected.Keys | Sort-Object){
  $path = Join-Path $base $name
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){$failed.Add("${name}:missing"); continue}
  $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  if($actual -ne $expected[$name]){$failed.Add("${name}:hash")}
}
$passed=$expected.Count-$failed.Count
$failText=if($failed.Count){$failed -join ','}else{'none'}
Write-Output "YINYE_PACKAGE_PROBE $passed/$($expected.Count) root=$([IO.Path]::GetFullPath($Root)) failed=$failText"
if($failed.Count){exit 1}else{exit 0}

