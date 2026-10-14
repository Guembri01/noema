# B06: single targeted rerun of the 9 failures from gate run 8 (2 of them are
# playbook-known flakes: pagination, slash-menu). Targeted runs run without the
# lock (playbook), but we still wait for other suites to drain first.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:E2E_BASE_URL = "http://localhost:3201"

function Get-Competing {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine -match 'playwright.*\btest\b')
  }
}
$waited = 0
while ($true) {
  $busy = @(Get-Competing)
  if ($busy.Count -eq 0) { break }
  if ($waited -ge 900) { Write-Host "note: running targeted rerun alongside pids $($busy.ProcessId -join ',')"; break }
  Write-Host "waiting for sibling suites (pids: $($busy.ProcessId -join ','))..."
  Start-Sleep -Seconds 15
  $waited += 15
}

$titles = @(
  "filters with a long-tail operator",
  "applies two sorts and shows the order",
  "persists show/hide properties and filters",
  "ticket drawer description autosaves",
  "an empty ticket description renders no box",
  "tickets: create with estimate and dates",
  "plans a cycle, schedules a ticket",
  "paging through a large tracker never repeats",
  "slash menu adds headings 4-6"
)
$pattern = ($titles -join "|")
Write-Output "=== TARGETED RERUN (E2E_BASE_URL=$env:E2E_BASE_URL) ==="
npx playwright test --reporter=line -g $pattern 2>&1 |
  Tee-Object -FilePath (Join-Path $PSScriptRoot "_logs\b06-rerun.log") |
  Select-Object -Last 40
Write-Output "RERUN_EXIT=$LASTEXITCODE"
exit $LASTEXITCODE
