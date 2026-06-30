param(
  [int]$Port = 59650,
  [string]$Token = "split-demo-token",
  [string]$Image = "nado-agent:local",
  [switch]$Build,
  [switch]$StopAfter
)

$ErrorActionPreference = "Stop"

function Info($message) {
  Write-Host "[nado split demo] $message"
}

function Wait-Control($baseUrl) {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get
      if ($health.ok) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 400
    }
  } while ((Get-Date) -lt $deadline)
  throw "Control server did not become healthy at $baseUrl"
}

function Wait-Workers($baseUrl, $token) {
  $headers = @{ Authorization = "Bearer $token" }
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $status = Invoke-RestMethod -Uri "$baseUrl/api/status" -Headers $headers
    $ids = @($status.workers.items | ForEach-Object { $_.id })
    if ($ids -contains "docker-report-a" -and $ids -contains "docker-report-b") {
      return $status
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  throw "Docker workers did not register before timeout"
}

function Stop-PidFile($pidFile) {
  if (!(Test-Path $pidFile)) {
    return
  }
  $oldPid = [int](Get-Content $pidFile -Raw)
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dataDir = Join-Path $repoRoot ".nado\split-demo-control-$Port"
$pidFile = Join-Path $dataDir "control.pid"
$agentScriptPath = Join-Path $dataDir "split-agent.js"
$baseUrl = "http://127.0.0.1:$Port"

Set-Location $repoRoot

Info "cleaning previous demo state"
$oldContainers = @(
  docker ps -aq --filter "name=^/nado-split-worker-a$"
  docker ps -aq --filter "name=^/nado-split-worker-b$"
) | Where-Object { $_ }
if ($oldContainers.Count) {
  docker rm -f $oldContainers | Out-Null
}
Stop-PidFile $pidFile
if (Test-Path $dataDir) {
  Remove-Item -LiteralPath $dataDir -Recurse -Force
}
New-Item -ItemType Directory -Path $dataDir | Out-Null

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  throw "Port $Port is already in use. Pass -Port 59651 or stop the process using that port."
}

docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0 -or $Build) {
  Info "building Docker image $Image"
  docker build -t $Image .
}

Info "starting control on $baseUrl"
$control = Start-Process -FilePath "node" -ArgumentList @(
  ".\src\cli.js",
  "control",
  "start",
  "--host",
  "0.0.0.0",
  "--port",
  "$Port",
  "--data-dir",
  $dataDir,
  "--token",
  $Token,
  "--dashboard-auto-token"
) -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
Set-Content -Path $pidFile -Value $control.Id
Wait-Control $baseUrl

$agentScript = @'
const fs = require('fs');
const path = require('path');

const prompt = fs.readFileSync(process.argv[2], 'utf8');
const worker = process.env.NADO_WORKER_ID || 'worker';
const focus = (prompt.match(/Your focus: ([^\n]+)/) || [])[1] || prompt;
const dependencyRoot = '.nado/dependencies';

function dependencyResults() {
  if (!fs.existsSync(dependencyRoot)) {
    return [];
  }
  return fs.readdirSync(dependencyRoot)
    .sort()
    .map((key) => path.join(dependencyRoot, key, 'result.md'))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'));
}

if (prompt.includes('Read every available shard result') || prompt.includes('Nado reducer')) {
  const parts = dependencyResults();
  fs.writeFileSync('final.md', `# Distributed report final

${parts.join('\n\n---\n\n')}
`);
  console.log(`FINAL ${worker} deps=${parts.length}`);
} else if (focus.includes('lower half')) {
  fs.writeFileSync('result.md', `# Report lower half

Worker container: ${worker}

Execution plan, risks, and acceptance criteria.
`);
  console.log(`B ${worker}`);
} else if (focus.includes('upper half')) {
  fs.writeFileSync('result.md', `# Report upper half

Worker container: ${worker}

Background, goals, and architecture overview.
`);
  console.log(`A ${worker}`);
} else {
  fs.writeFileSync('result.md', `# Report fragment

Worker container: ${worker}

${focus}
`);
  console.log(`GENERIC ${worker}`);
}
'@

Set-Content -Path $agentScriptPath -Value $agentScript -Encoding UTF8
$agentCommand = "node /agent/split-agent.js {promptFile}"
$agentMount = "type=bind,source=$agentScriptPath,target=/agent/split-agent.js,readonly"

Info "starting Docker worker A"
docker run -d `
  --name nado-split-worker-a `
  --add-host=host.docker.internal:host-gateway `
  --mount $agentMount `
  -e "NADO_TOKEN=$Token" `
  -e "NADO_AGENT_COMMAND=$agentCommand" `
  $Image `
  worker start `
  --control "http://host.docker.internal:$Port" `
  --id docker-report-a `
  --capability docs `
  --label split=A `
  --max-concurrency 1 `
  --poll-ms 300 `
  --data-dir /data/worker | Out-Null

Info "starting Docker worker B"
docker run -d `
  --name nado-split-worker-b `
  --add-host=host.docker.internal:host-gateway `
  --mount $agentMount `
  -e "NADO_TOKEN=$Token" `
  -e "NADO_AGENT_COMMAND=$agentCommand" `
  $Image `
  worker start `
  --control "http://host.docker.internal:$Port" `
  --id docker-report-b `
  --capability docs `
  --label split=B `
  --max-concurrency 1 `
  --poll-ms 300 `
  --data-dir /data/worker | Out-Null

$status = Wait-Workers $baseUrl $Token
Info "registered workers:"
$status.workers.items |
  Where-Object { $_.id -in @("docker-report-a", "docker-report-b") } |
  Select-Object id, observedState, capabilities, lastSeenAt |
  Format-Table -AutoSize

$headers = @{
  Authorization = "Bearer $Token"
  "Content-Type" = "application/json"
}
$body = @{
  title = "docker split report demo"
  prompt = "Write a short report about Nado distributed worker collaboration. Merge the shard outputs into one final report."
  mode = "map_reduce"
  type = "agent"
  requireRoutable = $true
  subtasks = @(
    @{
      key = "part_a"
      title = "Report upper half"
      prompt = "Write the upper half: background, goals, and architecture overview"
      workerId = "docker-report-a"
      capabilities = @("docs")
    },
    @{
      key = "part_b"
      title = "Report lower half"
      prompt = "Write the lower half: execution plan, risks, and acceptance criteria"
      workerId = "docker-report-b"
      capabilities = @("docs")
    }
  )
} | ConvertTo-Json -Depth 8

Info "submitting distributed planner run"
$created = Invoke-RestMethod -Uri "$baseUrl/api/planner/run" -Method Post -Headers $headers -Body $body
$batchId = $created.batch.id
Info "batch $batchId created"
$created.routing | Select-Object key, workerId, reason | Format-Table -AutoSize

$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Milliseconds 800
  $batch = Invoke-RestMethod -Uri "$baseUrl/api/batches/$batchId" -Headers @{ Authorization = "Bearer $Token" }
  Info "status=$($batch.batch.status) completed=$($batch.batch.completedTasks)/$($batch.batch.totalTasks)"
} while ($batch.batch.status -notin @("succeeded", "completed_with_errors", "cancelled") -and (Get-Date) -lt $deadline)

if ($batch.batch.status -ne "succeeded") {
  throw "Batch $batchId ended with status $($batch.batch.status)"
}

Info "task routing result:"
$batch.tasks |
  Select-Object batchKey, status, assignedWorkerId, requestedWorkerId, stdout |
  Format-Table -AutoSize

$artifacts = Invoke-RestMethod -Uri "$baseUrl/api/batches/$batchId/artifacts/content" -Headers @{ Authorization = "Bearer $Token" }
$final = $artifacts.tasks |
  Where-Object { $_.batchKey -eq "final_synthesis" } |
  Select-Object -First 1
$finalArtifact = $final.artifacts |
  Where-Object { $_.path -eq "final.md" } |
  Select-Object -First 1

if (!$finalArtifact) {
  throw "final.md artifact was not found"
}

$finalText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($finalArtifact.contentBase64))
Write-Host ""
Write-Host "===== final.md ====="
Write-Host $finalText
Write-Host "===================="
Write-Host ""
Write-Host "Dashboard: $baseUrl/dashboard"
Write-Host "Token:     $Token"

if ($StopAfter) {
  Info "stopping demo resources"
  $containers = @(
    docker ps -aq --filter "name=^/nado-split-worker-a$"
    docker ps -aq --filter "name=^/nado-split-worker-b$"
  ) | Where-Object { $_ }
  if ($containers.Count) {
    docker rm -f $containers | Out-Null
  }
  Stop-Process -Id $control.Id -Force -ErrorAction SilentlyContinue
} else {
  Info "left control and workers running so you can inspect the dashboard"
}
