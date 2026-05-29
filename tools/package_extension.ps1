param(
    [string]$OutputDir = "dist",
    [switch]$KeepStaging,
    [switch]$NoZip,
    [switch]$RequirePostEndGuardMetadata
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

function Test-FireRedProfileAssets {
    param(
        [string]$RepoRoot,
        [switch]$RequirePostEndGuardMetadata
    )

    $profiles = @(
        @{ Profile = "offline-final"; Suffix = "offline_final" },
        @{ Profile = "live-pcm30"; Suffix = "live_pcm30" },
        @{ Profile = "live-realtime-aed60"; Suffix = "live_aed60" }
    )
    $assetKinds = @(
        @{ Stem = "segment_filter"; ModelType = "firered-segment-filter" },
        @{ Stem = "edge_trim_advisor"; ModelType = "firered-edge-trim-advisor" }
    )

    foreach ($profile in $profiles) {
        foreach ($kind in $assetKinds) {
            $base = "models/fireredvad/aed/$($kind.Stem)_$($profile.Suffix)"
            $modelRelative = "$base.onnx"
            $metaRelative = "$base.meta.json"
            $modelPath = Join-Path $RepoRoot $modelRelative
            $metaPath = Join-Path $RepoRoot $metaRelative

            if (-not (Test-Path -LiteralPath $modelPath)) {
                throw "Required FireRed profile model is missing: $modelRelative"
            }
            if (-not (Test-Path -LiteralPath $metaPath)) {
                throw "Required FireRed profile metadata is missing: $metaRelative"
            }

            $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
            if ([string]$meta.assetProfile -ne [string]$profile.Profile) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: assetProfile=$($meta.assetProfile), expected=$($profile.Profile)"
            }
            if ([string]$meta.trainingProfile -ne [string]$profile.Profile) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: trainingProfile=$($meta.trainingProfile), expected=$($profile.Profile)"
            }
            if ([string]$meta.modelType -ne [string]$kind.ModelType) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: modelType=$($meta.modelType), expected=$($kind.ModelType)"
            }
            if ([string]$meta.inputName -ne "segment_features") {
                throw "FireRed profile metadata mismatch in ${metaRelative}: inputName=$($meta.inputName), expected=segment_features"
            }
            $inputDim = 0
            if (-not [int]::TryParse([string]$meta.inputDim, [ref]$inputDim) -or $inputDim -le 0) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: inputDim must be a positive integer"
            }
            if (-not $meta.featureNames -or $meta.featureNames.Count -ne $inputDim) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: featureNames count=$($meta.featureNames.Count), expected=$inputDim"
            }

            if (-not $meta.negativeMining) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: negativeMining is missing"
            }
            $window = @($meta.negativeMining.manualPostEndWindowSec)
            if ($window.Count -ne 2 -or [double]$window[0] -ne 0.5 -or [double]$window[1] -ne 14.0) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: negativeMining.manualPostEndWindowSec must be [0.5, 14]"
            }
            if (-not $meta.negativeMining.postEndNegativeSongEvidenceSkip) {
                $message = "FireRed profile metadata warning in ${metaRelative}: postEndNegativeSongEvidenceSkip is missing; retrain before replacing this asset"
                if ($RequirePostEndGuardMetadata) {
                    throw $message
                }
                Write-Warning $message
            } elseif ($meta.negativeMining.postEndNegativeSongEvidenceSkip.enabled -eq $false) {
                throw "FireRed profile metadata mismatch in ${metaRelative}: postEndNegativeSongEvidenceSkip is disabled"
            }
        }
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
Test-FireRedProfileAssets -RepoRoot $repoRoot -RequirePostEndGuardMetadata:$RequirePostEndGuardMetadata

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
    "models/fireredvad/aed/segment_filter.meta.json",
    "models/fireredvad/aed/segment_filter.onnx",
    "models/fireredvad/aed/segment_filter_offline_final.meta.json",
    "models/fireredvad/aed/segment_filter_offline_final.onnx",
    "models/fireredvad/aed/segment_filter_live_aed60.meta.json",
    "models/fireredvad/aed/segment_filter_live_aed60.onnx",
    "models/fireredvad/aed/segment_filter_live_pcm30.meta.json",
    "models/fireredvad/aed/segment_filter_live_pcm30.onnx",
    "models/fireredvad/aed/edge_trim_advisor.meta.json",
    "models/fireredvad/aed/edge_trim_advisor.onnx",
    "models/fireredvad/aed/edge_trim_advisor_offline_final.meta.json",
    "models/fireredvad/aed/edge_trim_advisor_offline_final.onnx",
    "models/fireredvad/aed/edge_trim_advisor_live_aed60.meta.json",
    "models/fireredvad/aed/edge_trim_advisor_live_aed60.onnx",
    "models/fireredvad/aed/edge_trim_advisor_live_pcm30.meta.json",
    "models/fireredvad/aed/edge_trim_advisor_live_pcm30.onnx",
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
