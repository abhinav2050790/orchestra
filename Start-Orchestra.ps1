param(
  [int]$Workers = 0,
  [int]$Terminals = 0,
  [switch]$Demo,
  [switch]$NoBrowser,
  [switch]$InstallMcp
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 8787
New-Item -ItemType Directory -Force "$root\.data" | Out-Null

Write-Host ""
Write-Host "  ORCHESTRA :: boot" -ForegroundColor DarkCyan
Write-Host "  ==================" -ForegroundColor DarkCyan

# ---- deps ----
if (-not (Test-Path "$root\node_modules\ws")) {
  Write-Host "  [deps] installing ws…"
  Push-Location $root; npm install --no-fund --no-audit 2>&1 | Out-Null; Pop-Location
}

# ---- reuse or start hub ----
$h = $null
try { $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2 } catch {}
if ($h -and $h.ok) {
  Write-Host ("  [hub ] already online (up {0:n0}s) — reusing" -f ($h.uptime / 1000)) -ForegroundColor Yellow
} else {
  if (Test-Path "$root\.data\hub.pid") {
    try { taskkill /PID (Get-Content "$root\.data\hub.pid") /T /F 2>$null | Out-Null } catch {}
    Remove-Item "$root\.data\hub.pid" -EA SilentlyContinue
  }
  $p = Start-Process node -ArgumentList "server/hub.js" -WorkingDirectory $root `
        -WindowStyle Minimized -PassThru `
        -RedirectStandardOutput "$root\.data\hub.out.log" `
        -RedirectStandardError  "$root\.data\hub.err.log"
  Set-Content "$root\.data\hub.pid" $p.Id
  $ok = $false
  for ($i = 0; $i -lt 48; $i++) {
    Start-Sleep -Milliseconds 250
    try { $h = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 1; if ($h.ok) { $ok = $true; break } } catch {}
  }
  if (-not $ok) {
    Write-Host "  [hub ] FAILED to start — see .data\hub.err.log" -ForegroundColor Red
    Get-Content "$root\.data\hub.err.log" -EA SilentlyContinue | Select-Object -First 20
    exit 1
  }
  Write-Host ("  [hub ] online  pid={0}" -f $p.Id) -ForegroundColor Green
}
Write-Host ("  [bus ] ws://127.0.0.1:{0}/bus" -f $port)
Write-Host ("  [ui  ] http://127.0.0.1:{0}" -f $port)

# ---- optional actions ----
if ($InstallMcp) {
  Write-Host "  [mcp ] registering orchestra into opencode config…"
  Push-Location $root; node scripts/install-mcp.mjs; Pop-Location
}
if ($Demo) {
  Start-Process node -ArgumentList "scripts/demo-agents.js","5" -WorkingDirectory $root -WindowStyle Minimized
  Write-Host "  [demo] 5 synthetic agents launched" -ForegroundColor Green
}
if ($Workers -gt 0) {
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/spawn" -Method Post -ContentType "application/json" `
    -Body (@{ prompt = "Report ready: introduce yourself briefly on the bus, then summarize your capabilities in one line."; count = $Workers } | ConvertTo-Json) | Out-Null
  Write-Host ("  [wrk ] {0} opencode worker(s) spawning…" -f $Workers) -ForegroundColor Green
}
if ($Terminals -gt 0) {
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/terminals" -Method Post -ContentType "application/json" `
    -Body (@{ count = $Terminals } | ConvertTo-Json) | Out-Null
  Write-Host ("  [term] opening {0} wired opencode terminal(s)…" -f $Terminals) -ForegroundColor Green
}
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$port" }

Write-Host ""
Write-Host "  board : http://127.0.0.1:$port   (S=spawn worker  T=terminal  H=help)" -ForegroundColor DarkGray
Write-Host "  cli   : node cli/ochre.js ps | tail | send | spawn | pipe -- cmd" -ForegroundColor DarkGray
Write-Host "  stop  : .\Stop-Orchestra.ps1" -ForegroundColor DarkGray
Write-Host ""
