$ErrorActionPreference = 'Stop'

$workspace = Resolve-Path (Join-Path $PSScriptRoot '..')
$appPort = 3000
$blogPort = 8080

function Test-ListeningPort($port) {
    $listener = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq 'Listen' } |
        Select-Object -First 1
    return [bool]$listener
}

function Wait-ForUrl($url, $seconds = 20) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    return $false
}

$writeFreelyStarter = Join-Path $workspace 'scripts\start_writefreely.ps1'
if (-not (Test-Path $writeFreelyStarter)) {
    throw "Missing WriteFreely starter script: $writeFreelyStarter"
}

& $writeFreelyStarter
if (-not (Wait-ForUrl "http://localhost:$blogPort/" 20)) {
    throw "WriteFreely did not respond at http://localhost:$blogPort/"
}

if (-not (Test-ListeningPort $appPort)) {
    $env:PORT = "$appPort"
    $env:HOST = '127.0.0.1'
    $env:NODE_ENV = 'development'
    $env:SKIP_DB = 'true'
    $env:API_KEY = 'test'
    $env:JWT_SECRET = 'local_dev_change_me'
    $env:OVERLAY_TOKEN_SECRET = 'local_overlay_change_me'
    $env:DISK_PATH = Join-Path $workspace 'data'
    $env:METRICS_TOKEN = 'local_metrics_token'
    $env:DIAGNOSTICS_TOKEN = 'local_diagnostics_token'
    $env:APP_BASE_URL = "http://localhost:$appPort"
    $env:WRITEFREELY_PUBLIC_URL = "http://localhost:$blogPort/"

    $outLog = Join-Path $workspace '.tmp-main-app-blog.out.log'
    $errLog = Join-Path $workspace '.tmp-main-app-blog.err.log'
    $process = Start-Process -FilePath 'node' `
        -ArgumentList @('server.js') `
        -WorkingDirectory $workspace `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -Path (Join-Path $workspace '.tmp-main-app-blog.pid') -Value $process.Id
    Write-Output "Started IntoTheBattle app on http://127.0.0.1:$appPort with PID $($process.Id)"
} else {
    Write-Output "IntoTheBattle app already appears to be listening on http://127.0.0.1:$appPort"
}

if (-not (Wait-ForUrl "http://127.0.0.1:$appPort/healthz" 20)) {
    throw "IntoTheBattle app did not respond at http://127.0.0.1:$appPort/healthz"
}

$target = "http://127.0.0.1:$appPort/blog"
Start-Process $target
Write-Output "Opened $target"
