[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$brandProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$brandAssetDirectory = [IO.Path]::GetFullPath((Join-Path $brandProjectRoot 'app\assets'))
if (-not $brandAssetDirectory.StartsWith(($brandProjectRoot + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Icon output must stay inside the project.'
}
[void][IO.Directory]::CreateDirectory($brandAssetDirectory)
$brandSourcePath = Join-Path $brandProjectRoot 'design\logo-options\ufriend-logo-b-leaf-companion.png'
if (-not [IO.File]::Exists($brandSourcePath)) {
    throw 'The selected leaf-companion logo source is missing.'
}

function New-BrandBitmap([int]$Size) {
    # Resize the selected original without redrawing, cropping, or recoloring it.
    $brandSource = [System.Drawing.Image]::FromFile($brandSourcePath)
    $brandBitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $brandGraphics = [System.Drawing.Graphics]::FromImage($brandBitmap)
    $brandAttributes = New-Object System.Drawing.Imaging.ImageAttributes
    try {
        if ($brandSource.Width -ne $brandSource.Height) { throw 'The selected logo must be square.' }
        $brandGraphics.Clear([System.Drawing.Color]::Transparent)
        $brandGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $brandGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $brandGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $brandGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $brandAttributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
        $brandRectangle = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
        $brandGraphics.DrawImage($brandSource, $brandRectangle, 0, 0, $brandSource.Width, $brandSource.Height, [System.Drawing.GraphicsUnit]::Pixel, $brandAttributes)
    } catch {
        $brandBitmap.Dispose()
        throw
    } finally {
        $brandAttributes.Dispose()
        $brandGraphics.Dispose()
        $brandSource.Dispose()
    }
    return $brandBitmap
}

$brandImage = New-BrandBitmap 256
try {
    $brandImage.Save((Join-Path $brandAssetDirectory 'ufriend.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $brandImage.Dispose()
}

# Windows Vista and later support PNG images inside ICO resources.
$brandSizes = @(16, 32, 48, 64, 128, 256)
$brandPngEntries = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($brandSize in $brandSizes) {
    $brandImage = New-BrandBitmap $brandSize
    $brandStream = New-Object System.IO.MemoryStream
    try {
        $brandImage.Save($brandStream, [System.Drawing.Imaging.ImageFormat]::Png)
        $brandPngEntries.Add($brandStream.ToArray())
    } finally {
        $brandStream.Dispose()
        $brandImage.Dispose()
    }
}

$brandIconPath = Join-Path $brandAssetDirectory 'ufriend.ico'
$brandFile = [IO.File]::Open($brandIconPath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$brandWriter = New-Object System.IO.BinaryWriter($brandFile)
try {
    $brandWriter.Write([uint16]0)
    $brandWriter.Write([uint16]1)
    $brandWriter.Write([uint16]$brandSizes.Count)
    $brandOffset = 6 + 16 * $brandSizes.Count
    for ($brandIndex = 0; $brandIndex -lt $brandSizes.Count; $brandIndex++) {
        $brandDimension = if ($brandSizes[$brandIndex] -eq 256) { 0 } else { $brandSizes[$brandIndex] }
        $brandWriter.Write([byte]$brandDimension)
        $brandWriter.Write([byte]$brandDimension)
        $brandWriter.Write([byte]0)
        $brandWriter.Write([byte]0)
        $brandWriter.Write([uint16]1)
        $brandWriter.Write([uint16]32)
        $brandWriter.Write([uint32]$brandPngEntries[$brandIndex].Length)
        $brandWriter.Write([uint32]$brandOffset)
        $brandOffset += $brandPngEntries[$brandIndex].Length
    }
    foreach ($brandPng in $brandPngEntries) { $brandWriter.Write([byte[]]$brandPng) }
    $brandWriter.Flush()
} finally {
    $brandWriter.Dispose()
    $brandFile.Dispose()
}

Get-Item -LiteralPath (Join-Path $brandAssetDirectory 'ufriend.png'), $brandIconPath | Select-Object Name, Length
