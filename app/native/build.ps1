[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$listenerDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$listenerSource = [IO.Path]::GetFullPath((Join-Path $listenerDirectory 'ClipboardListener.cs'))
$listenerOutput = [IO.Path]::GetFullPath((Join-Path $listenerDirectory 'ClipboardListener.exe'))

if (-not [string]::Equals([IO.Path]::GetDirectoryName($listenerOutput), $listenerDirectory, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The output executable must stay inside this native helper directory.'
}
if (-not (Test-Path -LiteralPath $listenerSource -PathType Leaf)) {
    throw "Clipboard listener source not found: $listenerSource"
}

$listenerWindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$listenerCompilerCandidates = @(
    (Join-Path $listenerWindowsDirectory 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $listenerWindowsDirectory 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$listenerCompiler = $listenerCompilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $listenerCompiler) {
    throw 'The Windows .NET Framework 4.x C# compiler was not found. No SDK was downloaded.'
}

$listenerCompilerArguments = @(
    '/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/langversion:5', '/warnaserror+',
    '/reference:System.dll', '/reference:System.Windows.Forms.dll',
    ('/out:' + $listenerOutput), $listenerSource
)
& $listenerCompiler @listenerCompilerArguments
if ($LASTEXITCODE -ne 0) {
    throw "Clipboard listener compilation failed with exit code $LASTEXITCODE."
}
if (-not (Test-Path -LiteralPath $listenerOutput -PathType Leaf)) {
    throw 'The compiler reported success but did not produce the executable.'
}
Write-Output "Built: $listenerOutput"
