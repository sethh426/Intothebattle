$ErrorActionPreference = 'Stop'

$workspace = Resolve-Path (Join-Path $PSScriptRoot '..')
$starter = Join-Path $workspace 'writefreely\start-writefreely.ps1'
$config = Join-Path $workspace 'writefreely\config.ini'

if (-not (Test-Path $starter)) {
    throw "WriteFreely is not installed at $workspace\writefreely. Run the setup in docs\writefreely.md first."
}

# Avoid depending on local DNS resolution just to bind the loopback listener.
if (Test-Path $config) {
    $configText = Get-Content -Path $config -Raw
    $normalizedConfig = $configText -replace '(?m)^bind\s*=\s*localhost\s*$', 'bind                 = 127.0.0.1'
    if ($normalizedConfig -ne $configText) {
        Set-Content -Path $config -Value $normalizedConfig -NoNewline
    }
}

& $starter

$deadline = (Get-Date).AddSeconds(20)
do {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/' -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            Write-Output 'WriteFreely health check passed at http://127.0.0.1:8080/'
            exit 0
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
} while ((Get-Date) -lt $deadline)

throw 'WriteFreely started but did not become healthy at http://127.0.0.1:8080/'
