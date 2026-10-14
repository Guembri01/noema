# B06: editor-area subset run (playbook v2 STANDARD gate allows splits to
# substitute a smoke subset when DOM output is provably unchanged — the
# string-literal and statement identity proofs are in _scratch_b06_*).
# Waits (bounded) for sibling suites before running.
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
  if ($waited -ge 1800) { throw "no quiet window within 30 min (pids: $($busy.ProcessId -join ','))" }
  Write-Host "waiting for sibling suites (pids: $($busy.ProcessId -join ','))..."
  Start-Sleep -Seconds 15
  $waited += 15
}

$titles = @(
  "saves an edit and reloads it from the database",
  "selection toolbar opens the AI panel",
  "right-click block menu turns a paragraph",
  "Comment anchors the selection",
  "Move up reorders the selected block",
  "equation dialog inserts LaTeX",
  "typing LaTeX becomes an editable equation",
  "slash menu adds headings 4-6",
  "toggle block keeps its collapsed state",
  "code block language selector persists",
  "right-click colour menu paints a block background",
  "drag handle nests and unnests",
  "copying in one editor and pasting in another",
  "right-click delete offers Undo",
  "colouring part of a bolded range",
  "mentioning a member notifies them",
  "search actions filters the list live",
  "Copy page contents writes the page markdown",
  "Duplicate creates a sibling page",
  "menu footer shows word count",
  "Translate submenu lists the five shipped locales",
  "reverts the last editor change",
  "Small text and Full width toggle"
)
$pattern = ($titles -join "|")
Write-Output "=== EDITOR SUBSET (E2E_BASE_URL=$env:E2E_BASE_URL) ==="
npx playwright test --reporter=line -g $pattern 2>&1 |
  Tee-Object -FilePath (Join-Path $PSScriptRoot "_logs\b06-editor-subset2.log") |
  Select-Object -Last 35
Write-Output "SUBSET_EXIT=$LASTEXITCODE"
exit $LASTEXITCODE
