$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot

# hub via pid file
if (Test-Path "$root\.data\hub.pid") {
  $pid0 = Get-Content "$root\.data\hub.pid"
  taskkill /PID $pid0 /T /F 2>$null | Out-Null
  Remove-Item "$root\.data\hub.pid" -EA SilentlyContinue
  Write-Host "[orchestra] hub (pid $pid0) stopped" -ForegroundColor Green
} else {
  Write-Host "[orchestra] no pid file — scanning…" -ForegroundColor Yellow
}

# sweep any remaining orchestra node processes (demo agents, stray workers)
$swept = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  if ($_.CommandLine -match 'ochrestra|orchestra' -and $_.ProcessId -ne $PID) {
    Stop-Process -Id $_.ProcessId -Force; $swept++
  }
}
if ($swept) { Write-Host "[orchestra] swept $swept node process(es)" }
Write-Host "[orchestra] all quiet." -ForegroundColor DarkGray
