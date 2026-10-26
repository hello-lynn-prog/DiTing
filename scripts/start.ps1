param([int]$Port = 8090)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
Push-Location $taskRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Node.js 依赖安装失败' }
    }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript 编译失败，未启动服务' }
    $taskPreviousPort = $env:DITING_PORT
    try { $env:DITING_PORT = [string]$Port; & npm.cmd start }
    finally { $env:DITING_PORT = $taskPreviousPort }
} finally {
    Pop-Location
}

