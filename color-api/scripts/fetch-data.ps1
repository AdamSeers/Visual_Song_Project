#!/usr/bin/env pwsh
# Windows/cross-platform equivalent of fetch-data.sh.
param([string]$Dest = "nga-data")

$ErrorActionPreference = "Stop"
$repo = "https://github.com/NationalGalleryOfArt/opendata.git"
$tmp  = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())

Write-Host "Cloning metadata only..."
git clone --depth 1 --filter=blob:none --no-checkout $repo $tmp | Out-Null

Push-Location $tmp
git sparse-checkout init --no-cone | Out-Null
git sparse-checkout set "data/objects.csv" "data/published_images.csv" | Out-Null
Write-Host "Fetching objects.csv and published_images.csv..."
git checkout HEAD | Out-Null
Pop-Location

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item (Join-Path $tmp "data/objects.csv")          $Dest
Copy-Item (Join-Path $tmp "data/published_images.csv") $Dest
Remove-Item -Recurse -Force $tmp

Write-Host "Done. CSVs are in: $Dest"
Get-ChildItem $Dest | Format-Table Name, Length
