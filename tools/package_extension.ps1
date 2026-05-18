param(
    [string]$OutputDir = "dist",
    [switch]$KeepStaging,
    [switch]$NoZip
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path (Join-Path $scriptDir "..")).Path
}

function ConvertTo-SafeName {
    param([string]$Value)
    $safe = $Value -replace '[^\w.-]+', '-'
    $safe = $safe.Trim("-")
    if ([string]::IsNullOrWhiteSpace($safe)) { return "extension" }
    return $safe
}

function Get-DirectorySize {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0L }
    return [long]((Get-ChildItem -LiteralPath $Path -Recurse -File | Measure-Object -Property Length -Sum).Sum)
}

function Format-FileSize {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:N2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:N2} MB" -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return "{0:N2} KB" -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Copy-PathToStaging {
    param(
        [string]$RepoRoot,
        [string]$StagingDir,
        [string]$RelativePath
    )

    $source = Join-Path $RepoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Required package path is missing: $RelativePath"
    }

    $destination = Join-Path $StagingDir $RelativePath
    $destinationParent = Split-Path -Parent $destination
    if ($destinationParent -and -not (Test-Path -LiteralPath $destinationParent)) {
        New-Item -ItemType Directory -Path $destinationParent | Out-Null
    }

    $item = Get-Item -LiteralPath $source
    if ($item.PSIsContainer) {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    } else {
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}

function Test-ManifestResource {
    param(
        [string]$RepoRoot,
        [object]$Manifest
    )

    $required = New-Object System.Collections.Generic.List[string]

    $required.Add("manifest.json")
    if ($Manifest.background.service_worker) { $required.Add([string]$Manifest.background.service_worker) }
    if ($Manifest.action.default_popup) { $required.Add([string]$Manifest.action.default_popup) }

    foreach ($icon in $Manifest.icons.PSObject.Properties) {
        if ($icon.Value) { $required.Add([string]$icon.Value) }
    }
    foreach ($icon in $Manifest.action.default_icon.PSObject.Properties) {
        if ($icon.Value) { $required.Add([string]$icon.Value) }
    }
    foreach ($script in $Manifest.content_scripts) {
        foreach ($js in @($script.js)) { if ($js) { $required.Add([string]$js) } }
        foreach ($css in @($script.css)) { if ($css) { $required.Add([string]$css) } }
    }
    foreach ($resourceBlock in @($Manifest.web_accessible_resources)) {
        foreach ($resource in @($resourceBlock.resources)) {
            if ($resource) { $required.Add([string]$resource) }
        }
    }

    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($path in ($required | Select-Object -Unique)) {
        $normalized = $path -replace '/', [IO.Path]::DirectorySeparatorChar
        $fullPath = Join-Path $RepoRoot $normalized

        if ($path.Contains("*")) {
            $matches = Get-ChildItem -Path $fullPath -ErrorAction SilentlyContinue
            if (-not $matches) { $missing.Add($path) }
        } elseif (-not (Test-Path -LiteralPath $fullPath)) {
            $missing.Add($path)
        }
    }

    if ($missing.Count -gt 0) {
        throw "Manifest references missing resource(s): $($missing -join ', ')"
    }
}

function New-ZipFromStaging {
    param(
        [string]$StagingDir,
        [string]$ZipPath
    )

    if (Test-Path -LiteralPath $ZipPath) {
        Remove-Item -LiteralPath $ZipPath -Force
    }

    $zipParent = Split-Path -Parent $ZipPath
    if ($zipParent -and -not (Test-Path -LiteralPath $zipParent)) {
        New-Item -ItemType Directory -Path $zipParent | Out-Null
    }

    $items = Get-ChildItem -LiteralPath $StagingDir -Force
    if (-not $items) {
        throw "Staging directory is empty: $StagingDir"
    }

    Compress-Archive -Path $items.FullName -DestinationPath $ZipPath -CompressionLevel Optimal -Force
}

$repoRoot = Resolve-RepoRoot
$manifestPath = Join-Path $repoRoot "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found. Run this script from the repository or tools directory."
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
Test-ManifestResource -RepoRoot $repoRoot -Manifest $manifest

$version = [string]$manifest.version
$extensionName = ConvertTo-SafeName ([string]$manifest.name)
$versionName = $version -replace '\.', '_'

$resolvedOutputDir = Join-Path $repoRoot $OutputDir
$stagingDir = Join-Path $resolvedOutputDir "staging-$extensionName-$versionName"
$zipPath = Join-Path $resolvedOutputDir "$extensionName-$versionName-chrome.zip"

if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDir | Out-Null

$packagePaths = @(
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "styles.css",
    "offscreen.html",
    "offscreen.js",
    "workbench.html",
    "workbench.css",
    "workbench.js",
    "_locales",
    "images",
    "lib",
    "models/fireredvad/aed/cmvn.json",
    "models/fireredvad/aed/firered_song_head.meta.json",
    "models/fireredvad/aed/firered_song_head.onnx",
    "models/fireredvad/aed/model.meta.json",
    "models/fireredvad/aed/model.onnx",
    "LICENSE"
)

try {
    foreach ($path in $packagePaths) {
        Copy-PathToStaging -RepoRoot $repoRoot -StagingDir $stagingDir -RelativePath $path
    }

    $unpackedSize = Get-DirectorySize -Path $stagingDir
    Write-Host "Staged extension: $stagingDir"
    Write-Host "Unpacked size: $(Format-FileSize $unpackedSize)"

    if (-not $NoZip) {
        New-ZipFromStaging -StagingDir $stagingDir -ZipPath $zipPath
        $zipSize = (Get-Item -LiteralPath $zipPath).Length
        $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash

        Write-Host "Package: $zipPath"
        Write-Host "Zip size: $(Format-FileSize $zipSize)"
        Write-Host "SHA256: $hash"
    }

    if (-not $KeepStaging) {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force
        Write-Host "Removed staging directory."
    } else {
        Write-Host "Kept staging directory for Load unpacked testing."
    }
} catch {
    if (-not $KeepStaging -and (Test-Path -LiteralPath $stagingDir)) {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
