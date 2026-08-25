# Rebuilds the native folder picker used by /api/workspace/browse
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$bin = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
& $csc /nologo /target:exe /out:"$bin\folder-picker.exe" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  "$PSScriptRoot\folder-picker.cs"
if ($?) { "built: $bin\folder-picker.exe" }
