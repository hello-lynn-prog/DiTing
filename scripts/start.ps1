param([int]$Port = 8090)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    $taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $taskPython)) {
        throw '请先执行：python -m venv .venv，然后 .\.venv\Scripts\python.exe -m pip install -e ".[test]"'
    }
    & $taskPython -m diting --port $Port
} finally {
    Pop-Location
}

