# B11 docs regen: short lock → counts + gaps --write → sweep leftover B11
# probe pages → re-verify the B11 matrix rows → release in finally.
param()
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $PSScriptRoot "_logs"
$lock = Join-Path $logs ".gate.lock"
$held = $false
$exitCode = 1
Set-Location $root
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }

try {
  $waited = 0
  while ($true) {
    try {
      $fs = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
      $fs.Close()
      $held = $true
      Write-Host "docs lock acquired"
      break
    } catch {
      $item = Get-Item $lock -ErrorAction SilentlyContinue
      if ($item -and ((Get-Date) - $item.LastWriteTime).TotalMinutes -gt 45) {
        Write-Host "stale lock - taking over"
        Remove-Item $lock -Force -ErrorAction SilentlyContinue
        continue
      }
      if ($waited -ge 1500) { throw "timed out waiting for the docs lock" }
      Start-Sleep -Seconds 10
      $waited += 10
    }
  }

  node scripts/feature-matrix-counts.mjs --write 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { throw "feature-matrix-counts --write failed" }
  node scripts/feature-gaps.mjs --write 2>&1 | Select-Object -Last 8
  if ($LASTEXITCODE -ne 0) { throw "feature-gaps --write failed" }

  node --env-file=.env -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{const n=await p.page.count({where:{title:{startsWith:"B11 "}}});console.log("leftover B11 pages:",n);if(n>0){await p.page.deleteMany({where:{title:{startsWith:"B11 "}}});console.log("swept");}})().finally(()=>p.$disconnect())'
  if ($LASTEXITCODE -ne 0) { throw "B11 sweep failed" }

  node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURE_MATRIX.md','utf8');const rows=t.split('\n').filter(l=>/Actions \(⋯\)|Actions menu:|Topbar/.test(l));const ok=rows.filter(l=>l.includes('| ✅ |')).length;const part=rows.filter(l=>l.includes('| 🟡 |')).length;const blocked=rows.filter(l=>l.includes('| ⛔ |')).length;console.log('B11 rows:',rows.length,'done:',ok,'partial:',part,'blocked:',blocked);for(const r of rows)console.log(r.slice(0,120));if(rows.length<17||ok<15||part<1||blocked<1)process.exit(1)"
  if ($LASTEXITCODE -ne 0) { throw "B11 matrix row re-verification failed" }
  Write-Host "B11 matrix rows verified after regen"
  $exitCode = 0
} catch {
  Write-Host "REGEN ERROR: $_"
  $exitCode = 1
} finally {
  if ($held) {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
    Write-Host "docs lock released"
  }
}
exit $exitCode
