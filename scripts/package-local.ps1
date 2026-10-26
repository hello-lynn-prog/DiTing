param([string]$AcceptanceFolder = '')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $AcceptanceFolder) {
    $taskPassedAcceptance = Get-ChildItem -LiteralPath (Join-Path $taskRoot 'data/qa') -Directory -Filter 'acceptance-*' |
        Sort-Object LastWriteTime -Descending | Where-Object {
            $taskResultFile = Join-Path $_.FullName 'result.json'
            if (-not (Test-Path -LiteralPath $taskResultFile)) { return $false }
            try { (Get-Content -LiteralPath $taskResultFile -Raw | ConvertFrom-Json).status -eq 'passed' } catch { $false }
        } | Select-Object -First 1
    if (-not $taskPassedAcceptance) { throw 'Run npm run test:acceptance successfully before packaging' }
    $AcceptanceFolder = $taskPassedAcceptance.FullName.Substring($taskRoot.Length+1)
}
$taskOutputRoot = Join-Path $taskRoot 'output'
$taskStamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss')
$taskDestination = Join-Path $taskOutputRoot ('DiTing-local-review-' + $taskStamp)
if (Test-Path -LiteralPath $taskDestination) { throw 'Packaging destination already exists' }
New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
foreach ($taskName in @('apps','packages','web','scripts','tests-ts','assets','docs','diting','tests','.github','.githooks')) {
    $taskSource = Join-Path $taskRoot $taskName
    foreach ($taskFile in Get-ChildItem -LiteralPath $taskSource -Recurse -File -Force) {
        if ($taskFile.FullName -match '[\\/]__pycache__[\\/]' -or $taskFile.Extension -in @('.pyc','.sqlite3','.key','.log')) { continue }
        $taskRelative = $taskFile.FullName.Substring($taskRoot.Length+1)
        $taskTarget = Join-Path $taskDestination $taskRelative
        New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
        Copy-Item -LiteralPath $taskFile.FullName -Destination $taskTarget
    }
}
foreach ($taskName in @('package.json','package-lock.json','tsconfig.json','.env.example','.gitignore','README.md','THIRD_PARTY_NOTICES.md','pyproject.toml','requirements-lock.txt')) {
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskName) -Destination (Join-Path $taskDestination $taskName)
}
New-Item -ItemType Directory -Path (Join-Path $taskDestination 'prototypes') | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'prototypes/diting-v5') -Destination (Join-Path $taskDestination 'prototypes/diting-v5') -Recurse
$taskVerification = Join-Path $taskDestination 'verification'
New-Item -ItemType Directory -Path $taskVerification | Out-Null
$taskAcceptance = [IO.Path]::GetFullPath((Join-Path $taskRoot $AcceptanceFolder))
if (-not $taskAcceptance.StartsWith((Join-Path $taskRoot 'data/qa/'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Acceptance path must stay in workspace data/qa' }
$taskAcceptanceResult = Get-Content -LiteralPath (Join-Path $taskAcceptance 'result.json') -Raw | ConvertFrom-Json
if ($taskAcceptanceResult.status -ne 'passed' -or @($taskAcceptanceResult.results | Where-Object { $_.status -ne 'passed' }).Count -gt 0) { throw 'Acceptance did not finish with every named check passing' }
Copy-Item -LiteralPath $taskAcceptance -Destination (Join-Path $taskVerification 'automated-acceptance') -Recurse
Copy-Item -LiteralPath (Join-Path $taskRoot 'data/diagnostics/semantic-real-smoke.json') -Destination $taskVerification
$taskManifest = [ordered]@{created_at=[DateTimeOffset]::UtcNow.ToString('o');kind='private-local-review-source';production_certified=$false;acceptance=$AcceptanceFolder;exclusions=@('data/','node_modules/','dist/','.env','.git/','prototypes/diting-v4/','model weights');prerequisites=@('Node.js 24+','npm ci','built dsh SDK via DITING_DSH_ROOT','local models via setup commands');files=@()}
foreach ($taskFile in Get-ChildItem -LiteralPath $taskDestination -Recurse -File) {
    $taskRelative = $taskFile.FullName.Substring($taskDestination.Length+1).Replace('\','/')
    if ($taskRelative -match '(^|/)(master\.key|diting\.sqlite3|\.env|__pycache__)(/|$)' -or $taskRelative -match 'diting-v4') { throw ('Excluded private/legacy file: ' + $taskRelative) }
    $taskManifest.files += [ordered]@{path=$taskRelative;bytes=$taskFile.Length;sha256=(Get-FileHash -LiteralPath $taskFile.FullName -Algorithm SHA256).Hash.ToLower()}
}
$taskManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskDestination 'release-manifest.json') -Encoding utf8
$taskZip = $taskDestination + '.zip'
Compress-Archive -LiteralPath $taskDestination -DestinationPath $taskZip -CompressionLevel Optimal
[pscustomobject]@{archive=$taskZip;folder=$taskDestination;files=$taskManifest.files.Count;bytes=(Get-Item -LiteralPath $taskZip).Length;sha256=(Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLower();production_certified=$false} | ConvertTo-Json
