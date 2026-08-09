param(
  [string]$BlenderPath = $env:AETHERIS_BLENDER
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$rawDir = Join-Path $env:TEMP ('aetheris-structure-assets-raw-' + [Guid]::NewGuid().ToString('N'))
$outputDir = Join-Path $repoRoot 'frontend\aetheris\src\assets\aetheris\models'
$generator = Join-Path $PSScriptRoot 'generate_assets.py'

if (-not $BlenderPath) {
  $BlenderPath = 'C:\Users\sethp\AppData\Local\CodexTools\blender-4.5.11\blender-4.5.11-windows-x64\blender.exe'
}
if (-not (Test-Path -LiteralPath $BlenderPath)) {
  throw "Blender was not found at '$BlenderPath'. Set AETHERIS_BLENDER to the portable Blender executable."
}
if (-not (Test-Path -LiteralPath $generator)) {
  throw "Asset generator was not found at '$generator'."
}

New-Item -ItemType Directory -Force -Path $rawDir, $outputDir | Out-Null

& $BlenderPath --background --factory-startup --python $generator -- --output-dir $rawDir
if ($LASTEXITCODE -ne 0) {
  throw "Blender asset generation failed with exit code $LASTEXITCODE."
}

$rawAssets = Get-ChildItem -LiteralPath $rawDir -Recurse -Filter *.glb
if ($rawAssets.Count -ne 33) {
  throw "Expected 33 generated GLBs, found $($rawAssets.Count)."
}

foreach ($asset in $rawAssets) {
  $relative = $asset.FullName.Substring($rawDir.Length + 1)
  $destination = Join-Path $outputDir $relative
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($destination)) | Out-Null
  & (Join-Path $repoRoot 'node_modules\.bin\gltf-transform.cmd') optimize $asset.FullName $destination `
    --compress meshopt `
    --flatten false `
    --instance false `
    --join false `
    --palette false
  if ($LASTEXITCODE -ne 0) {
    throw "glTF optimization failed for '$relative'."
  }
  & (Join-Path $repoRoot 'node_modules\.bin\gltf-transform.cmd') validate $destination
  if ($LASTEXITCODE -ne 0) {
    throw "glTF validation failed for '$relative'."
  }
}

Copy-Item -LiteralPath (Join-Path $rawDir 'manifest.json') -Destination (Join-Path $outputDir 'manifest.json') -Force

$totalBytes = (Get-ChildItem -LiteralPath $outputDir -Recurse -File | Measure-Object Length -Sum).Sum
if ($totalBytes -gt 12MB) {
  throw "Optimized structure assets exceed the 12 MB budget: $totalBytes bytes."
}

& node (Join-Path $repoRoot 'scripts\aetheris_asset_contract.js')
if ($LASTEXITCODE -ne 0) {
  throw "Aetheris asset contract validation failed with exit code $LASTEXITCODE."
}

Write-Output "Aetheris structure assets built and validated: $($rawAssets.Count) GLBs, $totalBytes bytes."
