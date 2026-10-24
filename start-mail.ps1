param([string]$Python = "python")
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".env"))) {
        throw "Copy .env.example to .env and configure the random bridge token and SMTP first."
    }
    & $Python -m runner.mail_bridge
    if ($LASTEXITCODE -ne 0) { throw "Mail bridge exited with code $LASTEXITCODE" }
} finally { Pop-Location }
