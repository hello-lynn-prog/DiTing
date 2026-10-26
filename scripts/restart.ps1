param(
    [ValidateRange(1, 65535)][int]$Port = 8090,
    [switch]$CheckOnly,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$configuredDataDir = if ($env:DITING_DATA_DIR) { $env:DITING_DATA_DIR } else { 'data' }
$dataDir = if ([IO.Path]::IsPathRooted($configuredDataDir)) {
    [IO.Path]::GetFullPath($configuredDataDir)
} else {
    [IO.Path]::GetFullPath((Join-Path $taskRoot $configuredDataDir))
}
$lockPath = Join-Path $dataDir 'server.lock'

Push-Location $taskRoot
try {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $owners = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -gt 1) { throw "端口 $Port 有多个监听进程，已停止以免误杀。" }

    $servicePid = if ($owners.Count -eq 1) { [int]$owners[0] } else { $null }
    $lockPid = if (Test-Path -LiteralPath $lockPath) {
        $raw = (Get-Content -LiteralPath $lockPath -Raw).Trim()
        $parsed = 0
        if (-not [int]::TryParse($raw, [ref]$parsed)) { throw "服务锁 $lockPath 内容无效，请人工核对。" }
        $parsed
    } else { $null }

    if ($servicePid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid"
        if (-not $process -or $process.Name -ne 'node.exe' -or
            $process.CommandLine -notmatch 'dist[\\/]+apps[\\/]+server[\\/]+main\.js' -or
            $lockPid -ne $servicePid) {
            throw "端口 $Port 的进程与本项目服务锁不匹配，已停止以免误杀。"
        }
        Write-Host "已确认 DiTing 服务 PID $servicePid，数据目录 $dataDir"
    } elseif ($lockPid -and (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
        throw "数据目录仍由 PID $lockPid 使用；端口 $Port 无监听，已停止以免启动第二套后端。"
    } else {
        Write-Host "端口 $Port 当前无服务，将构建并启动 DiTing。"
    }

    if ($servicePid) {
        try {
            $tasks = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tasks" -TimeoutSec 10
        } catch {
            throw '无法检查当前研究任务，已停止以免中断运行中的任务。'
        }
        if ($tasks -isnot [array]) { throw '任务状态接口未返回预期列表，已停止以免中断运行中的任务。' }
        $activeTasks = @($tasks | Where-Object { $_.status -eq 'running' })
        if ($activeTasks.Count -gt 0) {
            throw "当前有 $($activeTasks.Count) 个研究任务正在运行，待任务结束后再重启。"
        }
    }

    if ($CheckOnly) { return }

    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '构建失败，现有服务未停止。' }

    if ($servicePid) {
        try {
            $tasks = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tasks" -TimeoutSec 10
        } catch {
            throw '构建后无法复查研究任务，原服务保留。'
        }
        if ($tasks -isnot [array] -or @($tasks | Where-Object { $_.status -eq 'running' }).Count -gt 0) {
            throw '构建后发现任务状态未知或已有研究任务开始运行，原服务保留。'
        }
        Stop-Process -Id $servicePid -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $stillListening = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
        } while ($stillListening -and (Get-Date) -lt $deadline)
        if ($stillListening) { throw "端口 $Port 尚未释放，未启动第二套后端。" }
    }

    $previousPort = $env:DITING_PORT
    try {
        $env:DITING_PORT = [string]$Port
        if ($Background) {
            $logDir = Join-Path $dataDir 'logs'
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $stdout = Join-Path $logDir "background-$stamp.stdout.log"
            $stderr = Join-Path $logDir "background-$stamp.stderr.log"
            $node = (Get-Command node -ErrorAction Stop).Source
            $started = Start-Process -FilePath $node -ArgumentList @('--env-file-if-exists=.env', 'dist/apps/server/main.js') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
            $deadline = (Get-Date).AddSeconds(15)
            do {
                Start-Sleep -Milliseconds 500
                try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 } catch { $health = $null }
            } while (-not $health -and (Get-Date) -lt $deadline)
            if (-not $health -or $health.status -ne 'ok') { throw "后台服务未在 $Port 正常响应；请查看 $stderr" }
            Write-Host "DiTing 已在后台启动，PID $($started.Id)，健康状态 ok。日志：$stdout / $stderr"
            return
        }
        & npm.cmd start
        if ($LASTEXITCODE -ne 0) { throw "DiTing 服务退出，代码 $LASTEXITCODE" }
    } finally {
        $env:DITING_PORT = $previousPort
    }
} finally {
    Pop-Location
}
