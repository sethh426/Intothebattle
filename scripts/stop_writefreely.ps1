$ErrorActionPreference = 'Stop'

$workspace = Resolve-Path (Join-Path $PSScriptRoot '..')
$stopper = Join-Path $workspace 'writefreely\stop-writefreely.ps1'

if (-not (Test-Path $stopper)) {
    throw "WriteFreely is not installed at $workspace\writefreely. Run the setup in docs\writefreely.md first."
}

& $stopper
