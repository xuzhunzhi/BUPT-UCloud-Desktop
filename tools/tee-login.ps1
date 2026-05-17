# Run from repo root: tools\tee-login.ps1  ($root = parent of tools)
$ErrorActionPreference = "Continue"

try {
    chcp 65001 | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $OutputEncoding = $utf8
} catch {}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$py = Join-Path $root ".venv\Scripts\python.exe"
$app = Join-Path $root "python\app.py"
$log = Join-Path $root "login_last_run.log"

if (-not (Test-Path $py)) {
    Write-Host "ERROR: Python venv not found:" $py -ForegroundColor Red
    Write-Host "From repo root: python -m venv .venv"
    Write-Host "Then: pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path $app)) {
    Write-Host "ERROR: python\app.py not found:" $app -ForegroundColor Red
    exit 1
}

Write-Host "Installing/checking Playwright Chromium..." -ForegroundColor Cyan
Write-Host ""
& $py -m playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Chromium install failed. Run:" -ForegroundColor Red
    Write-Host ("  " + $py + " -m playwright install chromium") -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Output also saved to:" $log
Write-Host ""

& $py -u $app login *>&1 | Tee-Object -FilePath $log
exit $LASTEXITCODE
