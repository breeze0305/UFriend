param([Parameter(Mandatory = $true)][string]$ArtifactDirectory)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$artifactRoot = (Resolve-Path -LiteralPath $ArtifactDirectory).Path
$receipt = Get-Content -LiteralPath (Join-Path $artifactRoot 'build-receipt.json') -Raw | ConvertFrom-Json
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ufriend-runtime-verify-' + [guid]::NewGuid().ToString('N'))
$verification = [ordered]@{schemaVersion = 1; result = 'FAIL'; runtimeVersion = $receipt.runtime.version; checks = [ordered]@{}; commands = @()}
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function File-Record([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    return @{name = $item.Name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
function Check-File([string]$Path, $Expected) {
    $actual = File-Record $Path
    Assert-True ($actual.bytes -eq $Expected.bytes -and $actual.sha256 -eq $Expected.sha256) ('Artifact hash mismatch: ' + $Path)
    return $actual
}
function Run-Tool([string]$Executable, [string[]]$Arguments) {
    $text = (& $Executable @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    $verification.commands += @{tool = [IO.Path]::GetFileName($Executable); arguments = $Arguments; exitCode = $code; output = $text}
    if ($code -ne 0) { throw ('Native tool failed (' + $code + '): ' + $text) }
    return $text
}
try {
    Assert-True ($receipt.result -eq 'BUILT') 'The compile receipt is incomplete.'
    $zipPath = Join-Path $artifactRoot $receipt.runtimeArchive.name
    $sourcePath = Join-Path $artifactRoot $receipt.sourceArchive.name
    $verification.runtimeArchive = Check-File $zipPath $receipt.runtimeArchive
    $verification.sourceArchive = Check-File $sourcePath $receipt.sourceArchive
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $testRoot
    $runtimeRoot = Join-Path $testRoot ('ffmpeg-' + $receipt.runtime.version + '-win64')
    $ffmpeg = Join-Path $runtimeRoot 'bin\ffmpeg.exe'
    $ffprobe = Join-Path $runtimeRoot 'bin\ffprobe.exe'
    $verification.binaries = @{
        'ffmpeg.exe' = (Check-File $ffmpeg $receipt.runtime.binaries.'ffmpeg.exe')
        'ffprobe.exe' = (Check-File $ffprobe $receipt.runtime.binaries.'ffprobe.exe')
    }
    $verification.checks.artifactHashesMatch = $true
    Push-Location $testRoot
    try {
        $banner = Run-Tool $ffmpeg @('-version')
        Assert-True ($banner -match ('ffmpeg version ' + [regex]::Escape($receipt.runtime.version) + '\s')) 'Unexpected FFmpeg version.'
        foreach ($flag in @('--enable-gpl', '--enable-version3', '--enable-libass', '--enable-libx264', '--enable-libmp3lame')) {
            Assert-True ($banner.Contains($flag)) ('Missing configure flag: ' + $flag)
        }
        Assert-True (-not $banner.Contains('--enable-nonfree')) 'Non-redistributable configuration.'
        $verification.ffmpegBanner = $banner
        $null = Run-Tool $ffprobe @('-version')
        $filters = Run-Tool $ffmpeg @('-hide_banner', '-filters')
        foreach ($filter in @('ass', 'subtitles', 'scale', 'crop')) {
            Assert-True ($filters -match ('(?m)^\s*[.A-Z|]+\s+' + $filter + '\s')) ('Missing filter: ' + $filter)
        }
        $encoders = Run-Tool $ffmpeg @('-hide_banner', '-encoders')
        foreach ($encoder in @('libx264', 'aac', 'libmp3lame')) {
            Assert-True ($encoders -match ('(?m)^\s*[.A-Z]+\s+' + $encoder + '\s')) ('Missing encoder: ' + $encoder)
        }
        $verification.checks.expectedVersionAndCapabilities = $true
        $null = Run-Tool $ffmpeg @('-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'fixture.mp4')
        [IO.File]::WriteAllText((Join-Path $testRoot 'captions.srt'), "1`n00:00:00,100 --> 00:00:01,900`nUFriend 字幕測試`n", [Text.UTF8Encoding]::new($false))
        $exportLog = Run-Tool $ffmpeg @('-hide_banner', '-loglevel', 'verbose', '-y', '-i', 'fixture.mp4', '-vf', "subtitles=filename='captions.srt':force_style='FontName=Arial,FontSize=28'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', 'subtitled.mp4')
        Assert-True ($exportLog -match '(?i)font provider.*(directwrite|gdi)') 'libass did not use the Windows system font provider.'
        $probe = (Run-Tool $ffprobe @('-v', 'error', '-show_streams', '-show_format', '-of', 'json', 'subtitled.mp4')) | ConvertFrom-Json
        Assert-True (@($probe.streams | Where-Object { $_.codec_name -eq 'h264' }).Count -eq 1) 'Missing H.264 stream.'
        Assert-True (@($probe.streams | Where-Object { $_.codec_name -eq 'aac' }).Count -eq 1) 'Missing AAC stream.'
        Assert-True ([double]$probe.format.duration -ge 1.9) 'Subtitle output is truncated.'
        $null = Run-Tool $ffmpeg @('-v', 'error', '-y', '-ss', '1', '-i', 'subtitled.mp4', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'frame.rgb')
        $pixels = [IO.File]::ReadAllBytes((Join-Path $testRoot 'frame.rgb'))
        $bright = 0
        foreach ($pixel in $pixels) { if ($pixel -gt 100) { $bright++ } }
        Assert-True ($pixels.Length -eq 640 * 360 * 3 -and $bright -gt 200) 'Decoded subtitle frame contains no visible text.'
        $verification.checks.utf8SubtitleRenderingWithDirectWrite = $true
        $verification.checks.h264AacEncodeAndDecode = $true
        $null = Run-Tool $ffmpeg @('-hide_banner', '-y', '-i', 'fixture.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', '-segment_list', 'chunks.csv', '-segment_list_type', 'csv', 'chunk-%03d.mp3')
        $audioProbe = (Run-Tool $ffprobe @('-v', 'error', '-show_streams', '-of', 'json', 'chunk-000.mp3')) | ConvertFrom-Json
        Assert-True (@($audioProbe.streams | Where-Object { $_.codec_name -eq 'mp3' -and $_.sample_rate -eq '16000' -and $_.channels -eq 1 }).Count -eq 1) 'Cloud audio preparation failed.'
        Assert-True ((Get-Content -LiteralPath 'chunks.csv' -Raw) -match 'chunk-000.mp3') 'Missing segment CSV.'
        $null = Run-Tool $ffmpeg @('-v', 'error', '-i', 'chunk-000.mp3', '-f', 'null', '-')
        $verification.checks.mp3SegmentEncodeAndDecode = $true
        $verification.checks.ffprobeMetadata = $true
        $verification.result = 'PASS'
    } finally { Pop-Location }
} catch {
    $verification.error = $_.Exception.Message
    throw
} finally {
    $verification | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $artifactRoot 'windows-verification.json') -Encoding utf8NoBOM
    # Only this unique scratch directory is owned by this verification run.
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($resolved).StartsWith('ufriend-runtime-verify-')) {
            throw 'Refusing cleanup outside the owned temporary directory.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
