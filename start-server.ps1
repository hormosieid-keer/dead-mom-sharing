param([string]$Action = "up")
$ErrorActionPreference = "Stop"
if ($Action -notin @("up", "down", "logs", "build")) { throw "Action must be up, down, logs or build" }
Push-Location (Join-Path $PSScriptRoot "deploy")
try {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot ".env"))) {
        throw "Copy .env.example to .env and configure it first."
    }
    switch ($Action) {
        "up" { & docker compose --env-file ../.env up --build -d }
        "down" { & docker compose --env-file ../.env down }
        "logs" { & docker compose --env-file ../.env logs -f }
        "build" { & docker compose --env-file ../.env build }
    }
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose exited with code $LASTEXITCODE" }
} finally { Pop-Location }
