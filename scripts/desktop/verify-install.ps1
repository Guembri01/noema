# Verify the *installed* Noema desktop app, end to end, and print a report.
#
#   powershell -File scripts/desktop/verify-install.ps1                 # check what is installed
#   powershell -File scripts/desktop/verify-install.ps1 -Setup <setup.exe>   # reinstall first
#   powershell -File scripts/desktop/verify-install.ps1 -Setup <setup.exe> -UninstallFirst
#
# What it checks, because each of these has been wrong at least once:
#   · the installer completes without admin rights (NSIS per-user mode)
#   · the shell starts and does not die (a panic is recorded in noema-panic.log)
#   · the supervised server comes up on loopback and reports healthy with the
#     database up (`/api/health` → 200 `{"ok":true,"db":"up"}`)
#   · a real page is served with its stylesheets
#   · a second launch does not start a second server (single-instance)
#   · the window renders — captured to a PNG so a human (or a model) can look
param(
    [string]$Setup,
    [switch]$UninstallFirst,
    [string]$OutDir = "$env:TEMP\noema-verify",
    [int]$ReadyTimeoutSeconds = 180
)

$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$installDir = Join-Path $env:LOCALAPPDATA "Noema"
$exe = Join-Path $installDir "noema-desktop.exe"
$failures = @()
$notes = @()

function Step($ok, $label, $detail = "") {
    $mark = if ($ok) { "ok  " } else { "FAIL" }
    Write-Output ("  {0} {1}{2}" -f $mark, $label, $(if ($detail) { " — $detail" } else { "" }))
    if (-not $ok) { $script:failures += $label }
}

function Stop-Noema {
    Get-Process noema-node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process noema-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Output "Noema installed-app verification`n"

if ($UninstallFirst -and (Test-Path (Join-Path $installDir "uninstall.exe"))) {
    Write-Output "  uninstalling the previous version…"
    $u = Start-Process -FilePath (Join-Path $installDir "uninstall.exe") -ArgumentList "/S" -PassThru -Wait
    Start-Sleep -Seconds 3
    Step (-not (Test-Path $exe)) "uninstaller removes the app" "exit $($u.ExitCode)"
}

if ($Setup) {
    if (-not (Test-Path $Setup)) { Write-Output "setup not found: $Setup"; exit 1 }
    Write-Output "  installing $Setup …"
    $i = Start-Process -FilePath $Setup -ArgumentList "/S" -PassThru -Wait
    Step ($i.ExitCode -eq 0) "installer exit code 0" "exit $($i.ExitCode)"
}

Step (Test-Path $exe) "app is installed" $installDir
if (-not (Test-Path $exe)) { Write-Output "`nnot installed; stopping"; exit 1 }
Step (Test-Path (Join-Path $installDir "server\server.js")) "payload present (server/server.js)"
Step (Test-Path (Join-Path $installDir "noema-node.exe")) "bundled Node runtime present"
Step (Test-Path (Join-Path $installDir "uninstall.exe")) "uninstaller present"

# Fresh panic log, so we only report panics from this run.
$panicLog = Join-Path $env:TEMP "noema-panic.log"
if (Test-Path $panicLog) { Remove-Item $panicLog -Force }

Stop-Noema
Write-Output "`n  launching…"
$app = Start-Process -FilePath $exe -PassThru
Step ($app.Id -gt 0) "launched" "pid $($app.Id)"

# Wait for the supervised server: find the loopback port its child answers HTTP
# on. The child listens twice - the web server, and the database socket when the
# install provisions its own embedded PostgreSQL - and netstat's order is not
# stable (it flipped between runs), so "the first listening port" reported a
# healthy install as broken. Ask each candidate which one speaks HTTP.
$port = $null
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($app.HasExited) { break }
    $child = Get-Process noema-node -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $child) { continue }
    $candidates = netstat -ano |
        Select-String "127\.0\.0\.1:(\d+)\s+.*LISTENING\s+$($child.Id)\s*$" |
        ForEach-Object { [regex]::Match($_.Line, "127\.0\.0\.1:(\d+)").Groups[1].Value } |
        Select-Object -Unique
    foreach ($candidate in $candidates) {
        try {
            $probe = Invoke-WebRequest "http://127.0.0.1:$candidate/api/health" -UseBasicParsing -TimeoutSec 3
            if ($probe.StatusCode -eq 200) { $port = $candidate; break }
        } catch {
            # The database socket answers no HTTP: keep looking.
        }
    }
    if ($port) { break }
}
Step (-not $app.HasExited) "shell still running" $(if ($app.HasExited) { "exited $($app.ExitCode)" } else { "" })
Step ($null -ne $port) "supervised server listening on loopback" $(if ($port) { "port $port" } else { "not found" })

if ($port) {
    try {
        $health = Invoke-WebRequest "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 20
        $body = $health.Content
        Step ($health.StatusCode -eq 200) "GET /api/health → 200" $body
        Step ($body -match '"db":"up"') "database is up" ""
    } catch {
        Step $false "GET /api/health" $_.Exception.Message
    }
    try {
        $page = Invoke-WebRequest "http://127.0.0.1:$port/login" -UseBasicParsing -TimeoutSec 30
        Step ($page.StatusCode -eq 200) "GET /login → 200" "$($page.Content.Length) bytes"
        Step ($page.Content -match "\.css|styles") "stylesheets linked (static assets copied)"
    } catch {
        Step $false "GET /login" $_.Exception.Message
    }
    # The installed app must not show the marketing landing page: `/` has to send
    # someone to sign-in (or to "create your account" on a brand-new database).
    try {
        $root = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 30
        $hero = "A local-first workspace for notes"
        Step (-not $root.Content.Contains($hero)) "`/ does not serve the marketing landing page"
        Step ($root.Content -match 'type="password"|name="password"') "`/ lands on an auth form"
    } catch {
        Step $false "GET /" $_.Exception.Message
    }
}

# Single instance: a second launch must not add a second server.
$before = (Get-Process noema-desktop -ErrorAction SilentlyContinue | Measure-Object).Count
$second = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 8
$after = (Get-Process noema-desktop -ErrorAction SilentlyContinue | Measure-Object).Count
$servers = (Get-Process noema-node -ErrorAction SilentlyContinue | Measure-Object).Count
Step ($after -le $before) "second launch does not add an instance" "desktop processes: $before → $after"
Step ($servers -le 1) "exactly one supervised server" "$servers server process(es)"

Step (-not (Test-Path $panicLog)) "no panic recorded" $(if (Test-Path $panicLog) { (Get-Content $panicLog -TotalCount 4) -join " / " } else { "" })

Write-Output "`n  capturing the window…"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "capture-window.ps1") -OutDir $OutDir -WaitSeconds 30 2>&1 |
    Select-Object -Last 3 | ForEach-Object { "    $_" }
Get-ChildItem $OutDir -Filter *.png -ErrorAction SilentlyContinue | ForEach-Object {
    "    screenshot: $($_.FullName)  $([math]::Round($_.Length/1KB,1)) KB"
}

$log = Join-Path $env:APPDATA "app.noema.desktop\logs\noema.log"
if (Test-Path $log) {
    Write-Output "`n  last log lines:"
    Get-Content $log | Select-Object -Last 6 | ForEach-Object { "    $_" }
}

Stop-Noema
Write-Output ""
if ($failures.Count -gt 0) {
    Write-Output "$($failures.Count) failure(s): $($failures -join '; ')"
    exit 1
}
Write-Output "All checks passed."
