$ErrorActionPreference = 'Stop'

$workspace = Resolve-Path (Join-Path $PSScriptRoot '..')
$starter = Join-Path $workspace 'writefreely\start-writefreely.ps1'

if (-not (Test-Path $starter)) {
    throw "WriteFreely is not installed at $workspace\writefreely. Run the setup in docs\writefreely.md first."
}

& $starter
