# Rebuilds the Desktop Orchestra.exe launcher after editing orchestra-launcher.cs
$desktop = [Environment]::GetFolderPath('Desktop')
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /out:"$desktop\Orchestra.exe" `
  /r:System.dll /r:System.Windows.Forms.dll `
  "$PSScriptRoot\orchestra-launcher.cs"
if ($?) { "built: $desktop\Orchestra.exe" }
