#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startControlServer } from './control-server.js';
import { NadoClient } from './http-client.js';
import { reconnectDelay, startWorker } from './worker-client.js';
import { formatBatchReport } from './batch-report.js';
import { buildAgentContext, installAgentContext, writeAgentContext } from './context.js';
import { runDoctor } from './doctor.js';
import { collectLocalInputFiles } from './input-files.js';
import { buildWorkerInvite } from './invite.js';
import { buildWorkerBootstrapBundle, buildWorkerBundle } from './worker-bundle.js';
import {
  confirmPendingWorkerTokenRotation,
  ensureEnrolledWorker,
  readWorkerIdentity,
  rotateEnrolledWorkerToken,
} from './worker-enrollment.js';
import { buildMcpClientConfig, formatMcpCommand } from './mcp-config.js';
import { listAgentPresets, resolveAgentCommand } from './agent-presets.js';
import { buildBatchPlan } from './batch-plan.js';
import { runVerify } from './verify.js';
import { buildDemoRouteChecks, demoRouteChecksOk } from './demo-health.js';
import { routingActionHint } from './routing-diagnostics.js';
import { controlUrlFromHostPort, parseCsvValues, requireValue, safeName, sleep } from './utils.js';
import { workerReadinessDiagnostics, workerResourceDiagnostics } from './worker-diagnostics.js';
import { inspectLocalWorker } from './worker-inspect.js';
import { collectInventory } from './inventory.js';
import { createControlBackup, restoreControlBackup, verifyControlBackup } from './store-backup.js';
import {
  acceptanceEvidenceTemplate,
  buildCrossSiteAcceptanceReport,
  initializeAcceptanceEvidence,
  recordAcceptanceEvidence,
} from './cross-site-acceptance.js';
import { buildAcceptanceRunbook } from './acceptance-runbook.js';
import {
  runBackupRestoreExercise,
  runAgentCollaborationExercise,
  runLargeArtifactResumeExercise,
  runLargeInputResumeExercise,
  runLongDisconnectRecoveryExercise,
  runRemoteCancellationExercise,
  runShortDisconnectExercise,
  runVmRestartRecoveryExercise,
  runWorkerRestartRecoveryExercise,
} from './acceptance-exercises.js';
import {
  inspectDockerComposeBindings,
  inspectDockerComposeControlSecurity,
  runDeploymentCheck,
} from './deployment-check.js';
import { probeControlClock } from './clock-skew.js';
import { runtimeBuildCompatibility } from './runtime-build.js';

function usage() {
  return `Nado Agent

Usage:
  nado quickstart [--host 127.0.0.1] [--port 8765] [--public-control-url URL] [--trust-proxy] [--trust-proxy-secret SECRET] [--task-lease-ms 60000] [--auto-recover-offline-ms 120000] [--data-dir .nado/quickstart] [--store json|sqlite] [--token TOKEN] [--generate-token-file FILE] [--worker local-worker] [--capability code] [--agent codex|claude|node-copy] [--agent-command CMD] [--completion-retries 16] [--completion-retry-base-ms 250] [--completion-retry-max-ms 5000] [--network-probe-bytes 65536] [--network-probe-interval-ms 300000] [--mcp-name nado] [--no-dashboard-auto-token] [--once]
  nado control start [--host 127.0.0.1] [--port 8765] [--public-control-url URL] [--trust-proxy] [--trust-proxy-secret SECRET] [--task-lease-ms 60000] [--auto-recover-offline-ms 120000] [--control-data-lease-timeout-ms 60000] [--audit-ndjson-file /var/log/nado/audit.ndjson] [--audit-ndjson-max-pending 1024] [--data-dir .nado] [--store json|sqlite] [--token TOKEN] [--generate-token-file FILE] [--dashboard-auto-token]
  nado store backup --data-dir .nado --out ./nado-backup [--store json|sqlite] --offline-confirmed [--json]
  nado store verify --from ./nado-backup [--json]
  nado store restore --from ./nado-backup --data-dir ./restored-control --offline-confirmed [--json]
  nado worker start --control URL --id ID [--capability code] [--agent codex|claude|node-copy] [--agent-command CMD] [--max-concurrency 1] [--long-poll-ms 20000] [--reconnect-base-ms 1000] [--reconnect-max-ms 30000] [--completion-retries 16] [--completion-retry-base-ms 250] [--completion-retry-max-ms 5000] [--network-probe-bytes 65536] [--network-probe-interval-ms 300000] [--cleanup-workspaces]
  nado worker bootstrap-start --control URL --enrollment-token TOKEN [--id optional-id] [--capability code] [--agent codex|claude|node-copy] [--strict-local-readiness] [--max-concurrency 1] [--token-rotation-interval-ms 0] [--completion-retries 16] [--completion-retry-base-ms 250] [--completion-retry-max-ms 5000] [--network-probe-bytes 65536] [--network-probe-interval-ms 300000] [--cleanup-workspaces]
  nado worker inspect [--data-dir .nado] [--capability code] [--agent codex|claude] [--require-gpu] [--require-agent] [--require-identity] [--require-capability code] [--tool amd-smi] [--platform linux|win32|darwin] [--arch x64|arm64] [--cpu 8] [--memory 32GiB] [--gpu-count 1] [--vram 16GiB] [--gpu-model MI300] [--out ./worker-inspect.json] [--json]
  nado worker preflight --control URL --id ID [--data-dir .nado]
  nado worker logs --control URL --id ID [--tail 50] [--watch]
  nado worker invite --control URL --id ID [--bundle-control-url URL] [--public-control-url URL] [--capability code] [--agent codex|claude|node-copy] [--issue-token] [--format bash|powershell] [--cleanup-workspaces]
  nado worker bundle --control URL --id ID [--bundle-control-url URL] [--public-control-url URL] [--data-dir /stable/worker-data] [--capability code] [--agent codex|claude|node-copy] [--issue-token] [--out ./nado-worker.zip] [--cleanup-workspaces]
  nado worker bootstrap-bundle --control URL [--bundle-control-url URL] [--public-control-url URL] [--data-dir /stable/worker-data] [--out ./nado-worker-bootstrap.zip] [--capability code] [--agent codex|claude|node-copy] [--strict-local-readiness] [--max-uses N] [--cleanup-workspaces]
  nado agents
  nado worker token create --control URL --id ID [--label LABEL] [--expires-at ISO]
  nado worker token rotate --control URL [--data-dir .nado] [--ttl-ms 600000] [--verify] [--evidence ./acceptance-evidence.json]
  nado worker tokens --control URL [--worker ID]
  nado worker token revoke TOKEN_ID --control URL
  nado worker enrollments --control URL
  nado worker enrollments prune [--dry-run] [--json] --control URL
  nado worker enrollment revoke TOKEN_ID --control URL
  nado worker manage --control URL --id ID --action pause|resume|drain|shutdown|cancel_current|rotate_token|forget [--wait] [--evidence ./acceptance-evidence.json]
  nado status --control URL
  nado audit --control URL [--tail 100] [--actor-type admin|worker|worker_enrollment|anonymous] [--outcome success|denied|error] [--status-code 403] [--json] [--out ./audit.ndjson]
  nado acceptance template --out ./acceptance-evidence.json
  nado acceptance evidence init --file ./acceptance-evidence.json
  nado acceptance evidence record --file ./acceptance-evidence.json --scenario SCENARIO --status passed|failed|pending [--note TEXT] [--reference REF]
  nado acceptance runbook --control URL --worker ID [--deployment-mode public_https|tailscale|wireguard] [--overlay-interface NAME] [--require-gpu] [--no-require-agent] [--source-data-dir PATH] [--backup-dir PATH] [--restored-data-dir PATH] [--out ./acceptance-runbook.sh] [--json]
  nado acceptance exercise remote-cancellation --control URL --worker ID --evidence ./acceptance-evidence.json [--timeout 60000] [--json]
  nado acceptance exercise agent-collaboration --control URL --worker ID --evidence ./acceptance-evidence.json [--timeout 180000] [--json]
  nado acceptance exercise short-disconnect --control URL --worker ID --evidence ./acceptance-evidence.json [--min-disconnect-ms 5000] [--task-duration-ms 90000] [--timeout 180000] [--json]
  nado acceptance exercise long-disconnect-recovery --control URL --worker ID --evidence ./acceptance-evidence.json [--first-attempt-ms auto] [--timeout 300000] [--json]
  nado acceptance exercise vm-restart-recovery --control URL --worker ID --evidence ./acceptance-evidence.json [--task-duration-ms 90000] [--timeout 300000] [--json]
  nado acceptance exercise worker-restart-recovery --control URL --worker ID --evidence ./acceptance-evidence.json [--timeout 300000] [--json]
  nado acceptance exercise large-artifact-resume --control URL --worker ID --evidence ./acceptance-evidence.json [--artifact-bytes 67108864] [--min-stall-ms 5000] [--timeout 300000] [--json]
  nado acceptance exercise large-input-resume --control URL --worker ID --evidence ./acceptance-evidence.json [--input-bytes 67108864] [--min-stall-ms 5000] [--timeout 300000] [--json]
  nado acceptance exercise backup-restore --control URL --worker ID --source-data-dir PATH --backup-dir PATH --restored-data-dir NEW_PATH --evidence ./acceptance-evidence.json [--timeout 600000] [--json]
  nado acceptance --control URL --worker ID [--require-gpu] [--no-require-agent] [--run-verify] [--deployment-evidence ./deployment-check.json] [--evidence ./acceptance-evidence.json] [--out ./acceptance-report.json] [--require-complete] [--json]
  nado deployment check --control URL [--backend http://127.0.0.1:8765] [--require-https] [--require-proxy-auth] [--require-container-hardening] [--overlay tailscale|wireguard] [--overlay-interface NAME] [--compose-file docker-compose.azure.yml] [--timeout 15000] [--out ./deployment-check.json] [--json]
  nado network --control URL [--json]
  nado demo health --control URL [--timeout 60000] [--skip-verify] [--no-prune] [--json]
  nado demo reset --control URL [--keep 0] [--dry-run] [--yes] [--no-system] [--keep-empty-sessions] [--json]
  nado capabilities --control URL
  nado verify --control URL [--worker ID] [--all-workers] [--capability code] [--tool node] [--required-label zone=lab] [--timeout 30000] [--skip-doctor] [--json]
  nado doctor --control URL [--self-test] [--agent-self-test] [--all-workers] [--worker ID] [--capability code] [--tool node] [--required-label zone=lab] [--timeout 15000]
  nado workers --control URL
  nado session create --control URL --title TITLE [--worker ID] [--capability code] [--tool codex] [--required-label zone=lab] [--platform linux|win32|darwin] [--arch x64|arm64] [--cpu 4] [--memory 16GiB] [--gpu-count 1] [--vram 12GiB] [--gpu-model RTX]
  nado sessions --control URL
  nado session SESSION_ID --control URL
  nado session close SESSION_ID --control URL
  nado session download SESSION_ID --out ./downloads --control URL
  nado submit --control URL (--command CMD | --prompt PROMPT) [--worker ID] [--capability gpu] [--tool codex] [--required-label zone=lab] [--platform linux|win32|darwin] [--arch x64|arm64] [--cpu 4] [--memory 16GiB] [--gpu-count 1] [--vram 12GiB] [--gpu-model RTX] [--env KEY=value] [--sandbox|--sandbox-profile isolated] [--artifact dist/**] [--exclude-artifact tmp/**] [--dependency-artifacts] [--slots 2] [--priority 10] [--max-attempts 3] [--retry-on timeout,worker_error] [--retry-exit-code 75,124] [--retry-backoff-ms 1000] [--max-retry-backoff-ms 60000] [--idempotency-key KEY] [--session SESSION_ID] [--file ./input.md] [--dir ./project] [--cleanup-workspace] [--keep-workspace] [--require-routable] [--wait] [--watch] [--download --out ./downloads] [--wait-timeout 60000] [--type shell|agent]
  nado batch plan --title TITLE (--task "key: task" | --tasks-file ./tasks.txt) [--type agent|shell] [--command-template CMD] [--worker ID] [--capability code] [--tool node] [--required-label zone=lab] [--out ./batch.json]
  nado planner plan --control URL (--prompt PROMPT | --prompt-file ./brief.md) [--mode auto|parallel|pipeline|map_reduce|review] [--subtask "key: focus"] [--shards 4] [--out ./batch.json] [--json]
  nado planner run --control URL (--prompt PROMPT | --prompt-file ./brief.md) [--mode auto|parallel|pipeline|map_reduce|review] [--subtask "key: focus"] [--require-routable] [--wait] [--report] [--download --out ./downloads]
  nado dispatch plan --control URL (--file ./batch.json | --task "key: task") [--type agent|shell] [--command-template CMD] [--worker ID] [--capability code] [--tool node] [--required-label zone=lab] [--json]
  nado batch submit --control URL --file ./batch.json [--require-routable] [--wait] [--report] [--download --out ./downloads] [--timeout 60000]
  nado batches --control URL
  nado batch BATCH_ID --control URL
  nado batch events BATCH_ID [--watch] --control URL
  nado batch wait BATCH_ID [--timeout 60000] --control URL
  nado batch report BATCH_ID --control URL
  nado batch download BATCH_ID --out ./downloads --control URL
  nado batch manage BATCH_ID --action retry_failed|cancel [--worker ID] [--capability code] [--tool node] [--slots 2] [--required-label zone=lab] --control URL
  nado tasks --control URL
  nado task TASK_ID --control URL
  nado schedule TASK_ID --control URL
  nado wait TASK_ID [--watch] [--timeout 60000] --control URL
  nado recover [--action list|requeue] [--worker OFFLINE_ID] [--target-worker ID] [--capability code] [--tool node] [--slots 2] [--required-label zone=lab] [--include-sessions] --control URL
  nado task manage TASK_ID --action cancel|requeue|reschedule [--worker ID] [--capability code] [--tool node] [--slots 2] [--required-label zone=lab] --control URL
  nado history prune-system [--dry-run] [--json] --control URL
  nado events TASK_ID --control URL
  nado artifacts TASK_ID --control URL
  nado artifacts download TASK_ID --out ./downloads --control URL
  nado artifact download TASK_ID ARTIFACT_ID --out ./downloads --control URL
  nado context --control URL [--out .nado/AGENTS.md]
  nado context install --control URL [--out ./AGENTS.md]
  nado mcp config --control URL [--name nado] [--format json|command]
  nado mcp --control URL

Environment:
  NADO_TOKEN       admin bearer token for control commands, or worker token for worker start
  NADO_ADMIN_TOKENS  optional comma-separated extra admin tokens for rotation
  NADO_CONTROL     default control URL for CLI/worker commands
  NADO_STORE       control storage backend: json (default) or sqlite
  NADO_PUBLIC_CONTROL_URL  browser/remote-worker reachable public Control URL advertised by control APIs
  NADO_TRUST_PROXY         enable authenticated trusted-proxy mode
  NADO_TRUST_PROXY_SECRET  shared secret required in X-Nado-Proxy-Secret before forwarded headers are trusted
  NADO_AUTO_RECOVER_OFFLINE_MS  opt-in grace period before offline tasks are requeued; sessions stay pinned to their workspace-owning Worker
  NADO_TASK_LEASE_MS             task execution lease duration renewed by worker heartbeats (default 60000)
  NADO_WORKER_RECONNECT_BASE_MS  initial worker reconnect delay after a control-plane error
  NADO_WORKER_RECONNECT_MAX_MS   maximum worker reconnect delay after repeated errors
  NADO_WORKER_COMPLETION_RETRIES maximum completion delivery attempts before releasing the worker slot
  NADO_WORKER_COMPLETION_RETRY_BASE_MS initial completion delivery retry delay
  NADO_WORKER_COMPLETION_RETRY_MAX_MS  maximum completion delivery retry delay
  NADO_TASK_EVENT_RETRIES        maximum live task-event delivery attempts
  NADO_TASK_EVENT_RETRY_BASE_MS  initial live task-event retry delay
  NADO_TASK_EVENT_RETRY_MAX_MS   maximum live task-event retry delay
  NADO_TASK_EVENT_MAX_PENDING    bounded ordered live task-event queue (default 256)
  NADO_WORKER_EVENT_RETRIES      maximum critical Worker-event delivery attempts
  NADO_WORKER_EVENT_RETRY_BASE_MS initial critical Worker-event retry delay
  NADO_WORKER_EVENT_RETRY_MAX_MS maximum critical Worker-event retry delay
  NADO_WORKER_LONG_POLL_MS       idle worker claim long-poll timeout; set 0 for compatibility polling
  NADO_WORKER_TOKEN_ROTATION_INTERVAL_MS  self-service Worker credential rotation interval; 0 disables automatic rotation
  NADO_NETWORK_PROBE_BYTES       bounded upload/download sample size (4096-1048576)
  NADO_NETWORK_PROBE_INTERVAL_MS sample interval; set 0 to disable, otherwise minimum 60000
  NADO_ARTIFACT_INLINE_MAX_BYTES maximum single artifact embedded in result JSON
  NADO_ARTIFACT_INLINE_TOTAL_BYTES maximum total artifacts embedded in result JSON
  NADO_ARTIFACT_CHUNK_BYTES      resumable artifact upload chunk size (default 4 MiB)
  NADO_ARTIFACT_MAX_FILE_BYTES   hard collection limit for one artifact
  NADO_ARTIFACT_MAX_TOTAL_BYTES  hard collection limit across one task
  NADO_INPUT_INLINE_MAX_BYTES    maximum single input embedded in task JSON
  NADO_INPUT_INLINE_TOTAL_BYTES  maximum total inputs embedded in task JSON
  NADO_INPUT_CHUNK_BYTES         resumable control-side input upload chunk size
  NADO_INPUT_MAX_FILE_BYTES      hard local collection limit for one input
  NADO_INPUT_MAX_TOTAL_BYTES     hard local collection limit across one task
  NADO_DOCKER_HOST_IP      Docker demo host port bind address, for example :: for IPv6
`;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    index += 1;
    if (args[key] === undefined) {
      args[key] = next;
    } else if (Array.isArray(args[key])) {
      args[key].push(next);
    } else {
      args[key] = [args[key], next];
    }
  }
  return args;
}

function valueList(value) {
  if (value === undefined) {
    return [];
  }
  return parseCsvValues(Array.isArray(value) ? value : [value]);
}

function parseLabels(values) {
  const labels = {};
  for (const entry of valueList(values)) {
    const [key, ...rest] = entry.split('=');
    if (key) {
      labels[key] = rest.join('=') || 'true';
    }
  }
  return labels;
}

function parseEnv(values) {
  const env = {};
  for (const entry of valueList(values)) {
    const [key, ...rest] = entry.split('=');
    if (key) {
      env[key] = rest.join('=');
    }
  }
  return env;
}

async function readTaskLines(args) {
  const inline = valueList(args.task || args.tasks);
  const files = valueList(args['tasks-file'] || args['task-file']);
  const fromFiles = [];
  for (const file of files) {
    const text = await fs.readFile(path.resolve(file), 'utf8');
    fromFiles.push(...text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  }
  return [...inline, ...fromFiles];
}

function parseTools(values) {
  return valueList(values);
}

function parseSlots(value) {
  if (value === undefined) {
    return undefined;
  }
  return Number(value);
}

function retryPolicyFromArgs(args) {
  const failureKinds = valueList(args['retry-on'] || args.retryOn);
  const exitCodes = valueList(args['retry-exit-code'] || args['retry-exit-codes'] || args.retryExitCodes)
    .map((value) => Number(value));
  return failureKinds.length || exitCodes.length ? { failureKinds, exitCodes } : undefined;
}

function resourceRequirementsFromArgs(args) {
  const requiredResources = {
    platform: args.platform ?? args.os,
    arch: args.arch ?? args.architecture,
    cpuCores: args.cpu ?? args['cpu-cores'],
    memory: args.memory ?? args.ram,
    gpuCount: args['gpu-count'] ?? args.gpus,
    gpuMemory: args.vram ?? args['gpu-memory'],
    gpuModel: args['gpu-model'],
  };
  return Object.values(requiredResources).some((value) => value !== undefined && value !== '')
    ? requiredResources
    : undefined;
}

function sandboxProfileFromArgs(args) {
  if (args.sandbox) {
    return 'isolated';
  }
  return args['sandbox-profile'] || args.sandboxProfile || undefined;
}

function agentOptionsFromArgs(args) {
  return resolveAgentCommand({
    agentPreset: args.agent || args['agent-preset'] || args.agentPreset,
    agentCommand: args['agent-command'] || process.env.NADO_AGENT_COMMAND || null,
  });
}

function workerCompletionOptionsFromArgs(args) {
  return {
    completionRetries: Number(
      args['completion-retries'] ?? process.env.NADO_WORKER_COMPLETION_RETRIES ?? 0,
    ) || undefined,
    completionRetryBaseMs: Number(
      args['completion-retry-base-ms'] ?? process.env.NADO_WORKER_COMPLETION_RETRY_BASE_MS ?? 0,
    ) || undefined,
    completionRetryMaxMs: Number(
      args['completion-retry-max-ms'] ?? process.env.NADO_WORKER_COMPLETION_RETRY_MAX_MS ?? 0,
    ) || undefined,
  };
}

function artifactPolicyFromArgs(args) {
  const include = [
    ...valueList(args.artifact),
    ...valueList(args.artifacts),
    ...valueList(args['artifact-include']),
    ...valueList(args['artifact-includes']),
  ];
  const exclude = [
    ...valueList(args['exclude-artifact']),
    ...valueList(args['exclude-artifacts']),
    ...valueList(args['artifact-exclude']),
    ...valueList(args['artifact-excludes']),
  ];
  if (!include.length && !exclude.length) {
    return undefined;
  }
  return { include, exclude };
}

function formatArtifactPolicy(policy = {}) {
  const include = policy.include?.length ? policy.include.join(',') : 'all';
  const exclude = policy.exclude?.length ? policy.exclude.join(',') : '-';
  return `include:${include} exclude:${exclude}`;
}

function dependencyArtifactsFromArgs(args) {
  if (!args['dependency-artifacts'] && !args['dependency-artifact'] && !args['dependency-artifacts-include']) {
    return undefined;
  }
  const include = [
    ...valueList(args['dependency-artifact']),
    ...valueList(args['dependency-artifacts-include']),
  ];
  const exclude = [
    ...valueList(args['exclude-dependency-artifact']),
    ...valueList(args['dependency-artifacts-exclude']),
  ];
  if (!include.length && !exclude.length && !args['dependency-artifacts-prefix']) {
    return true;
  }
  return {
    enabled: true,
    prefix: args['dependency-artifacts-prefix'],
    include,
    exclude,
  };
}

function formatLabels(labels = {}) {
  const entries = Object.entries(labels || {});
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(',') : '-';
}

function formatMetricBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '-';
  }
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)}${units[unit]}`;
}

function formatBandwidth(value) {
  const bytesPerSecond = Number(value);
  return Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0
    ? `${Math.round(((bytesPerSecond * 8) / 1_000_000) * 10) / 10}Mbps`
    : '-';
}

function printSchedulerSummary(scheduler) {
  if (!scheduler) {
    return;
  }
  console.log(`schedulerWorker=${scheduler.workerId || '-'}`);
  console.log(`schedulerReason=${scheduler.reason || '-'}`);
  console.log(`schedulerInferredCapabilities=${scheduler.inferredCapabilities?.join(',') || '-'}`);
  console.log(`schedulerEffectiveCapabilities=${scheduler.effectiveRequiredCapabilities?.join(',') || '-'}`);
  console.log(`schedulerRequiredResources=${JSON.stringify(scheduler.requiredResources || {})}`);
  for (const reason of scheduler.inferenceReasons || []) {
    console.log(`schedulerInference=${reason.capability || '-'} reason=${reason.reason || '-'} evidence=${reason.evidence || '-'}`);
  }
  for (const warning of scheduler.warnings || []) {
    console.log(`schedulerWarning=${warning.code || '-'} severity=${warning.severity || '-'} worker=${warning.workerId || '-'} message=${warning.message || '-'}`);
  }
  for (const candidate of scheduler.candidates || []) {
    const score = candidate.score === null || candidate.score === undefined ? '-' : candidate.score;
    console.log(`schedulerCandidate=${candidate.workerId || '-'} eligible=${candidate.eligible} score=${score} reasons=${candidate.reasons?.join('; ') || '-'}`);
  }
}

function printBatchTaskSchedulerSummary(task) {
  const scheduler = task.scheduler;
  if (!scheduler) {
    return;
  }
  console.log(`  scheduler worker=${scheduler.workerId || '-'} reason=${scheduler.reason || '-'} inferred=${scheduler.inferredCapabilities?.join(',') || '-'} effective=${scheduler.effectiveRequiredCapabilities?.join(',') || task.requiredCapabilities?.join(',') || '-'}`);
  for (const reason of scheduler.inferenceReasons || []) {
    console.log(`  inference ${reason.capability || '-'} reason=${reason.reason || '-'} evidence=${reason.evidence || '-'}`);
  }
  for (const warning of scheduler.warnings || []) {
    console.log(`  warning ${warning.code || '-'} severity=${warning.severity || '-'} worker=${warning.workerId || '-'} message=${warning.message || '-'}`);
  }
  for (const candidate of scheduler.candidates || []) {
    const score = candidate.score === null || candidate.score === undefined ? '-' : candidate.score;
    console.log(`  candidate ${candidate.workerId || '-'}: eligible=${candidate.eligible} score=${score} reasons=${candidate.reasons?.join('; ') || '-'}`);
  }
}

async function buildInputFiles(values) {
  return collectLocalInputFiles({
    files: valueList(values.files),
    dirs: valueList(values.dirs),
  }, {
    baseDir: values.baseDir || '.',
  });
}

function submittedInputFile(file) {
  const { localPath, ...submitted } = file;
  return submitted;
}

async function uploadLocalTaskInput(client, task, localFile, options = {}) {
  const descriptor = (task.inputFiles || []).find((file) => (
    file.inputUploadId
    && file.path === localFile.path
    && file.size === localFile.size
    && file.sha256 === localFile.sha256
  ));
  if (!descriptor) {
    throw new Error(`Task did not create an upload slot for input: ${localFile.path}`);
  }
  const chunkBytes = Math.max(64 * 1024, Math.min(
    16 * 1024 * 1024,
    Number(options.chunkBytes || process.env.NADO_INPUT_CHUNK_BYTES || 4 * 1024 * 1024),
  ));
  const maxRetries = Math.max(1, Number(options.maxRetries || 8));
  const handle = await fs.open(localFile.localPath, 'r');
  let status = await client.getTaskInputUpload(task.id, descriptor.inputUploadId);
  let offset = Number(status.upload.committedBytes || 0);
  try {
    while (offset < localFile.size) {
      const length = Math.min(chunkBytes, localFile.size - offset);
      const bytes = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(`Input file changed or ended during upload: ${localFile.path}`);
      }
      let delivered = false;
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries && !delivered; attempt += 1) {
        try {
          const response = await client.uploadTaskInputChunk(task.id, descriptor.inputUploadId, offset, bytes);
          offset = Number(response.upload.committedBytes);
          delivered = true;
        } catch (error) {
          lastError = error;
          if ([400, 401, 403, 404, 413, 422].includes(error.status)) {
            throw error;
          }
          try {
            status = await client.getTaskInputUpload(task.id, descriptor.inputUploadId);
            const committed = Number(status.upload.committedBytes || 0);
            if (committed !== offset) {
              offset = committed;
              delivered = true;
              break;
            }
          } catch (statusError) {
            if ([400, 401, 403, 404, 413, 422].includes(statusError.status)) {
              throw statusError;
            }
          }
          if (attempt < maxRetries) {
            await sleep(reconnectDelay(attempt, { baseMs: 250, maxMs: 5_000 }));
          }
        }
      }
      if (!delivered) {
        throw lastError || new Error(`Input chunk upload failed: ${localFile.path}`);
      }
    }
  } finally {
    await handle.close();
  }
  await client.finalizeTaskInputUpload(task.id, descriptor.inputUploadId);
}

async function uploadLocalTaskInputs(client, task, localFiles = []) {
  for (const file of localFiles.filter((item) => item.localPath)) {
    await uploadLocalTaskInput(client, task, file);
  }
  return localFiles.some((file) => file.localPath)
    ? (await client.getTask(task.id)).task
    : task;
}

function tokenFrom(args, { allowGenerate = false } = {}) {
  if (args.token) {
    return args.token;
  }
  if (process.env.NADO_TOKEN) {
    return process.env.NADO_TOKEN;
  }
  if (allowGenerate) {
    return crypto.randomBytes(16).toString('hex');
  }
  throw new Error('Missing token. Set NADO_TOKEN or pass --token.');
}

function loopbackListenHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function remoteFacingControl(options) {
  return !loopbackListenHost(options.host)
    || Boolean(options.publicControlUrl)
    || Boolean(options.trustProxy);
}

async function controlStartToken(args, options) {
  const supplied = args.token || process.env.NADO_TOKEN || '';
  const outputArg = args['generate-token-file'] || args.generateTokenFile || '';
  if (supplied && outputArg) {
    throw new Error('--generate-token-file cannot be combined with --token or NADO_TOKEN');
  }
  if (supplied) {
    return {
      token: supplied,
      source: args.token ? 'argument' : 'environment',
      outputFile: null,
    };
  }

  const remotelyExposed = remoteFacingControl(options);
  if (remotelyExposed && !outputArg) {
    throw new Error(
      'Remote-facing control start requires NADO_TOKEN/--token or --generate-token-file <private-file>; refusing to print a generated administrator token into service logs',
    );
  }

  const token = crypto.randomBytes(32).toString('hex');
  if (!outputArg) {
    return { token, source: 'generated_terminal', outputFile: null };
  }

  const outputFile = path.resolve(outputArg);
  if (pathInside(options.dataDir, outputFile)) {
    throw new Error('--generate-token-file must be outside the Control data directory so verified backups cannot capture the administrator credential');
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(outputFile, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await fs.chmod(outputFile, 0o600);
  return { token, source: 'generated_file', outputFile };
}

function controlUrlFrom(args) {
  return args.control || process.env.NADO_CONTROL || 'http://127.0.0.1:8765';
}

function makeClient(args) {
  return new NadoClient({
    controlUrl: controlUrlFrom(args),
    token: tokenFrom(args),
  });
}

function loopbackControlUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

async function bundleControlUrlFromArgs(args, client, fallbackControlUrl) {
  const explicit = args['bundle-control-url']
    || args.bundleControlUrl
    || args['public-control-url']
    || args.publicControlUrl
    || process.env.NADO_PUBLIC_CONTROL_URL
    || '';
  if (explicit) {
    return {
      controlUrl: explicit,
      source: args['bundle-control-url'] || args.bundleControlUrl
        ? 'bundle-control-url'
        : 'public-control-url',
      warning: null,
    };
  }

  if (!loopbackControlUrl(fallbackControlUrl)) {
    return {
      controlUrl: fallbackControlUrl,
      source: 'control',
      warning: null,
    };
  }

  try {
    const network = await client.networkInfo();
    if (loopbackControlUrl(fallbackControlUrl) && network.preferredRemoteControlUrl) {
      return {
        controlUrl: network.preferredRemoteControlUrl,
        source: network.nextAction?.code || 'network',
        warning: null,
      };
    }
    if (loopbackControlUrl(fallbackControlUrl) && network.nextAction?.message) {
      return {
        controlUrl: fallbackControlUrl,
        source: 'control',
        warning: network.nextAction.message,
      };
    }
  } catch (error) {
    if (loopbackControlUrl(fallbackControlUrl)) {
      return {
        controlUrl: fallbackControlUrl,
        source: 'control',
        warning: `Could not inspect remote Control URL candidates: ${error.message}`,
      };
    }
  }
  return {
    controlUrl: fallbackControlUrl,
    source: 'control',
    warning: loopbackControlUrl(fallbackControlUrl)
      ? 'The bundle embeds a loopback Control URL. Remote workers on another host cannot reach it; pass --bundle-control-url or set NADO_PUBLIC_CONTROL_URL.'
      : null,
  };
}

function printTable(rows, columns) {
  if (!rows.length) {
    console.log('(none)');
    return;
  }
  const widths = columns.map((column) => Math.max(
    column.header.length,
    ...rows.map((row) => String(column.value(row) ?? '').length),
  ));
  console.log(columns.map((column, i) => column.header.padEnd(widths[i])).join('  '));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(columns.map((column, i) => String(column.value(row) ?? '').padEnd(widths[i])).join('  '));
  }
}

function defaultEnrollmentExpiresAt(value) {
  return value || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function commandControlStart(args) {
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 8765);
  const publicControlUrl = args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';
  const trustProxy = Boolean(args['trust-proxy'] || args.trustProxy);
  const tokenResult = await controlStartToken(args, {
    dataDir,
    host,
    publicControlUrl,
    trustProxy,
  });
  const { token } = tokenResult;

  const running = await startControlServer({
    host,
    port,
    token,
    dataDir,
    storeBackend: args.store || process.env.NADO_STORE,
    dashboardAutoToken: Boolean(args['dashboard-auto-token']),
    publicControlUrl,
    trustProxy,
    trustProxySecret: args['trust-proxy-secret'] || args.trustProxySecret || process.env.NADO_TRUST_PROXY_SECRET,
    autoRecoverOfflineMs: args['auto-recover-offline-ms'] || process.env.NADO_AUTO_RECOVER_OFFLINE_MS,
    taskLeaseMs: args['task-lease-ms'] || process.env.NADO_TASK_LEASE_MS,
    controlDataLeaseTimeoutMs: args['control-data-lease-timeout-ms']
      || process.env.NADO_CONTROL_DATA_LEASE_TIMEOUT_MS,
    controlDataLeaseHeartbeatMs: args['control-data-lease-heartbeat-ms']
      || process.env.NADO_CONTROL_DATA_LEASE_HEARTBEAT_MS,
    auditNdjsonFile: args['audit-ndjson-file'] || process.env.NADO_AUDIT_NDJSON_FILE,
    auditNdjsonMaxPending: args['audit-ndjson-max-pending'] || process.env.NADO_AUDIT_NDJSON_MAX_PENDING,
  });
  console.log(`Nado control server listening on ${controlUrlFromHostPort(host, running.port)}`);
  if (publicControlUrl) {
    console.log(`Public control URL: ${publicControlUrl}`);
  }
  if (tokenResult.source === 'generated_terminal') {
    console.log(`Generated local-only NADO_TOKEN=${token}`);
    console.log('Warning: save this token now; it is shown only for an implicit loopback development start.');
  } else if (tokenResult.source === 'generated_file') {
    console.log(`Generated administrator token written to private file: ${tokenResult.outputFile}`);
  } else {
    console.log(`Administrator token: configured via ${tokenResult.source} (redacted)`);
  }
  console.log(`Data dir: ${dataDir}`);
  let closing = false;
  const close = (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`Stopping Nado control server after ${signal}`);
    running.server.close((error) => {
      if (error) {
        console.error(error.message || error);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => close('SIGINT'));
  process.once('SIGTERM', () => close('SIGTERM'));
}

async function commandStoreBackup(args) {
  const result = await createControlBackup({
    dataDir: path.resolve(args['data-dir'] || '.nado'),
    output: args.out ? path.resolve(args.out) : undefined,
    backend: args.store || process.env.NADO_STORE,
    offlineConfirmed: Boolean(args['offline-confirmed']),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`backup=${result.output}`);
  console.log(`backend=${result.manifest.backend}`);
  console.log(`stateVersion=${result.manifest.stateVersion}`);
  console.log(`files=${result.manifest.fileCount}`);
  console.log(`bytes=${result.manifest.totalBytes}`);
  console.log('verification=ok');
}

async function commandStoreVerify(args) {
  const backupDir = path.resolve(requireValue(args.from, 'store verify requires --from <backup-dir>'));
  const result = await verifyControlBackup({ backupDir });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`backup=${result.backupDir}`);
  console.log(`backend=${result.manifest.backend}`);
  console.log(`stateVersion=${result.manifest.stateVersion}`);
  console.log(`files=${result.manifest.fileCount}`);
  console.log(`bytes=${result.manifest.totalBytes}`);
  console.log('verification=ok');
}

async function commandStoreRestore(args) {
  const backupDir = path.resolve(requireValue(args.from, 'store restore requires --from <backup-dir>'));
  const dataDir = path.resolve(requireValue(args['data-dir'], 'store restore requires a new --data-dir path'));
  const result = await restoreControlBackup({
    backupDir,
    dataDir,
    offlineConfirmed: Boolean(args['offline-confirmed']),
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`restored=${result.dataDir}`);
  console.log(`backend=${result.backend}`);
  console.log(`stateVersion=${result.stateVersion}`);
  console.log(`migrated=${result.migrated}`);
  console.log(`restoreReceipt=${result.receipt.id}`);
  console.log(`backupManifestSha256=${result.receipt.manifestSha256}`);
  console.log('verification=ok');
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function writeMcpConfigFile(out, config) {
  const target = path.resolve(out);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(target, 0o600);
  return target;
}

async function commandQuickstart(args) {
  const root = path.resolve(args['data-dir'] || path.join('.nado', 'quickstart'));
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 8765);
  const publicControlUrl = args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';
  const trustProxy = Boolean(args['trust-proxy'] || args.trustProxy);
  const tokenResult = await controlStartToken(args, {
    dataDir: path.join(root, 'control'),
    host,
    publicControlUrl,
    trustProxy,
  });
  const { token } = tokenResult;
  const remotelyExposed = remoteFacingControl({ host, publicControlUrl, trustProxy });
  const workerId = args.worker || args.id || 'local-worker';
  const capabilities = valueList(args.capability || args.capabilities);
  const agentOptions = agentOptionsFromArgs(args);
  const labels = {
    role: 'quickstart',
    zone: 'local',
    ...parseLabels(args.label),
  };

  const running = await startControlServer({
    host,
    port,
    token,
    dataDir: path.join(root, 'control'),
    storeBackend: args.store || process.env.NADO_STORE,
    dashboardAutoToken: remotelyExposed ? false : !args['no-dashboard-auto-token'],
    publicControlUrl,
    trustProxy,
    trustProxySecret: args['trust-proxy-secret'] || args.trustProxySecret || process.env.NADO_TRUST_PROXY_SECRET,
    autoRecoverOfflineMs: args['auto-recover-offline-ms'] || process.env.NADO_AUTO_RECOVER_OFFLINE_MS,
    taskLeaseMs: args['task-lease-ms'] || process.env.NADO_TASK_LEASE_MS,
  });
  const controlUrl = controlUrlFromHostPort(host, running.port);
  const advertisedControlUrl = publicControlUrl || controlUrl;
  const client = new NadoClient({ controlUrl, token });
  const worker = await startWorker({
    id: workerId,
    name: args.name || workerId,
    controlUrl,
    token,
    dataDir: path.join(root, 'worker'),
    capabilities: capabilities.length ? capabilities : ['code', 'docs'],
    labels,
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    maxConcurrency: Number(args['max-concurrency'] || args.concurrency || 1),
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: Number(args['poll-ms'] || 250),
    longPollMs: Number(args['long-poll-ms'] ?? process.env.NADO_WORKER_LONG_POLL_MS ?? 20_000),
    reconnectBaseMs: Number(args['reconnect-base-ms'] || process.env.NADO_WORKER_RECONNECT_BASE_MS || 0) || undefined,
    reconnectMaxMs: Number(args['reconnect-max-ms'] || process.env.NADO_WORKER_RECONNECT_MAX_MS || 0) || undefined,
    ...workerCompletionOptionsFromArgs(args),
    networkProbeBytes: args['network-probe-bytes'] ?? process.env.NADO_NETWORK_PROBE_BYTES,
    networkProbeIntervalMs: args['network-probe-interval-ms'] ?? process.env.NADO_NETWORK_PROBE_INTERVAL_MS,
    onLog: (line) => {
      if (args.verbose) {
        console.log(`[quickstart:${workerId}] ${line}`);
      }
    },
  });

  let closed = false;
  const stopAll = async () => {
    if (closed) {
      return;
    }
    closed = true;
    worker.stop();
    await Promise.allSettled([worker.done]);
    await closeServer(running.server);
  };

  try {
    const doctor = await runDoctor(client, {
      selfTest: !args['skip-self-test'],
      workerId,
      timeoutMs: Number(args.timeout || 15_000),
    });

    const [{ workers }, { sessions }] = await Promise.all([
      client.listWorkers(),
      client.listSessions(),
    ]);
    const contextOut = path.resolve(args['context-out'] || path.join(root, 'AGENTS.md'));
    await writeAgentContext(contextOut, buildAgentContext({ controlUrl: advertisedControlUrl, workers, sessions }));
    const mcpOut = await writeMcpConfigFile(
      args['mcp-out'] || path.join(root, 'mcp.json'),
      buildMcpClientConfig({ controlUrl: advertisedControlUrl, token, name: args['mcp-name'] || 'nado' }),
    );

    console.log('quickstart=ready');
    console.log(`control=${controlUrl}`);
    if (publicControlUrl) {
      console.log(`publicControl=${publicControlUrl}`);
    }
    console.log(`dashboard=${advertisedControlUrl}/dashboard`);
    if (tokenResult.source === 'generated_terminal') {
      console.log(`generatedLocalToken=${token}`);
    } else if (tokenResult.source === 'generated_file') {
      console.log(`generatedTokenFile=${tokenResult.outputFile}`);
    } else {
      console.log(`token=configured:${tokenResult.source}:redacted`);
    }
    console.log(`dataDir=${root}`);
    console.log(`worker=${workerId}`);
    console.log(`agentContext=${contextOut}`);
    console.log(`mcpConfig=${mcpOut}`);
    for (const test of doctor.selfTests || []) {
      console.log(`selfTest=${test.status} task=${test.taskId} worker=${test.workerId || '-'}`);
      console.log(`selfTestArtifacts=${test.artifacts.map((artifact) => artifact.path).join(',') || '-'}`);
    }

    if (doctor.problems.length) {
      console.log('doctor=failed');
      console.log('problems:');
      for (const problem of doctor.problems) {
        console.log(`- ${problem}`);
      }
      process.exitCode = 2;
      await stopAll();
      return;
    }

    console.log('doctor=ok');
    console.log(`submitExample=NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js submit --control ${advertisedControlUrl} --worker ${workerId} --command "node -e \\"console.log('hello from '+process.env.NADO_WORKER_ID)\\"" --wait`);
    console.log(`installContextExample=NADO_TOKEN="$NADO_TOKEN" node ./src/cli.js context install --control ${advertisedControlUrl} --out ./AGENTS.md`);
    console.log('press Ctrl+C to stop quickstart');

    if (args.once) {
      await stopAll();
      return;
    }

    let release = null;
    const shutdown = new Promise((resolve) => {
      release = resolve;
    });
    const onSignal = () => release('signal');
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    const reason = await Promise.race([
      shutdown,
      worker.done.then(() => 'worker-exited'),
    ]);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    console.log(`quickstart=stopping reason=${reason}`);
    await stopAll();
  } catch (error) {
    await stopAll();
    throw error;
  }
}

async function commandWorkerStart(args) {
  const id = requireValue(args.id, 'Worker requires --id');
  const token = tokenFrom(args);
  const controlUrl = controlUrlFrom(args);
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const agentOptions = agentOptionsFromArgs(args);

  const worker = await startWorker({
    id,
    name: args.name || id,
    controlUrl,
    token,
    dataDir,
    capabilities: valueList(args.capability || args.capabilities),
    labels: parseLabels(args.label),
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    maxConcurrency: Number(args['max-concurrency'] || args.concurrency || 1),
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: Number(args['poll-ms'] || 2_000),
    longPollMs: Number(args['long-poll-ms'] ?? process.env.NADO_WORKER_LONG_POLL_MS ?? 20_000),
    reconnectBaseMs: Number(args['reconnect-base-ms'] || process.env.NADO_WORKER_RECONNECT_BASE_MS || 0) || undefined,
    reconnectMaxMs: Number(args['reconnect-max-ms'] || process.env.NADO_WORKER_RECONNECT_MAX_MS || 0) || undefined,
    ...workerCompletionOptionsFromArgs(args),
    networkProbeBytes: args['network-probe-bytes'] ?? process.env.NADO_NETWORK_PROBE_BYTES,
    networkProbeIntervalMs: args['network-probe-interval-ms'] ?? process.env.NADO_NETWORK_PROBE_INTERVAL_MS,
    onLog: (line) => console.log(`[worker:${id}] ${line}`),
  });

  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  await worker.done;
}

function strictLocalReadinessPolicy(capabilities, agentOptions) {
  const normalizedCapabilities = capabilities.map((item) => String(item).trim().toLowerCase());
  const realAgentPreset = ['codex', 'claude'].includes(agentOptions.agentPreset)
    ? agentOptions.agentPreset
    : null;
  return {
    requireGpu: normalizedCapabilities.includes('gpu'),
    requireAgent: Boolean(realAgentPreset),
    requiredTools: realAgentPreset ? [realAgentPreset] : [],
  };
}

async function runStrictLocalReadinessGate({
  capabilities,
  agentOptions,
  dataDir,
  identity = null,
  inventory,
  requireIdentity = false,
  phase,
}) {
  const policy = strictLocalReadinessPolicy(capabilities, agentOptions);
  const report = await inspectLocalWorker({
    dataDir,
    capabilities,
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    identity,
    inventory,
    requireGpu: policy.requireGpu,
    requireAgent: policy.requireAgent,
    requireIdentity,
    requiredTools: policy.requiredTools,
  });
  console.log(`localReadiness=${report.ok ? 'ok' : 'failed'} phase=${phase}`);
  for (const item of report.checks.filter((check) => check.required)) {
    console.log(`localReadinessCheck=${item.key} status=${item.status}`);
    if (item.status === 'failed' && item.nextAction) {
      console.log(`localReadinessNextAction=${item.key}: ${item.nextAction}`);
    }
  }
  if (!report.ok) {
    process.exitCode = 2;
  }
  return report.ok;
}

async function commandWorkerBootstrapStart(args) {
  const controlUrl = controlUrlFrom(args);
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const agentOptions = agentOptionsFromArgs(args);
  const capabilities = valueList(args.capability || args.capabilities);
  const strictLocalReadiness = Boolean(args['strict-local-readiness']);
  const inspectionInventory = strictLocalReadiness ? await collectInventory(capabilities) : null;
  if (strictLocalReadiness && !await runStrictLocalReadinessGate({
    capabilities,
    agentOptions,
    dataDir,
    identity: null,
    inventory: inspectionInventory,
    phase: 'pre-enrollment',
  })) {
    return;
  }
  const enrollmentToken = args['enrollment-token'] || process.env.NADO_ENROLLMENT_TOKEN;
  let identity = await ensureEnrolledWorker({
    id: args.id || undefined,
    idPrefix: args['id-prefix'] || 'worker',
    label: args['token-label'] || args.label || '',
    controlUrl,
    enrollmentToken,
    dataDir,
  });
  console.log(`enrollment=${identity.reused ? 'reused' : 'created'}`);
  console.log(`worker=${identity.workerId}`);
  console.log(`workerToken=${identity.workerTokenId}`);
  console.log(`publicKey=${identity.publicKeyPem.split('\n')[1]?.slice(0, 16) || 'ok'}...`);
  if (identity.tokenRotation?.status === 'pending') {
    try {
      const resumed = await confirmPendingWorkerTokenRotation({
        identity,
        dataDir,
        controlUrl,
      });
      identity = resumed.identity;
      console.log('tokenRotation=recovered');
      console.log(`workerToken=${identity.workerTokenId}`);
    } catch (error) {
      if (!enrollmentToken || ![401, 403, 410].includes(Number(error.status || 0))) {
        throw error;
      }
      console.log('tokenRotation=recovery-auth-failed');
    }
  }
  try {
    await runWorkerPreflight({
      id: identity.workerId,
      dataDir,
      controlUrl,
      client: new NadoClient({
        controlUrl,
        token: identity.workerToken,
        workerId: identity.workerId,
        privateKeyPem: identity.privateKeyPem,
      }),
    });
  } catch (error) {
    if (!identity.reused || !enrollmentToken || ![401, 403].includes(Number(error.status || 0))) {
      throw error;
    }
    console.log('preflight=recovering');
    console.log('recovery=reenroll');
    identity = await ensureEnrolledWorker({
      id: args.id || identity.workerId,
      idPrefix: args['id-prefix'] || 'worker',
      label: args['token-label'] || args.label || '',
      controlUrl,
      enrollmentToken,
      dataDir,
      force: true,
    });
    console.log(`enrollment=${identity.recovered ? 'recovered' : 'created'}`);
    console.log(`worker=${identity.workerId}`);
    console.log(`workerToken=${identity.workerTokenId}`);
    console.log(`publicKey=${identity.publicKeyPem.split('\n')[1]?.slice(0, 16) || 'ok'}...`);
    await runWorkerPreflight({
      id: identity.workerId,
      dataDir,
      controlUrl,
      client: new NadoClient({
        controlUrl,
        token: identity.workerToken,
        workerId: identity.workerId,
        privateKeyPem: identity.privateKeyPem,
      }),
    });
  }

  if (strictLocalReadiness && !await runStrictLocalReadinessGate({
    capabilities,
    agentOptions,
    dataDir,
    identity,
    inventory: inspectionInventory,
    requireIdentity: true,
    phase: 'post-preflight',
  })) {
    return;
  }

  const worker = await startWorker({
    id: identity.workerId,
    name: args.name || identity.workerId,
    controlUrl,
    token: identity.workerToken,
    privateKeyPem: identity.privateKeyPem,
    dataDir,
    capabilities,
    labels: parseLabels(args.label),
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    maxConcurrency: Number(args['max-concurrency'] || args.concurrency || 1),
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: Number(args['poll-ms'] || 2_000),
    longPollMs: Number(args['long-poll-ms'] ?? process.env.NADO_WORKER_LONG_POLL_MS ?? 20_000),
    reconnectBaseMs: Number(args['reconnect-base-ms'] || process.env.NADO_WORKER_RECONNECT_BASE_MS || 0) || undefined,
    reconnectMaxMs: Number(args['reconnect-max-ms'] || process.env.NADO_WORKER_RECONNECT_MAX_MS || 0) || undefined,
    ...workerCompletionOptionsFromArgs(args),
    networkProbeBytes: args['network-probe-bytes'] ?? process.env.NADO_NETWORK_PROBE_BYTES,
    networkProbeIntervalMs: args['network-probe-interval-ms'] ?? process.env.NADO_NETWORK_PROBE_INTERVAL_MS,
    credentialRotationIntervalMs: args['token-rotation-interval-ms']
      ?? process.env.NADO_WORKER_TOKEN_ROTATION_INTERVAL_MS,
    rotateCredentials: ({ client, verifyPreviousToken }) => rotateEnrolledWorkerToken({
      dataDir,
      controlUrl,
      client,
      ttlMs: args['token-rotation-ttl-ms'],
      verifyPreviousToken,
    }),
    once: Boolean(args.once),
    onLog: (line) => console.log(`[worker:${identity.workerId}] ${line}`),
  });

  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  await worker.done;
}

async function runWorkerPreflight({ id, dataDir, controlUrl, client }) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    throw new Error(`Node.js 20+ is required; found ${process.version}`);
  }
  await fs.access(new URL('./cli.js', import.meta.url));
  await fs.mkdir(dataDir, { recursive: true });
  await fs.access(dataDir);

  const { health, clock } = await probeControlClock(client);
  console.log(`clock=${clock.status}`);
  if (clock.available) {
    console.log(`clockOffsetMs=${clock.offsetMs}`);
    console.log(`clockUncertaintyMs=${clock.uncertaintyMs}`);
    console.log(`clockWindowRemainingMs=${clock.remainingWindowMs}`);
  }
  if (clock.nextAction) {
    console.log(`clockNextAction=${clock.nextAction}`);
  }
  if (clock.status === 'failed') {
    const error = new Error(
      `Control/Worker clock skew is unsafe for signed requests: offset=${clock.offsetMs}ms, uncertainty=${clock.uncertaintyMs}ms, allowed=${clock.maxClockSkewMs}ms`,
    );
    error.code = 'NADO_WORKER_CLOCK_SKEW';
    error.clock = clock;
    throw error;
  }
  const remote = await client.workerPreflight(id);

  console.log('preflight=ok');
  console.log(`worker=${remote.workerId}`);
  console.log(`node=${process.version}`);
  console.log(`cli=ok`);
  console.log(`dataDir=${dataDir}`);
  console.log(`control=${controlUrl}`);
  console.log(`health=${health.ok ? 'ok' : 'failed'}`);
  console.log(`auth=${remote.auth}`);
}

async function commandWorkerPreflight(args) {
  const id = requireValue(args.id, 'Worker preflight requires --id');
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  await runWorkerPreflight({
    id,
    dataDir,
    controlUrl: controlUrlFrom(args),
    client: makeClient(args),
  });
}

async function commandWorkerInspect(args) {
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const agentOptions = agentOptionsFromArgs(args);
  const report = await inspectLocalWorker({
    dataDir,
    capabilities: valueList(args.capability || args.capabilities),
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    requireGpu: Boolean(args['require-gpu']),
    requireAgent: Boolean(args['require-agent']),
    requireIdentity: Boolean(args['require-identity']),
    requiredCapabilities: valueList(args['require-capability'] || args['required-capabilities']),
    requiredTools: parseTools(args['require-tool'] || args.tool || args.tools),
    requiredResources: resourceRequirementsFromArgs(args),
  });
  const output = args.out ? await writeNewPrivateJson(args.out, report) : null;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`workerInspect=${report.ok ? 'ok' : 'failed'}`);
    console.log(`host=${report.host.hostname || '-'} platform=${report.host.platform || '-'} arch=${report.host.arch || '-'}`);
    console.log(`node=${report.tools.node?.version || process.version}`);
    console.log(`capabilities=${report.capabilities.join(',') || '-'}`);
    console.log(`cpu=${report.resources.cpuCores}`);
    console.log(`memory=${formatMetricBytes(report.resources.memoryBytes)}`);
    console.log(`gpus=${report.resources.allGpus.length
      ? report.resources.allGpus.map((gpu) => `${gpu.name}:${formatMetricBytes(gpu.memoryTotalBytes)}`).join(',')
      : '-'}`);
    console.log(`agent=${report.readiness.agent.mode}:${report.readiness.agent.status}`);
    console.log(`identity=${report.identity.present
      ? `${report.identity.workerId}:${report.identity.signedKeyReady ? 'signed' : 'invalid'}`
      : 'not-enrolled'}`);
    for (const item of report.checks) {
      console.log(`check=${item.key} status=${item.status}${item.required ? ' required=true' : ''}`);
      if (item.status === 'failed' && item.nextAction) {
        console.log(`nextAction=${item.key}: ${item.nextAction}`);
      }
    }
    if (output) {
      console.log(`report=${output}`);
    }
  }
  if (!report.ok) {
    process.exitCode = 2;
  }
}

async function commandAgents() {
  printTable(listAgentPresets(), [
    { header: 'name', value: (preset) => preset.name },
    { header: 'command', value: (preset) => preset.command },
    { header: 'description', value: (preset) => preset.description },
  ]);
}

async function commandWorkerInvite(args) {
  const controlUrl = controlUrlFrom(args);
  const workerId = requireValue(args.id, 'Worker invite requires --id');
  const agentOptions = agentOptionsFromArgs(args);
  let token = args['worker-token'] || tokenFrom(args);
  let issued = null;
  let client = null;
  if (args['issue-token']) {
    client = makeClient(args);
    const result = await client.createWorkerToken({
      workerId,
      label: args['token-label'] || args.label || '',
      expiresAt: args['expires-at'] || undefined,
    });
    token = result.token;
    issued = result.workerToken;
  }
  if (!client) {
    try {
      client = makeClient(args);
    } catch {
      client = null;
    }
  }
  const bundleControl = client
    ? await bundleControlUrlFromArgs(args, client, controlUrl)
    : {
      controlUrl: args['bundle-control-url']
        || args.bundleControlUrl
        || args['public-control-url']
        || args.publicControlUrl
        || process.env.NADO_PUBLIC_CONTROL_URL
        || controlUrl,
      source: args['bundle-control-url'] || args.bundleControlUrl
        ? 'bundle-control-url'
        : (args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL ? 'public-control-url' : 'control'),
      warning: !(args['bundle-control-url'] || args.bundleControlUrl || args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL)
        && loopbackControlUrl(controlUrl)
        ? 'The invite embeds a loopback Control URL. Remote workers on another host cannot reach it; pass --bundle-control-url or set NADO_PUBLIC_CONTROL_URL.'
        : null,
    };
  if (issued) {
    console.log(`# Issued worker token ${issued.id} for ${issued.workerId}; preview=${issued.tokenPreview}`);
  }
  console.log(`# Control URL source: ${bundleControl.source}`);
  if (bundleControl.warning) {
    console.log(`# Warning: ${bundleControl.warning}`);
  }
  console.log(buildWorkerInvite({
    token,
    controlUrl: bundleControl.controlUrl,
    id: workerId,
    capabilities: valueList(args.capability || args.capabilities),
    labels: valueList(args.label),
    agentPreset: agentOptions.agentPreset,
    agentCommand: args['agent-command'] || null,
    maxConcurrency: args['max-concurrency'] || args.concurrency || null,
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: args['poll-ms'] || null,
    dataDir: args['data-dir'] || '.nado',
    format: args.format || 'bash',
  }));
}

async function commandWorkerBundle(args) {
  const controlUrl = controlUrlFrom(args);
  const workerId = requireValue(args.id, 'Worker bundle requires --id');
  const agentOptions = agentOptionsFromArgs(args);
  let token = args['worker-token'] || tokenFrom(args);
  let issued = null;
  let client = null;
  if (args['issue-token']) {
    client = makeClient(args);
    const result = await client.createWorkerToken({
      workerId,
      label: args['token-label'] || args.label || '',
      expiresAt: args['expires-at'] || undefined,
    });
    token = result.token;
    issued = result.workerToken;
  }
  if (!client) {
    try {
      client = makeClient(args);
    } catch {
      client = null;
    }
  }
  const bundleControl = client
    ? await bundleControlUrlFromArgs(args, client, controlUrl)
    : {
      controlUrl: args['bundle-control-url']
        || args.bundleControlUrl
        || args['public-control-url']
        || args.publicControlUrl
        || process.env.NADO_PUBLIC_CONTROL_URL
        || controlUrl,
      source: args['bundle-control-url'] || args.bundleControlUrl
        ? 'bundle-control-url'
        : (args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL ? 'public-control-url' : 'control'),
      warning: !(args['bundle-control-url'] || args.bundleControlUrl || args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL)
        && loopbackControlUrl(controlUrl)
        ? 'The bundle embeds a loopback Control URL. Remote workers on another host cannot reach it; pass --bundle-control-url or set NADO_PUBLIC_CONTROL_URL.'
        : null,
    };
  const bundle = await buildWorkerBundle({
    rootDir: path.resolve(args['root-dir'] || '.'),
    token,
    controlUrl: bundleControl.controlUrl,
    id: workerId,
    capabilities: valueList(args.capability || args.capabilities),
    labels: valueList(args.label),
    agentPreset: agentOptions.agentPreset,
    agentCommand: args['agent-command'] || null,
    maxConcurrency: args['max-concurrency'] || args.concurrency || null,
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: args['poll-ms'] || null,
    dataDir: args['data-dir'] || '.nado',
    issuedWorkerToken: issued,
  });
  const outFile = path.resolve(args.out || `nado-worker-${safeName(workerId)}.zip`);
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, bundle.bytes);
  if (issued) {
    console.log(`issuedWorkerToken=${issued.id}`);
    console.log(`workerTokenPreview=${issued.tokenPreview}`);
  }
  console.log(`bundle=${outFile}`);
  console.log(`worker=${workerId}`);
  console.log(`control=${bundleControl.controlUrl}`);
  console.log(`controlSource=${bundleControl.source}`);
  if (bundleControl.warning) {
    console.log(`warning=${bundleControl.warning}`);
  }
  console.log(`root=${bundle.bundleRoot}`);
  console.log(`files=${bundle.files.length}`);
  console.log(`bytes=${bundle.bytes.length}`);
  console.log(`upgradeDataDir=${bundle.manifest.dataDir}`);
  console.log(`upgradeReady=${bundle.manifest.upgrade.dataDirIsAbsolute}`);
  if (!bundle.manifest.upgrade.dataDirIsAbsolute) {
    console.log('warning=Relative Worker data directory is tied to the extracted bundle. Use the same absolute --data-dir outside runtime folders for production upgrade/rollback.');
  }
  console.log('start=bash ./start-worker.sh');
  console.log('startPowerShell=.\\start-worker.ps1');
}

async function commandWorkerBootstrapBundle(args) {
  const controlUrl = controlUrlFrom(args);
  const agentOptions = agentOptionsFromArgs(args);
  let enrollmentToken = args['enrollment-token'] || '';
  let issued = null;
  let client = null;
  if (!enrollmentToken || args['issue-token'] || args['issue-enrollment-token']) {
    client = makeClient(args);
    const result = await client.createWorkerEnrollmentToken({
      label: args['token-label'] || args.label || 'bootstrap bundle',
      expiresAt: defaultEnrollmentExpiresAt(args['expires-at']),
      maxUses: args['max-uses'] || 1,
    });
    enrollmentToken = result.token;
    issued = result.enrollmentToken;
  }
  if (!client) {
    try {
      client = makeClient(args);
    } catch {
      client = null;
    }
  }
  const bundleControl = client
    ? await bundleControlUrlFromArgs(args, client, controlUrl)
    : {
      controlUrl: args['bundle-control-url']
        || args.bundleControlUrl
        || args['public-control-url']
        || args.publicControlUrl
        || process.env.NADO_PUBLIC_CONTROL_URL
        || controlUrl,
      source: args['bundle-control-url'] || args.bundleControlUrl
        ? 'bundle-control-url'
        : (args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL ? 'public-control-url' : 'control'),
      warning: !(args['bundle-control-url'] || args.bundleControlUrl || args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL)
        && loopbackControlUrl(controlUrl)
        ? 'The bundle embeds a loopback Control URL. Remote workers on another host cannot reach it; pass --bundle-control-url or set NADO_PUBLIC_CONTROL_URL.'
        : null,
    };
  const bundle = await buildWorkerBootstrapBundle({
    rootDir: path.resolve(args['root-dir'] || '.'),
    enrollmentToken,
    controlUrl: bundleControl.controlUrl,
    name: args.name || 'bootstrap',
    capabilities: valueList(args.capability || args.capabilities),
    labels: valueList(args.label),
    agentPreset: agentOptions.agentPreset,
    agentCommand: args['agent-command'] || null,
    maxConcurrency: args['max-concurrency'] || args.concurrency || null,
    strictLocalReadiness: Boolean(args['strict-local-readiness']),
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: args['poll-ms'] || null,
    dataDir: args['data-dir'] || '.nado',
    issuedEnrollmentToken: issued,
  });
  const outFile = path.resolve(args.out || 'nado-worker-bootstrap.zip');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, bundle.bytes);
  if (issued) {
    console.log(`issuedEnrollmentToken=${issued.id}`);
    console.log(`enrollmentTokenPreview=${issued.tokenPreview}`);
  }
  console.log(`bundle=${outFile}`);
  console.log(`control=${bundleControl.controlUrl}`);
  console.log(`controlSource=${bundleControl.source}`);
  if (bundleControl.warning) {
    console.log(`warning=${bundleControl.warning}`);
  }
  console.log(`root=${bundle.bundleRoot}`);
  console.log(`files=${bundle.files.length}`);
  console.log(`bytes=${bundle.bytes.length}`);
  console.log(`upgradeDataDir=${bundle.manifest.dataDir}`);
  console.log(`upgradeReady=${bundle.manifest.upgrade.dataDirIsAbsolute}`);
  if (!bundle.manifest.upgrade.dataDirIsAbsolute) {
    console.log('warning=Relative Worker data directory is tied to the extracted bundle. Use the same absolute --data-dir outside runtime folders for production upgrade/rollback.');
  }
  console.log('start=bash ./start-worker.sh');
  console.log('startPowerShell=.\\start-worker.ps1');
}

async function commandWorkerTokenCreate(args) {
  const workerId = requireValue(args.id || args.worker, 'Worker token create requires --id');
  const client = makeClient(args);
  const result = await client.createWorkerToken({
    workerId,
    label: args.label || '',
    expiresAt: args['expires-at'] || undefined,
  });
  console.log(`created ${result.workerToken.id}`);
  console.log(`worker=${result.workerToken.workerId}`);
  console.log(`label=${result.workerToken.label || '-'}`);
  console.log(`tokenPreview=${result.workerToken.tokenPreview}`);
  console.log(`token=${result.token}`);
}

async function commandWorkerTokenRotate(args) {
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const before = await readWorkerIdentity(dataDir);
  if ((args.verify || args.evidence) && before?.tokenRotation?.status === 'pending') {
    throw new Error('Cannot prove predecessor rejection while recovering a pending rotation; recover it first, then run a fresh verified rotation');
  }
  const result = await rotateEnrolledWorkerToken({
    dataDir,
    controlUrl: controlUrlFrom(args),
    ttlMs: args['ttl-ms'],
    verifyPreviousToken: Boolean(args.verify || args.evidence),
  });
  console.log(`rotated ${result.identity.workerTokenId}`);
  console.log(`worker=${result.identity.workerId}`);
  console.log(`previousToken=${result.identity.lastTokenRotation?.fromTokenId || '-'}`);
  console.log(`workerToken=${result.identity.workerTokenId}`);
  console.log(`confirmedAt=${result.identity.lastTokenRotation?.confirmedAt || '-'}`);
  console.log(`recovered=${Boolean(result.recovered)}`);
  if (result.verification) {
    console.log(`newTokenAccepted=${Boolean(result.verification.newTokenAccepted)}`);
    console.log(`previousTokenRejected=${Boolean(result.verification.previousTokenRejected)}`);
    console.log(`previousTokenStatus=${result.verification.previousTokenStatus || '-'}`);
    if (!result.verification.passed) {
      throw new Error(`Credential rotation completed, but verification failed: ${result.verification.reason || 'unknown reason'}`);
    }
  }
  if (args.evidence) {
    const output = await recordAcceptanceEvidenceFile(args.evidence, {
      scenario: 'credentialRevocation',
      status: 'passed',
      evidence: `Worker ${result.identity.workerId} accepted replacement token ${result.identity.workerTokenId}; predecessor ${result.identity.lastTokenRotation?.fromTokenId || '-'} was rejected with HTTP ${result.verification.previousTokenStatus}.`,
      references: [
        `worker:${result.identity.workerId}`,
        `worker-token:${result.identity.workerTokenId}`,
        `worker-token:${result.identity.lastTokenRotation?.fromTokenId || '-'}`,
      ],
      observedAt: result.verification.checkedAt,
      source: 'automated_exercise',
      details: {
        mode: 'direct_verified_rotation',
        workerId: result.identity.workerId,
        replacementTokenId: result.identity.workerTokenId,
        predecessorTokenId: result.identity.lastTokenRotation?.fromTokenId || null,
        verification: result.verification,
      },
    });
    console.log(`acceptanceEvidence=${output}`);
  }
}

async function commandWorkerTokens(args) {
  const client = makeClient(args);
  const { workerTokens } = await client.listWorkerTokens({ workerId: args.worker || args.id });
  printTable(workerTokens, [
    { header: 'id', value: (item) => item.id },
    { header: 'worker', value: (item) => item.workerId },
    { header: 'label', value: (item) => item.label || '-' },
    { header: 'preview', value: (item) => item.tokenPreview },
    { header: 'created', value: (item) => item.createdAt },
    { header: 'lastUsed', value: (item) => item.lastUsedAt || '-' },
    { header: 'expires', value: (item) => item.expiresAt || '-' },
    { header: 'rotation', value: (item) => item.rotationStatus || '-' },
    { header: 'rotatesFrom', value: (item) => item.rotationFromTokenId || '-' },
    { header: 'revoked', value: (item) => item.revokedAt || '-' },
  ]);
}

async function commandWorkerTokenRevoke(args) {
  const tokenId = args._[3];
  if (!tokenId) {
    throw new Error('Usage: nado worker token revoke TOKEN_ID --control URL');
  }
  const client = makeClient(args);
  const { workerToken } = await client.revokeWorkerToken(tokenId);
  console.log(`revoked ${workerToken.id}`);
  console.log(`worker=${workerToken.workerId}`);
  console.log(`revokedAt=${workerToken.revokedAt}`);
}

function enrollmentStatus(token) {
  if (token.revokedAt) {
    return 'revoked';
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
    return 'expired';
  }
  if (token.maxUses && Number(token.useCount || 0) >= Number(token.maxUses)) {
    return 'used';
  }
  return 'active';
}

async function commandWorkerEnrollments(args) {
  const client = makeClient(args);
  const { enrollmentTokens } = await client.listWorkerEnrollmentTokens();
  printTable(enrollmentTokens, [
    { header: 'id', value: (item) => item.id },
    { header: 'label', value: (item) => item.label || '-' },
    { header: 'preview', value: (item) => item.tokenPreview || '-' },
    { header: 'status', value: enrollmentStatus },
    { header: 'uses', value: (item) => `${item.useCount || 0}/${item.maxUses || '∞'}` },
    { header: 'created', value: (item) => item.createdAt || '-' },
    { header: 'lastUsed', value: (item) => item.lastUsedAt || '-' },
    { header: 'expires', value: (item) => item.expiresAt || '-' },
    { header: 'revoked', value: (item) => item.revokedAt || '-' },
  ]);
}

async function commandWorkerEnrollmentRevoke(args) {
  const tokenId = args._[3];
  if (!tokenId) {
    throw new Error('Usage: nado worker enrollment revoke TOKEN_ID --control URL');
  }
  const client = makeClient(args);
  const { enrollmentToken } = await client.revokeWorkerEnrollmentToken(tokenId);
  console.log(`revoked ${enrollmentToken.id}`);
  console.log(`label=${enrollmentToken.label || '-'}`);
  console.log(`revokedAt=${enrollmentToken.revokedAt}`);
}

async function commandWorkerEnrollmentPrune(args) {
  const client = makeClient(args);
  const result = args['dry-run'] || args.dryRun
    ? await client.previewWorkerEnrollmentTokenPrune()
    : await client.pruneWorkerEnrollmentTokens();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (args['dry-run'] || args.dryRun) {
    console.log(`prunableEnrollmentTokens=${result.prunableCount || 0}`);
  } else {
    console.log(`prunedEnrollmentTokens=${result.prunedCount || 0}`);
  }
  for (const token of result.prunedTokens || result.prunableTokens || []) {
    console.log(`- ${token.id} label=${token.label || '-'} uses=${token.useCount || 0}/${token.maxUses || '∞'} created=${token.createdAt || '-'} revoked=${token.revokedAt || '-'}`);
  }
}

async function commandWorkers(args) {
  const client = makeClient(args);
  const [{ workers }, snapshot] = await Promise.all([client.listWorkers(), client.status()]);
  const controlBuild = snapshot.runtime?.build || null;
  console.log(`controlBuild=${controlBuild?.buildId || '-'} protocol=${controlBuild?.protocolVersion || '-'}`);
  printTable(workers, [
    { header: 'id', value: (worker) => worker.id },
    { header: 'build', value: (worker) => {
      const compatibility = runtimeBuildCompatibility(controlBuild, worker.runtime?.build);
      return `${compatibility.status}:${worker.runtime?.build?.buildId || '-'}`;
    } },
    { header: 'gateway', value: (worker) => worker.gatewayState },
    { header: 'admin', value: (worker) => worker.adminState },
    { header: 'observed', value: (worker) => worker.observedState },
    { header: 'currentTask', value: (worker) => worker.currentTaskId || '-' },
    { header: 'slots', value: (worker) => `${worker.runningSlots ?? worker.runningTasks ?? 0}/${worker.maxConcurrency || 1}` },
    { header: 'capabilities', value: (worker) => worker.capabilities.join(',') || '-' },
    { header: 'identity', value: (worker) => worker.identity?.signed
      ? `signed:${worker.identity.workerTokenId || 'worker'}`
      : worker.identity?.type || 'unknown' },
    { header: 'clock', value: (worker) => Number.isFinite(Number(worker.identity?.signatureClockSkewMs))
      ? `${Math.round(Number(worker.identity.signatureClockSkewMs))}ms`
      : '-' },
    { header: 'source', value: (worker) => worker.connection?.remoteAddress || '-' },
    { header: 'transport', value: (worker) => worker.connection
      ? `${worker.connection.protocol || '-'}${worker.connection.trustedProxy
        ? worker.connection.proxyAuthenticated ? ':proxy-auth' : ':proxy-unverified'
        : ':direct'}`
      : '-' },
    { header: 'labels', value: (worker) => formatLabels(worker.labels) },
    { header: 'tools', value: (worker) => Object.entries(worker.inventory?.tools || {}).filter(([, tool]) => tool.available).map(([name]) => name).join(',') || '-' },
    { header: 'cpu', value: (worker) => Number.isFinite(Number(worker.resources?.cpu?.utilizationPercent)) ? `${worker.resources.cpu.utilizationPercent}%` : '-' },
    { header: 'memFree', value: (worker) => worker.resources?.memory?.totalBytes ? `${formatMetricBytes(worker.resources.memory.freeBytes)}${worker.resources.memory.usedPercent == null ? '' : `/${worker.resources.memory.usedPercent}% used`}` : '-' },
    { header: 'rtt', value: (worker) => Number.isFinite(Number(worker.resources?.network?.roundTripMs)) ? `${worker.resources.network.roundTripMs}ms` : '-' },
    { header: 'bandwidth', value: (worker) => worker.resources?.network?.bandwidth?.available
      ? `D:${formatBandwidth(worker.resources.network.bandwidth.downloadBytesPerSecond)}/U:${formatBandwidth(worker.resources.network.bandwidth.uploadBytesPerSecond)}`
      : '-' },
    { header: 'diskFree', value: (worker) => worker.resources?.disk?.available ? formatMetricBytes(worker.resources.disk.availableBytes) : '-' },
    { header: 'temp', value: (worker) => (worker.resources?.temperatures || []).length ? `${Math.max(...worker.resources.temperatures.map((item) => Number(item.temperatureC) || 0))}C` : '-' },
    { header: 'agent', value: (worker) => (worker.agentCommandConfigured ? worker.agentPreset || 'custom' : 'no') },
    { header: 'agentTest', value: (worker) => worker.diagnostics?.agentSelfTest?.status || '-' },
    { header: 'lastSeen', value: (worker) => worker.lastSeenAt || '-' },
  ]);
}

async function commandWorkerLogs(args) {
  const id = requireValue(args.id, 'Worker logs requires --id');
  const client = makeClient(args);
  const tail = args.tail !== undefined ? Number(args.tail) : 50;
  const pollMs = Number(args['poll-ms'] || 1_000);
  const seen = new Set();

  const printNewEvents = async () => {
    const { events } = await client.listWorkerEvents(id, { tail: args.watch ? Math.max(tail, 100) : tail });
    for (const event of events || []) {
      const key = [
        event.at,
        event.type,
        event.level || '',
        event.message || '',
        JSON.stringify(event.data || {}),
      ].join(':');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      printEventLine(event);
    }
  };

  await printNewEvents();
  while (args.watch) {
    await sleep(pollMs);
    await printNewEvents();
  }
}

async function waitForWorkerCommand(client, workerId, commandId, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const { worker } = await client.getWorker(workerId);
    last = (worker.commands || []).find((command) => command.id === commandId) || null;
    if (last && ['completed', 'failed'].includes(last.status)) {
      return last;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Worker command ${commandId}; last status=${last?.status || 'missing'}`);
}

async function commandWorkerManage(args) {
  const id = requireValue(args.id, 'Worker manage requires --id');
  const action = requireValue(args.action, 'Worker manage requires --action');
  const client = makeClient(args);
  if (action === 'forget') {
    const result = await client.forgetWorker(id, args.reason || 'cli forget worker');
    console.log(`forgot ${result.worker.id}`);
    console.log(`gatewayState=${result.worker.gatewayState}`);
    console.log(`revokedWorkerTokens=${result.revokedWorkerTokens.length}`);
    console.log(`removedCommands=${result.removedCommandCount}`);
    return;
  }
  const { worker, command } = await client.manageWorker(id, action, args.reason || '');
  console.log(`queued ${command.id} action=${command.action} for ${worker.id}`);
  console.log(`adminState=${worker.adminState}`);
  console.log(`gatewayState=${worker.gatewayState}`);
  if (!args.wait && !args.evidence) {
    return;
  }
  const completed = await waitForWorkerCommand(client, id, command.id, Number(args.timeout || 60_000));
  console.log(`commandStatus=${completed.status}`);
  console.log(`commandMessage=${completed.message || '-'}`);
  if (completed.status !== 'completed') {
    throw new Error(`Worker command ${completed.id} failed: ${completed.message || 'unknown error'}`);
  }
  if (action === 'rotate_token') {
    console.log(`newTokenAccepted=${Boolean(completed.result?.verification?.newTokenAccepted)}`);
    console.log(`previousTokenRejected=${Boolean(completed.result?.verification?.previousTokenRejected)}`);
    console.log(`previousTokenStatus=${completed.result?.verification?.previousTokenStatus || '-'}`);
  }
  if (args.evidence) {
    if (action !== 'rotate_token') {
      throw new Error('--evidence is currently supported only for --action rotate_token');
    }
    if (!completed.result?.verification?.passed) {
      throw new Error('Worker command completed without verified replacement acceptance and predecessor rejection');
    }
    const output = await recordAcceptanceEvidenceFile(args.evidence, {
      scenario: 'credentialRevocation',
      status: 'passed',
      evidence: `Control-triggered rotation on Worker ${id} accepted replacement token ${completed.result.workerTokenId}; predecessor ${completed.result.previousTokenId} was rejected with HTTP ${completed.result.verification.previousTokenStatus}.`,
      references: [
        `worker:${id}`,
        `worker-command:${completed.id}`,
        `worker-token:${completed.result.workerTokenId}`,
        `worker-token:${completed.result.previousTokenId}`,
      ],
      observedAt: completed.result.verification.checkedAt,
      source: 'automated_exercise',
      details: {
        mode: 'control_triggered_rotation',
        workerId: id,
        commandId: completed.id,
        replacementTokenId: completed.result.workerTokenId,
        predecessorTokenId: completed.result.previousTokenId,
        verification: completed.result.verification,
      },
    });
    console.log(`acceptanceEvidence=${output}`);
  }
}

async function commandStatus(args) {
  const client = makeClient(args);
  const snapshot = await client.status();
  const workers = snapshot.workers.items;
  const taskCounts = snapshot.tasks.counts;
  const batchCounts = snapshot.batches.counts;
  const attention = snapshot.tasks.attention || { total: 0, items: [] };
  const controlBuild = snapshot.runtime?.build || null;
  const dataLease = snapshot.storage?.dataLease || {};
  console.log(`controlBuild=${controlBuild?.buildId || '-'} protocol=${controlBuild?.protocolVersion || '-'}`);
  console.log(`storage=${snapshot.storage?.backend || '-'} dataLease=${dataLease.status || 'unavailable'} writeFencing=${Boolean(dataLease.writeFencing)}`);
  console.log(`workers=${snapshot.workers.total} active=${snapshot.workers.active}`);
  console.log(`sessions=${snapshot.sessions.total} open=${snapshot.sessions.open}`);
  console.log(`tasks=${snapshot.tasks.total} queued=${taskCounts.queued || 0} running=${taskCounts.running || 0} succeeded=${taskCounts.succeeded || 0} failed=${taskCounts.failed || 0} cancelled=${taskCounts.cancelled || 0} attention=${attention.total || 0}`);
  console.log(`batches=${snapshot.batches.total} queued=${batchCounts.queued || 0} running=${batchCounts.running || 0} succeeded=${batchCounts.succeeded || 0} completed_with_errors=${batchCounts.completed_with_errors || 0}`);
  const auditSink = snapshot.security?.auditSink || {};
  console.log(`auditSink=${auditSink.state || 'disabled'} integrity=${auditSink.deliveryIntegrity || 'disabled'} written=${auditSink.writtenEvents || 0} failed=${auditSink.failedEvents || 0} dropped=${auditSink.droppedEvents || 0} pending=${auditSink.pendingWrites || 0}/${auditSink.maxPendingWrites || 0}${auditSink.lastErrorCode ? ` lastError=${auditSink.lastErrorCode}` : ''}`);
  if (attention.total) {
    console.log('attention:');
    for (const task of attention.items || []) {
      console.log(`- ${task.id} reason=${task.schedulerReason || '-'} worker=${task.requestedWorkerId || '-'} nextAction=${task.nextAction?.code || '-'} title=${task.title}`);
    }
  }
  printTable(workers, [
    { header: 'id', value: (worker) => worker.id },
    { header: 'build', value: (worker) => {
      const compatibility = runtimeBuildCompatibility(controlBuild, worker.runtime?.build);
      return `${compatibility.status}:${worker.runtime?.build?.buildId || '-'}`;
    } },
    { header: 'gateway', value: (worker) => worker.gatewayState },
    { header: 'admin', value: (worker) => worker.adminState },
    { header: 'task', value: (worker) => worker.currentTaskId || '-' },
    { header: 'slots', value: (worker) => `${worker.runningSlots ?? worker.runningTasks ?? 0}/${worker.maxConcurrency || 1}` },
    { header: 'caps', value: (worker) => worker.capabilities.join(',') || '-' },
    { header: 'labels', value: (worker) => formatLabels(worker.labels) },
    { header: 'tools', value: (worker) => Object.entries(worker.inventory?.tools || {}).filter(([, tool]) => tool.available).map(([name]) => name).join(',') || '-' },
    { header: 'agentTest', value: (worker) => worker.diagnostics?.agentSelfTest?.status || '-' },
  ]);
}

async function commandAudit(args) {
  const client = makeClient(args);
  const options = {
    tail: Number(args.tail ?? 100),
    actorType: args['actor-type'],
    outcome: args.outcome,
    statusCode: args['status-code'],
  };
  if (args.out) {
    const output = path.resolve(args.out);
    const text = await client.exportAuditEvents(options);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, text, { mode: 0o600 });
    await fs.chmod(output, 0o600);
    console.log(`auditExport=${output}`);
    console.log(`auditEvents=${text.trim() ? text.trim().split(/\r?\n/).length : 0}`);
    return;
  }
  const { auditEvents } = await client.listAuditEvents(options);
  if (args.json) {
    console.log(JSON.stringify(auditEvents, null, 2));
    return;
  }
  printTable([...auditEvents].reverse(), [
    { header: 'at', value: (event) => event.at },
    { header: 'actor', value: (event) => `${event.actorType}:${event.actorId || '-'}` },
    { header: 'method', value: (event) => event.method },
    { header: 'path', value: (event) => event.path },
    { header: 'status', value: (event) => event.statusCode },
    { header: 'outcome', value: (event) => event.outcome },
    { header: 'request', value: (event) => event.requestId || '-' },
  ]);
}

async function writeNewPrivateJson(file, value) {
  const output = path.resolve(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await fs.chmod(output, 0o600);
  return output;
}

async function writeNewPrivateText(file, value) {
  const output = path.resolve(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, String(value), {
    flag: 'wx',
    mode: 0o600,
  });
  await fs.chmod(output, 0o600);
  return output;
}

async function writePrivateJsonAtomic(file, value) {
  const output = path.resolve(file);
  const temporary = `${output}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(output), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporary, output);
    await fs.chmod(output, 0o600).catch(() => {});
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return output;
}

async function recordAcceptanceEvidenceFile(file, record) {
  const output = path.resolve(file);
  let current;
  try {
    current = JSON.parse(await fs.readFile(output, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    current = acceptanceEvidenceTemplate();
  }
  return writePrivateJsonAtomic(output, recordAcceptanceEvidence(current, record));
}

async function commandAcceptanceTemplate(args) {
  const template = acceptanceEvidenceTemplate();
  if (args.json && !args.out) {
    console.log(JSON.stringify(template, null, 2));
    return;
  }
  const output = await writeNewPrivateJson(
    requireValue(args.out, 'acceptance template requires --out <evidence.json> or --json'),
    template,
  );
  console.log(`acceptanceEvidence=${output}`);
}

async function commandAcceptanceEvidenceRecord(args) {
  const file = requireValue(args.file || args.evidence, 'acceptance evidence record requires --file <evidence.json>');
  const scenario = requireValue(args.scenario, 'acceptance evidence record requires --scenario <name>');
  const status = requireValue(args.status, 'acceptance evidence record requires --status passed|failed|pending');
  const output = await recordAcceptanceEvidenceFile(file, {
    scenario,
    status,
    note: args.note || '',
    references: valueList(args.reference || args.references),
    observedAt: args['observed-at'] || undefined,
  });
  console.log(`acceptanceEvidence=${output}`);
  console.log(`scenario=${scenario}`);
  console.log(`status=${status}`);
}

async function commandAcceptanceEvidenceInit(args) {
  const file = requireValue(args.file || args.evidence, 'acceptance evidence init requires --file <evidence.json>');
  const output = path.resolve(file);
  let current;
  let created = false;
  try {
    current = JSON.parse(await fs.readFile(output, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    created = true;
  }
  const initialized = initializeAcceptanceEvidence(current);
  const changed = created || JSON.stringify(current) !== JSON.stringify(initialized);
  if (changed) {
    await writePrivateJsonAtomic(output, initialized);
  }
  if (args.json) {
    console.log(JSON.stringify({ file: output, created, updated: !created && changed, evidence: initialized }, null, 2));
    return;
  }
  console.log(`acceptanceEvidence=${output}`);
  console.log(`status=${created ? 'created' : changed ? 'updated' : 'ready'}`);
}

async function commandAcceptanceRunbook(args) {
  const runbook = buildAcceptanceRunbook({
    controlUrl: controlUrlFrom(args),
    workerId: requireValue(args.worker, 'acceptance runbook requires --worker <worker-id>'),
    deploymentMode: args['deployment-mode'] || args.deploymentMode,
    overlayInterface: args['overlay-interface'] || args.overlayInterface,
    requireGpu: Boolean(args['require-gpu']),
    requireAgent: !args['no-require-agent'],
    sourceDataDir: args['source-data-dir'],
    backupDir: args['backup-dir'],
    restoredDataDir: args['restored-data-dir'],
    backendControlUrl: args.backend,
    evidenceFile: args.evidence,
    deploymentReport: args['deployment-report'],
    acceptanceReport: args['acceptance-report'],
  });
  const output = args.out ? await writeNewPrivateText(args.out, runbook.script) : null;
  if (args.json) {
    console.log(JSON.stringify({ ...runbook, output }, null, 2));
    return;
  }
  if (output) {
    console.log(`acceptanceRunbook=${output}`);
    console.log(`steps=${runbook.steps.length}`);
    console.log(`operatorEditsRequired=${runbook.operatorEditsRequired.join(',') || '-'}`);
    return;
  }
  process.stdout.write(runbook.script);
}

async function commandAcceptanceExercise(args) {
  const exercise = args._[2];
  if (!['remote-cancellation', 'agent-collaboration', 'short-disconnect', 'long-disconnect-recovery', 'vm-restart-recovery', 'worker-restart-recovery', 'large-artifact-resume', 'large-input-resume', 'backup-restore'].includes(exercise)) {
    throw new Error('Usage: nado acceptance exercise remote-cancellation|agent-collaboration|short-disconnect|long-disconnect-recovery|vm-restart-recovery|worker-restart-recovery|large-artifact-resume|large-input-resume|backup-restore --control URL --worker ID --evidence FILE');
  }
  const workerId = requireValue(args.worker, 'acceptance exercise requires --worker <worker-id>');
  const evidenceFile = requireValue(
    args.evidence || args.file,
    'acceptance exercise requires --evidence <evidence.json>',
  );
  const client = makeClient(args);
  const agentCollaboration = exercise === 'agent-collaboration';
  const shortDisconnect = exercise === 'short-disconnect';
  const longDisconnectRecovery = exercise === 'long-disconnect-recovery';
  const vmRestartRecovery = exercise === 'vm-restart-recovery';
  const workerRestartRecovery = exercise === 'worker-restart-recovery';
  const largeArtifactResume = exercise === 'large-artifact-resume';
  const largeInputResume = exercise === 'large-input-resume';
  const backupRestore = exercise === 'backup-restore';
  const reportProgress = (progress) => {
    const line = `[acceptance:${exercise}] ${progress.message}`;
    if (args.json) {
      console.error(line);
    } else {
      console.log(line);
    }
  };
  let result;
  if (agentCollaboration) {
    result = await runAgentCollaborationExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 180_000),
    });
  } else if (shortDisconnect) {
    result = await runShortDisconnectExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 180_000),
      minDisconnectMs: Number(args['min-disconnect-ms'] || 5_000),
      taskDurationMs: Number(args['task-duration-ms'] || 90_000),
      onProgress: reportProgress,
    });
  } else if (longDisconnectRecovery) {
    result = await runLongDisconnectRecoveryExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 300_000),
      firstAttemptMs: Number(args['first-attempt-ms'] || 0) || undefined,
      onProgress: reportProgress,
    });
  } else if (vmRestartRecovery) {
    result = await runVmRestartRecoveryExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 300_000),
      taskDurationMs: Number(args['task-duration-ms'] || 90_000),
      onProgress: reportProgress,
    });
  } else if (workerRestartRecovery) {
    result = await runWorkerRestartRecoveryExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 300_000),
      onProgress: reportProgress,
    });
  } else if (largeArtifactResume) {
    result = await runLargeArtifactResumeExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 300_000),
      artifactBytes: Number(args['artifact-bytes'] || 64 * 1024 * 1024),
      minStallMs: Number(args['min-stall-ms'] || 5_000),
      onProgress: reportProgress,
    });
  } else if (largeInputResume) {
    result = await runLargeInputResumeExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 300_000),
      inputBytes: Number(args['input-bytes'] || 64 * 1024 * 1024),
      minStallMs: Number(args['min-stall-ms'] || 5_000),
      onProgress: reportProgress,
    });
  } else if (backupRestore) {
    result = await runBackupRestoreExercise(client, {
      workerId,
      sourceDataDir: requireValue(args['source-data-dir'], 'backup-restore requires --source-data-dir <active-control-data-dir>'),
      backupDir: requireValue(args['backup-dir'], 'backup-restore requires --backup-dir <new-backup-dir>'),
      restoredDataDir: requireValue(args['restored-data-dir'], 'backup-restore requires --restored-data-dir <new-restored-data-dir>'),
      timeoutMs: Number(args.timeout || 600_000),
      onProgress: reportProgress,
    });
  } else {
    result = await runRemoteCancellationExercise(client, {
      workerId,
      timeoutMs: Number(args.timeout || 60_000),
    });
  }
  const supervised = shortDisconnect || longDisconnectRecovery || vmRestartRecovery || workerRestartRecovery || largeArtifactResume || largeInputResume || backupRestore;
  let scenario = 'remoteCancellation';
  let exerciseLabel = 'remote cancellation';
  let successNote = `Automated remote cancellation exercise passed on ${workerId}: task ${result.taskId} was cancelled, the Worker acknowledged cancel_current, and released the task process`;
  if (agentCollaboration) {
    scenario = 'agentCollaboration';
    exerciseLabel = 'Agent collaboration';
    successNote = `Automated Agent collaboration exercise passed on ${workerId}: session ${result.sessionId} completed two target-pinned Agent turns and verified plan, final, and transcript artifacts`;
  } else if (shortDisconnect) {
    scenario = 'shortDisconnect';
    exerciseLabel = 'short disconnect';
    successNote = `Supervised short-disconnect exercise passed on ${workerId}: task ${result.taskId} observed a ${Math.round(result.observedGap.ageMs)}ms heartbeat gap, renewed the same attempt lease, executed once, and completed`;
  } else if (longDisconnectRecovery) {
    scenario = 'longDisconnectRecovery';
    exerciseLabel = 'long disconnect recovery';
    successNote = `Supervised long-disconnect recovery passed for ${workerId}: task ${result.taskId} expired attempt ${result.attempts[0].id}, rejected its stale result, and completed distinct attempt ${result.attempts[1].id} on ${result.finalWorkerId}`;
  } else if (vmRestartRecovery) {
    scenario = 'vmRestartRecovery';
    exerciseLabel = 'VM restart recovery';
    successNote = `Supervised VM restart recovery passed for ${workerId}: control changed from ${result.controlRestart.original.instanceId} to ${result.controlRestart.restarted.instanceId}, SQLite preserved task ${result.taskId}, the Worker reconnected, and attempt ${result.attemptId} executed once`;
  } else if (workerRestartRecovery) {
    scenario = 'workerRestartRecovery';
    exerciseLabel = 'Worker service restart recovery';
    successNote = `Supervised Worker service restart recovery passed for ${workerId}: runtime changed from ${result.runtimeRestart.original.id} to ${result.runtimeRestart.restarted.id}, signed token ${result.tokenContinuity.workerTokenId} remained unchanged, and post-restart task ${result.taskId} completed`;
  } else if (largeArtifactResume) {
    scenario = 'largeArtifactResume';
    exerciseLabel = 'large artifact resume';
    successNote = `Supervised large-artifact resume passed for ${workerId}: upload ${result.upload.id} stalled at ${result.upload.stalledOffset}/${result.upload.size} bytes, resumed on attempt ${result.attemptId}, and matched SHA-256 ${result.upload.sha256}`;
  } else if (largeInputResume) {
    scenario = 'largeInputResume';
    exerciseLabel = 'large input resume';
    successNote = `Supervised large-input resume passed for ${workerId}: input ${result.input.id} restarted at byte ${result.input.resumedOffset}/${result.input.size} on attempt ${result.attemptId} and matched SHA-256 ${result.input.sha256}`;
  } else if (backupRestore) {
    scenario = 'backupRestore';
    exerciseLabel = 'backup restore';
    successNote = `Supervised backup restore passed for ${workerId}: restored control receipt ${result.restoreReceipt.id} verified manifest ${result.restoreReceipt.manifestSha256}, preserved marker task ${result.markerTask.id}, reconnected the Worker, and completed write probe ${result.postRestoreTask.id}`;
  }
  const note = result.ok
    ? successNote
    : `${supervised ? 'Supervised' : 'Automated'} ${exerciseLabel} exercise failed on ${workerId}: ${result.error || 'unknown failure'}`;
  const output = await recordAcceptanceEvidenceFile(evidenceFile, {
    scenario,
    status: result.ok ? 'passed' : 'failed',
    note,
    references: result.references || [],
    observedAt: result.completedAt,
    source: supervised ? 'supervised_exercise' : 'automated_exercise',
    details: result,
  });
  if (args.json) {
    console.log(JSON.stringify({ ...result, evidenceFile: output }, null, 2));
  } else {
    console.log(`acceptanceExercise=${exercise}`);
    console.log(`status=${result.ok ? 'passed' : 'failed'}`);
    console.log(`worker=${workerId}`);
    console.log(`session=${result.sessionId || '-'}`);
    console.log(`task=${result.taskId || result.taskIds?.join(',') || '-'}`);
    console.log(`evidence=${output}`);
    if (result.error) {
      console.log(`error=${result.error}`);
    }
  }
  if (!result.ok) {
    process.exitCode = 2;
  }
}

async function commandAcceptance(args) {
  const workerId = requireValue(args.worker, 'acceptance requires --worker <worker-id>');
  const client = makeClient(args);
  const manualEvidence = args.evidence
    ? JSON.parse(await fs.readFile(path.resolve(args.evidence), 'utf8'))
    : {};
  const deploymentEvidence = args['deployment-evidence']
    ? JSON.parse(await fs.readFile(path.resolve(args['deployment-evidence']), 'utf8'))
    : null;
  const [network, status, capabilities, workerResult, taskResult, sessionResult] = await Promise.all([
    client.networkInfo(),
    client.status(),
    client.capabilities(),
    client.listWorkers(),
    client.listTasks(),
    client.listSessions(),
  ]);
  let verifyResult = null;
  if (args['run-verify']) {
    verifyResult = await client.verify({
      workerId,
      allWorkers: false,
      requiredCapabilities: args['require-gpu'] ? ['gpu'] : [],
      timeoutMs: Number(args.timeout || 60_000),
    });
  }
  const report = buildCrossSiteAcceptanceReport({
    workerId,
    requireGpu: Boolean(args['require-gpu']),
    requireAgent: !args['no-require-agent'],
    // A completion claim must always prove the deployed network boundary. Calls
    // without --require-complete remain useful as non-strict diagnostic previews.
    requireDeploymentEvidence: Boolean(args['deployment-evidence'] || args['require-complete']),
    deploymentEvidence,
    manualEvidence,
    network,
    status,
    capabilities,
    workers: workerResult.workers || [],
    tasks: taskResult.tasks || [],
    sessions: sessionResult.sessions || [],
    verifyResult,
  });
  let output = null;
  if (args.out) {
    output = await writeNewPrivateJson(args.out, report);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`crossSiteAcceptance=${report.overall}`);
    console.log(`worker=${workerId}`);
    console.log(`checks=${report.summary.passed}/${report.summary.required} failed=${report.summary.failed} pending=${report.summary.pending}`);
    if (output) {
      console.log(`report=${output}`);
    }
    printTable([...report.automatedChecks, ...report.manualChecks], [
      { header: 'source', value: (item) => report.automatedChecks.includes(item)
        ? 'automatic'
        : item.evidence?.source || 'operator' },
      { header: 'check', value: (item) => item.key },
      { header: 'status', value: (item) => item.status },
      { header: 'summary', value: (item) => item.summary },
    ]);
    for (const item of report.nextActions) {
      console.log(`nextAction=${item.key}: ${item.action}`);
    }
  }
  if (report.overall === 'failed') {
    process.exitCode = 2;
  } else if (args['require-complete'] && report.overall !== 'passed') {
    process.exitCode = 3;
  }
}

async function commandNetwork(args) {
  const client = makeClient(args);
  const network = await client.networkInfo();
  if (args.json) {
    console.log(JSON.stringify(network, null, 2));
    return;
  }

  console.log(`networkRequest=${network.requestUrl || '-'}`);
  console.log(`requestHost=${network.requestHost || '-'} protocol=${network.requestProtocol || '-'}`);
  console.log(`bindHost=${network.bindHost || '-'} port=${network.port || '-'}`);
  console.log(`currentRequestRemoteReady=${network.currentRequestRemoteReady ?? '-'}`);
  console.log(`remoteWorkerReady=${network.remoteWorkerReady ?? '-'}`);
  console.log(`preferredControl=${network.preferredRemoteControlUrl || '-'}`);
  console.log(`publicControl=${network.publicControlUrl || '-'}`);
  console.log(`trustProxy=${network.trustProxy ?? '-'}`);
  console.log(`trustProxyConfigured=${network.trustProxyConfigured ?? '-'}`);
  console.log(`proxyAuthenticationConfigured=${network.proxyAuthenticationConfigured ?? '-'}`);
  console.log(`proxyAuthenticated=${network.proxyAuthenticated ?? '-'}`);
  if (network.nextAction) {
    console.log(`nextAction=${network.nextAction.code || '-'} severity=${network.nextAction.severity || '-'}`);
    console.log(`nextActionControl=${network.nextAction.controlUrl || '-'}`);
    console.log(`message=${network.nextAction.message || '-'}`);
    console.log(`cli=${network.nextAction.cli || '-'}`);
    for (const command of network.nextAction.commands || []) {
      console.log(`command=${command.label || command.shell || 'next'} shell=${command.shell || '-'} value=${command.command || '-'}`);
    }
  }
  console.log('candidates:');
  printTable(network.candidates || [], [
    { header: 'url', value: (candidate) => candidate.url || '-' },
    { header: 'family', value: (candidate) => candidate.family || '-' },
    { header: 'source', value: (candidate) => candidate.source || '-' },
    { header: 'iface', value: (candidate) => candidate.interface || '-' },
    { header: 'usable', value: (candidate) => candidate.usable !== false ? 'yes' : 'no' },
    { header: 'warning', value: (candidate) => candidate.warning || '-' },
  ]);
}

async function commandDeploymentCheck(args) {
  const publicControlUrl = controlUrlFrom(args);
  const token = tokenFrom(args);
  const backendControlUrl = args.backend || args['backend-control-url'] || null;
  let overlayPublishedBindings = null;
  let overlayPublishedBindingError = null;
  let controlSecurity = null;
  let controlSecurityError = null;
  const composeOptions = {
    composeFile: args['compose-file'] || 'docker-compose.azure.yml',
    service: args['compose-service'] || 'control',
  };
  if (args.overlay) {
    try {
      overlayPublishedBindings = await inspectDockerComposeBindings({
        ...composeOptions,
        containerPort: Number(args['compose-port'] || 8765),
      });
    } catch (error) {
      overlayPublishedBindingError = error;
    }
  }
  if (args['require-container-hardening']) {
    try {
      controlSecurity = await inspectDockerComposeControlSecurity(composeOptions);
    } catch (error) {
      controlSecurityError = error;
    }
  }
  const report = await runDeploymentCheck({
    publicControlUrl,
    backendControlUrl,
    requireHttps: Boolean(args['require-https']),
    requireProxyAuthentication: Boolean(args['require-proxy-auth'] || args['require-proxy-authentication']),
    requireContainerHardening: Boolean(args['require-container-hardening']),
    overlayKind: args.overlay || null,
    overlayInterface: args['overlay-interface'] || null,
    overlayPublishedBindings,
    overlayPublishedBindingError,
    controlSecurity,
    controlSecurityError,
    timeoutMs: Number(args.timeout || 15_000),
    publicClient: new NadoClient({ controlUrl: publicControlUrl, token }),
    backendClient: backendControlUrl ? new NadoClient({ controlUrl: backendControlUrl, token }) : null,
  });
  const output = args.out ? await writeNewPrivateJson(args.out, report) : null;
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`deploymentCheck=${report.ok ? 'passed' : 'failed'}`);
    console.log(`publicControl=${report.publicControlUrl}`);
    console.log(`backendControl=${report.backendControlUrl || '-'}`);
    printTable(report.checks, [
      { header: 'check', value: (check) => check.key },
      { header: 'status', value: (check) => check.status },
      { header: 'summary', value: (check) => check.summary },
    ]);
    for (const item of report.nextActions) {
      console.log(`nextAction=${item.key}: ${item.action}`);
    }
    if (output) {
      console.log(`report=${output}`);
    }
  }
  if (!report.ok) {
    process.exitCode = 2;
  }
}

async function commandDoctor(args) {
  const controlUrl = controlUrlFrom(args);
  const token = tokenFrom(args);
  const client = new NadoClient({ controlUrl, token });
  const result = await runDoctor(client, {
    selfTest: Boolean(args['self-test']),
    agentSelfTest: Boolean(args['agent-self-test'] || args.agentSelfTest),
    allWorkers: Boolean(args['all-workers']),
    workerId: args.worker || undefined,
    requiredCapabilities: valueList(args.capability || args.capabilities),
    requiredTools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    requiredLabels: parseLabels(args['required-label'] || args['required-labels']),
    timeoutMs: Number(args.timeout || 15_000),
  });

  console.log(`node=${process.version}`);
  console.log(`control=${controlUrl}`);
  console.log(`auth=${token ? 'token-present' : 'missing'}`);
  console.log(`health=${result.health.ok ? 'ok' : 'failed'}`);
  console.log(`workers=${result.workers.total} active=${result.workers.active}`);
  for (const worker of result.workers.items) {
    const stale = worker.active ? '' : ' stale';
    const tools = Object.entries(worker.inventory?.tools || {})
      .filter(([, tool]) => tool.available)
      .map(([name]) => name)
      .join(',') || '-';
    const agentTest = worker.diagnostics?.agentSelfTest?.status || '-';
    console.log(`- ${worker.id}: ${worker.gatewayState}; admin=${worker.adminState}; caps=${worker.capabilities.join(',') || '-'}; tools=${tools}; agentTest=${agentTest}${stale}`);
  }
  if (result.selfTests?.length) {
    for (const test of result.selfTests) {
      console.log(`selfTest=${test.status} task=${test.taskId} worker=${test.workerId || '-'}`);
      console.log(`selfTestArtifacts=${test.artifacts.map((artifact) => artifact.path).join(',') || '-'}`);
    }
  }
  if (result.agentSelfTests?.length) {
    for (const test of result.agentSelfTests) {
      console.log(`agentSelfTest=${test.status} task=${test.taskId} worker=${test.workerId || '-'}`);
      console.log(`agentSelfTestArtifacts=${test.artifacts.map((artifact) => artifact.path).join(',') || '-'}`);
      if (test.error) {
        console.log(`agentSelfTestError=${test.error}`);
      }
    }
  }
  if (result.problems.length) {
    console.log('problems:');
    for (const problem of result.problems) {
      console.log(`- ${problem}`);
    }
    process.exitCode = 2;
    return;
  }
  console.log('doctor=ok');
}

async function commandSubmit(args) {
  const client = makeClient(args);
  const command = args.command;
  const prompt = args.prompt;
  const type = args.type || (prompt && !command ? 'agent' : 'shell');
  const localInputFiles = await buildInputFiles({ files: args.file, dirs: args.dir });
  const created = await client.createTask({
    title: args.title || command || prompt,
    type,
    command,
    prompt,
    priority: args.priority ? Number(args.priority) : undefined,
    workerId: args.worker,
    sessionId: args.session,
    requiredCapabilities: valueList(args.capability || args.capabilities),
    requiredTools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    requiredLabels: parseLabels(args['required-label'] || args['required-labels']),
    requiredResources: resourceRequirementsFromArgs(args),
    slots: parseSlots(args.slots || args['task-slots']),
    env: parseEnv(args.env),
    sandboxProfile: sandboxProfileFromArgs(args),
    artifactPolicy: artifactPolicyFromArgs(args),
    dependencyArtifacts: dependencyArtifactsFromArgs(args),
    requireRoutable: Boolean(args['require-routable'] || args.requireRoutable),
    inputFiles: localInputFiles.map(submittedInputFile),
    keepWorkspace: args['cleanup-workspace'] ? false : args['keep-workspace'] ? true : undefined,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
    maxAttempts: args['max-attempts'] ? Number(args['max-attempts']) : undefined,
    retryPolicy: retryPolicyFromArgs(args),
    retryBackoffMs: args['retry-backoff-ms'] ? Number(args['retry-backoff-ms']) : undefined,
    maxRetryBackoffMs: args['max-retry-backoff-ms'] ? Number(args['max-retry-backoff-ms']) : undefined,
    idempotencyKey: args['idempotency-key'] || undefined,
  });
  const task = await uploadLocalTaskInputs(client, created.task, localInputFiles);
  console.log(`submitted ${task.id}`);
  console.log(`status=${task.status}`);
  console.log(`requestedWorker=${task.requestedWorkerId || '-'}`);
  console.log(`session=${task.sessionId || '-'}`);
  console.log(`priority=${task.priority || 0}`);
  console.log(`slots=${task.slots || 1}`);
  console.log(`attempts=${task.attemptSeq || 0}/${task.maxAttempts || 3}`);
  console.log(`retryPolicy=${JSON.stringify(task.retryPolicy || { failureKinds: [], exitCodes: [] })}`);
  console.log(`idempotencyKey=${task.idempotencyKey || '-'}`);
  console.log(`inputFiles=${task.inputFiles?.map((file) => file.path).join(',') || '-'}`);
  console.log(`keepWorkspace=${task.keepWorkspace === undefined ? 'worker-default' : task.keepWorkspace}`);
  console.log(`env=${Object.keys(task.env || {}).join(',') || '-'}`);
  console.log(`sandboxProfile=${task.sandboxProfile || 'default'}`);
  console.log(`artifactPolicy=${formatArtifactPolicy(task.artifactPolicy)}`);
  console.log(`dependencyArtifacts=${task.dependencyArtifacts?.enabled ? task.dependencyArtifacts.prefix : 'disabled'}`);
  console.log(`requiredCapabilities=${task.requiredCapabilities.join(',') || '-'}`);
  console.log(`requiredTools=${task.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(task.requiredLabels)}`);
  console.log(`requiredResources=${JSON.stringify(task.requiredResources || {})}`);
  printSchedulerSummary(task.scheduler);

  const shouldWait = Boolean(args.wait || args.watch || args.download);
  let finalTask = task;
  if (shouldWait) {
    finalTask = await waitForTaskTerminal(client, task.id, {
      timeoutMs: Number(args['wait-timeout'] || args.waitTimeout || 60_000),
      watch: Boolean(args.watch),
    });
    console.log(`waitStatus=${finalTask.status}`);
    console.log(`assignedWorker=${finalTask.assignedWorkerId || '-'}`);
    console.log(`exitCode=${finalTask.exitCode ?? '-'}`);
  }
  if (args.download) {
    const downloaded = await downloadTaskArtifacts(client, task.id, args.out || '.');
    console.log(`downloaded ${downloaded.count} artifacts -> ${downloaded.outRoot}`);
  }
  if (shouldWait && finalTask.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function loadBatchSpec(file) {
  const batchFile = path.resolve(file);
  const text = await fs.readFile(batchFile, 'utf8');
  const spec = JSON.parse(text);
  if (!Array.isArray(spec.tasks)) {
    throw new Error('Batch JSON requires a tasks array');
  }
  return { spec, batchFile };
}

async function materializeBatchInputs(spec, batchFile) {
  const baseDir = path.dirname(batchFile);
  const tasks = [];
  for (const task of spec.tasks) {
    const localInputFiles = await buildInputFiles({
      files: task.file || task.files,
      dirs: task.dir || task.dirs,
      baseDir,
    });
    const inputFiles = [
      ...(task.inputFiles || []),
      ...localInputFiles,
    ];
    const cleaned = { ...task };
    delete cleaned.file;
    delete cleaned.files;
    delete cleaned.dir;
    delete cleaned.dirs;
    if (inputFiles.length) {
      cleaned.inputFiles = inputFiles;
    }
    tasks.push(cleaned);
  }
  return {
    ...spec,
    tasks,
  };
}

async function commandBatchSubmit(args) {
  const file = requireValue(args.file, 'Batch submit requires --file');
  const { spec, batchFile } = await loadBatchSpec(file);
  const materialized = await materializeBatchInputs(spec, batchFile);
  const localInputsByKey = new Map();
  const submitted = {
    ...materialized,
    tasks: materialized.tasks.map((task, index) => {
      const key = String(task.key || task.id || `task_${index + 1}`);
      const localFiles = (task.inputFiles || []).filter((file) => file.localPath);
      localInputsByKey.set(key, localFiles);
      return {
        ...task,
        inputFiles: (task.inputFiles || []).map(submittedInputFile),
      };
    }),
  };
  if (args['require-routable'] || args.requireRoutable) {
    submitted.requireRoutable = true;
  }
  const client = makeClient(args);
  const created = await client.createBatch(submitted);
  const batch = created.batch;
  const tasks = [];
  for (const task of created.tasks) {
    tasks.push(await uploadLocalTaskInputs(client, task, localInputsByKey.get(task.batchKey) || []));
  }
  console.log(`batch=${batch.id}`);
  console.log(`title=${batch.title}`);
  console.log(`tasks=${tasks.length}`);
  for (const task of tasks) {
    console.log(`- ${task.id} status=${task.status} key=${task.batchKey || '-'} dependsOn=${task.dependencyKeys?.join(',') || '-'} slots=${task.slots || 1} inputFiles=${task.inputFiles?.map((item) => item.path).join(',') || '-'} requiredTools=${task.requiredTools?.join(',') || '-'} requestedWorker=${task.requestedWorkerId || '-'} title=${task.title}`);
    printBatchTaskSchedulerSummary(task);
  }

  const shouldWait = Boolean(args.wait || args.report || args.download);
  let finalBatch = batch;
  if (shouldWait) {
    finalBatch = await waitForBatchTerminal(client, batch.id, Number(args.timeout || 60_000));
    console.log(`waitStatus=${finalBatch.status}`);
    console.log(`completed=${finalBatch.completedTasks}/${finalBatch.totalTasks}`);
  }
  if (args.report) {
    const report = await client.getBatchReport(batch.id, {
      stdoutChars: Number(args['stdout-chars'] || 1_200),
      stderrChars: Number(args['stderr-chars'] || 1_200),
    });
    console.log('');
    console.log(formatBatchReport(report));
  }
  if (args.download) {
    const downloaded = await downloadBatchArtifacts(client, batch.id, args.out || '.');
    console.log(`downloaded ${downloaded.count} batch artifacts from ${downloaded.taskCount}/${downloaded.batch.totalTasks} tasks -> ${downloaded.outRoot}`);
  }
  if (shouldWait && finalBatch.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function commandBatchPlan(args) {
  const plan = buildBatchPlan({
    title: args.title || 'planned batch',
    tasks: await readTaskLines(args),
    type: args.type || 'agent',
    commandTemplate: args['command-template'],
    workerId: args.worker,
    capabilities: valueList(args.capability || args.capabilities),
    tools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    labels: parseLabels(args['required-label'] || args['required-labels'] || args.label),
    slots: args.slots || args['task-slots'],
    priority: args.priority,
    keepWorkspace: args['cleanup-workspace'] ? false : args['keep-workspace'] ? true : undefined,
    sandboxProfile: sandboxProfileFromArgs(args),
  });
  const text = `${JSON.stringify(plan, null, 2)}\n`;
  if (args.out) {
    const out = path.resolve(args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, text, 'utf8');
    console.log(`wrote ${out}`);
    console.log(`tasks=${plan.tasks.length}`);
    return;
  }
  console.log(text.trimEnd());
}

async function plannerRequestFromArgs(args) {
  const prompt = args['prompt-file']
    ? await fs.readFile(path.resolve(args['prompt-file']), 'utf8')
    : args.prompt;
  const request = {
    title: args.title || undefined,
    prompt: requireValue(prompt, 'Planner requires --prompt or --prompt-file'),
    mode: args.mode || 'auto',
    subtasks: valueList(args.subtask || args.subtasks || args.task || args.tasks),
    shards: args.shards || args['shard-count'],
    type: args.type || 'agent',
    workerId: args.worker,
    capabilities: valueList(args.capability || args.capabilities),
    tools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    labels: parseLabels(args['required-label'] || args['required-labels'] || args.label),
    slots: args.slots || args['task-slots'],
    priority: args.priority,
    keepWorkspace: args['cleanup-workspace'] ? false : args['keep-workspace'] ? true : undefined,
    sandboxProfile: sandboxProfileFromArgs(args),
    requireRoutable: Boolean(args['require-routable'] || args.requireRoutable),
  };
  if (!request.subtasks.length) {
    delete request.subtasks;
  }
  return request;
}

async function commandPlannerPlan(args) {
  const client = makeClient(args);
  const result = await client.planDistributedTask(await plannerRequestFromArgs(args));
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`planner=${result.planner.mode}`);
    console.log(`strategy=${result.planner.strategy}`);
    console.log(`tasks=${result.planner.taskCount} shards=${result.planner.shardCount}`);
    console.log(`dispatch assigned=${result.dispatchPlan.counts.assigned} unassigned=${result.dispatchPlan.counts.unassigned}`);
    for (const item of result.dispatchPlan.items) {
      console.log(`- ${item.key}: worker=${item.scheduler.workerId || '-'} reason=${item.scheduler.reason} title=${item.title}`);
    }
  }
  if (args.out) {
    const out = path.resolve(args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(result.batch, null, 2)}\n`, 'utf8');
    console.log(`wrote ${out}`);
  }
}

async function commandPlannerRun(args) {
  const client = makeClient(args);
  const result = await client.runDistributedTaskPlan(await plannerRequestFromArgs(args));
  console.log(`planner=${result.planner.mode}`);
  console.log(`batch=${result.batch.id}`);
  console.log(`title=${result.batch.title}`);
  console.log(`tasks=${result.tasks.length}`);
  for (const task of result.tasks) {
    console.log(`- ${task.id} status=${task.status} key=${task.batchKey || '-'} dependsOn=${task.dependencyKeys?.join(',') || '-'} requestedWorker=${task.requestedWorkerId || '-'} title=${task.title}`);
    printBatchTaskSchedulerSummary(task);
  }
  const shouldWait = Boolean(args.wait || args.report || args.download);
  let finalBatch = result.batch;
  if (shouldWait) {
    finalBatch = await waitForBatchTerminal(client, result.batch.id, Number(args.timeout || 60_000));
    console.log(`waitStatus=${finalBatch.status}`);
    console.log(`completed=${finalBatch.completedTasks}/${finalBatch.totalTasks}`);
  }
  if (args.report) {
    const report = await client.getBatchReport(result.batch.id, {
      stdoutChars: Number(args['stdout-chars'] || 1_200),
      stderrChars: Number(args['stderr-chars'] || 1_200),
    });
    console.log('');
    console.log(formatBatchReport(report));
  }
  if (args.download) {
    const downloaded = await downloadBatchArtifacts(client, result.batch.id, args.out || '.');
    console.log(`downloaded ${downloaded.count} batch artifacts from ${downloaded.taskCount}/${downloaded.batch.totalTasks} tasks -> ${downloaded.outRoot}`);
  }
  if (shouldWait && finalBatch.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function commandDispatchPlan(args) {
  const client = makeClient(args);
  let spec;
  if (args.file) {
    spec = (await loadBatchSpec(args.file)).spec;
  } else {
    spec = buildBatchPlan({
      title: args.title || 'dispatch plan',
      tasks: await readTaskLines(args),
      type: args.type || 'agent',
      commandTemplate: args['command-template'],
      workerId: args.worker,
      capabilities: valueList(args.capability || args.capabilities),
      tools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
      labels: parseLabels(args['required-label'] || args['required-labels'] || args.label),
      slots: args.slots || args['task-slots'],
      priority: args.priority,
      keepWorkspace: args['cleanup-workspace'] ? false : args['keep-workspace'] ? true : undefined,
      sandboxProfile: sandboxProfileFromArgs(args),
    });
  }

  const { plan } = await client.planDispatch(spec);
  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`dispatchPlan=${plan.title}`);
  console.log(`tasks=${plan.totalTasks} assigned=${plan.counts.assigned} unassigned=${plan.counts.unassigned}`);
  for (const item of plan.items) {
    const nextAction = item.nextAction?.code ? ` nextAction=${item.nextAction.code}` : '';
    console.log(`- ${item.key}: worker=${item.scheduler.workerId || '-'} reason=${item.scheduler.reason} slots=${item.slots}${nextAction} title=${item.title}`);
    for (const candidate of item.scheduler.candidates || []) {
      const score = candidate.score === null || candidate.score === undefined ? '-' : candidate.score;
      console.log(`  candidate ${candidate.workerId}: eligible=${candidate.eligible} score=${score} reasons=${candidate.reasons?.join('; ') || '-'}`);
    }
  }
}

async function commandBatches(args) {
  const client = makeClient(args);
  const { batches } = await client.listBatches();
  printTable(batches, [
    { header: 'id', value: (batch) => batch.id },
    { header: 'status', value: (batch) => batch.status },
    { header: 'done', value: (batch) => `${batch.completedTasks}/${batch.totalTasks}` },
    { header: 'running', value: (batch) => batch.counts.running || 0 },
    { header: 'queued', value: (batch) => batch.counts.queued || 0 },
    { header: 'blocked', value: (batch) => batch.counts.blocked || 0 },
    { header: 'title', value: (batch) => batch.title.slice(0, 48) },
  ]);
}

async function commandBatch(args) {
  const batchId = args._[1];
  if (!batchId) {
    throw new Error('Batch id is required');
  }
  const client = makeClient(args);
  const result = await client.getBatch(batchId);
  console.log(JSON.stringify(result, null, 2));
}

async function commandBatchDownload(args) {
  const batchId = args._[2];
  if (!batchId) {
    throw new Error('Usage: nado batch download BATCH_ID --out ./downloads');
  }
  const client = makeClient(args);
  const downloaded = await downloadBatchArtifacts(client, batchId, args.out || '.');
  console.log(`downloaded ${downloaded.count} batch artifacts from ${downloaded.taskCount}/${downloaded.batch.totalTasks} tasks -> ${downloaded.outRoot}`);
}

async function downloadBatchArtifacts(client, batchId, outRootValue) {
  const { batch, tasks } = await client.getBatchArtifacts(batchId);
  let count = 0;
  let taskCount = 0;
  const outRoot = path.resolve(outRootValue || '.');
  for (const task of tasks) {
    const artifacts = task.artifacts.filter((artifact) => !artifact.skipped);
    if (!artifacts.length) {
      continue;
    }
    taskCount += 1;
    const taskDir = safeName(task.batchKey || task.taskId);
    for (const artifact of artifacts) {
      await writeArtifact(path.join(outRoot, taskDir), artifact, artifact.contentBase64);
      count += 1;
    }
  }
  if (!count) {
    throw new Error(`Batch has no downloadable artifacts: ${batchId}`);
  }
  return { batch, count, taskCount, outRoot };
}

async function commandBatchReport(args) {
  const batchId = args._[2];
  if (!batchId) {
    throw new Error('Usage: nado batch report BATCH_ID --control URL');
  }
  const client = makeClient(args);
  const report = await client.getBatchReport(batchId, {
    stdoutChars: Number(args['stdout-chars'] || 1_200),
    stderrChars: Number(args['stderr-chars'] || 1_200),
  });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatBatchReport(report));
}

async function commandBatchEvents(args) {
  const batchId = args._[2];
  if (!batchId) {
    throw new Error('Usage: nado batch events BATCH_ID --control URL');
  }
  const client = makeClient(args);
  const timeoutMs = Number(args.timeout || 60_000);
  const started = Date.now();
  const printed = new Set();

  while (true) {
    const { batch, events: rows } = await client.listBatchEvents(batchId);
    const unseen = rows.filter((row) => {
      const key = `${row.at}|${row.source}|${row.task}|${row.type}|${row.order}`;
      if (printed.has(key)) {
        return false;
      }
      printed.add(key);
      return true;
    });

    if (args.watch) {
      for (const row of unseen) {
        console.log(`${row.at} ${row.source} task=${row.task} type=${row.type} worker=${row.workerId} ${String(row.message || '').replace(/\s+$/g, '')}`.trimEnd());
      }
      if (isTerminalBatch(batch)) {
        return;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out watching batch ${batchId}; last status=${batch.status}`);
      }
      await sleep(500);
      continue;
    }

    printTable(rows, [
      { header: 'at', value: (row) => row.at },
      { header: 'source', value: (row) => row.source },
      { header: 'task', value: (row) => row.task },
      { header: 'type', value: (row) => row.type },
      { header: 'worker', value: (row) => row.workerId },
      { header: 'message', value: (row) => String(row.message || '').replace(/\s+/g, ' ').slice(0, 80) },
    ]);
    return;
  }
}

function isTerminalBatch(batch) {
  return ['succeeded', 'completed_with_errors'].includes(batch.status);
}

async function waitForBatchTerminal(client, batchId, timeoutMs = 60_000) {
  const started = Date.now();
  let lastBatch = null;
  while (Date.now() - started <= timeoutMs) {
    const { batch } = await client.getBatch(batchId);
    lastBatch = batch;
    if (isTerminalBatch(batch)) {
      return batch;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for batch ${batchId}; last status=${lastBatch?.status || 'unknown'}`);
}

async function commandBatchWait(args) {
  const batchId = args._[2];
  if (!batchId) {
    throw new Error('Usage: nado batch wait BATCH_ID --control URL');
  }
  const client = makeClient(args);
  const batch = await waitForBatchTerminal(client, batchId, Number(args.timeout || 60_000));
  console.log(`batch=${batch.id}`);
  console.log(`status=${batch.status}`);
  console.log(`completed=${batch.completedTasks}/${batch.totalTasks}`);
  if (batch.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function commandBatchManage(args) {
  const batchId = args._[2];
  const action = requireValue(args.action, 'Batch manage requires --action');
  if (!batchId) {
    throw new Error('Usage: nado batch manage BATCH_ID --action retry_failed|cancel');
  }
  const client = makeClient(args);
  const options = {
    reason: args.reason || '',
  };
  if (args.worker !== undefined) {
    options.workerId = args.worker;
  }
  if (args.capability !== undefined || args.capabilities !== undefined) {
    options.requiredCapabilities = valueList(args.capability || args.capabilities);
  }
  if (args.tool !== undefined || args.tools !== undefined || args['required-tool'] !== undefined || args['required-tools'] !== undefined) {
    options.requiredTools = parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']);
  }
  if (args.slots !== undefined || args['task-slots'] !== undefined) {
    options.slots = parseSlots(args.slots || args['task-slots']);
  }
  if (args['required-label'] !== undefined || args['required-labels'] !== undefined) {
    options.requiredLabels = parseLabels(args['required-label'] || args['required-labels']);
  }
  if (resourceRequirementsFromArgs(args)) {
    options.requiredResources = resourceRequirementsFromArgs(args);
  }
  const result = await client.manageBatch(batchId, action, options);
  console.log(`batch=${result.batch.id}`);
  console.log(`status=${result.batch.status}`);
  console.log(`cancelled=${result.cancelled?.length || 0}`);
  console.log(`retried=${result.retried?.length || 0}`);
  console.log(`skipped=${result.skipped.length}`);
  for (const task of result.cancelled || []) {
    console.log(`- cancelled ${task.id} status=${task.status}`);
  }
  for (const task of result.retried || []) {
    console.log(`- retried ${task.id} requestedWorker=${task.requestedWorkerId || '-'}`);
  }
}

async function commandSessionCreate(args) {
  const client = makeClient(args);
  const { session } = await client.createSession({
    title: args.title || 'untitled session',
    workerId: args.worker,
    requiredCapabilities: valueList(args.capability || args.capabilities),
    requiredTools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    requiredLabels: parseLabels(args['required-label'] || args['required-labels']),
    requiredResources: resourceRequirementsFromArgs(args),
    labels: parseLabels(args.label),
  });
  console.log(`created ${session.id}`);
  console.log(`title=${session.title}`);
  console.log(`requestedWorker=${session.requestedWorkerId || '-'}`);
  console.log(`requiredCapabilities=${session.requiredCapabilities.join(',') || '-'}`);
  console.log(`requiredTools=${session.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(session.requiredLabels)}`);
  console.log(`requiredResources=${JSON.stringify(session.requiredResources || {})}`);
}

async function commandSessions(args) {
  const client = makeClient(args);
  const { sessions } = await client.listSessions();
  printTable(sessions, [
    { header: 'id', value: (session) => session.id },
    { header: 'status', value: (session) => session.status },
    { header: 'worker', value: (session) => session.assignedWorkerId || session.requestedWorkerId || '-' },
    { header: 'task', value: (session) => session.currentTaskId || '-' },
    { header: 'caps', value: (session) => session.requiredCapabilities.join(',') || '-' },
    { header: 'tools', value: (session) => session.requiredTools?.join(',') || '-' },
    { header: 'labels', value: (session) => formatLabels(session.requiredLabels) },
    { header: 'title', value: (session) => session.title.slice(0, 48) },
  ]);
}

async function commandSession(args) {
  const sessionId = args._[1];
  if (!sessionId) {
    throw new Error('Session id is required');
  }
  const client = makeClient(args);
  const { session } = await client.getSession(sessionId);
  console.log(JSON.stringify(session, null, 2));
}

async function commandSessionClose(args) {
  const sessionId = args._[2];
  if (!sessionId) {
    throw new Error('Usage: nado session close SESSION_ID --control URL');
  }
  const client = makeClient(args);
  const { session } = await client.closeSession(sessionId);
  console.log(`closed ${session.id}`);
}

async function commandSessionDownload(args) {
  const sessionId = args._[2];
  if (!sessionId) {
    throw new Error('Usage: nado session download SESSION_ID --out ./downloads');
  }
  const client = makeClient(args);
  const { session } = await client.getSession(sessionId);
  const taskIds = [...(session.taskIds || [])].reverse();
  let sourceTaskId = null;
  let artifacts = [];
  for (const taskId of taskIds) {
    const listed = await client.listArtifacts(taskId);
    const stored = listed.artifacts.filter((artifact) => !artifact.skipped);
    if (stored.length) {
      sourceTaskId = taskId;
      artifacts = stored;
      break;
    }
  }
  if (!sourceTaskId) {
    throw new Error(`Session has no downloadable artifacts: ${sessionId}`);
  }
  let count = 0;
  for (const artifact of artifacts) {
    const fetched = await client.getArtifact(sourceTaskId, artifact.id);
    await writeArtifact(args.out || '.', fetched.artifact, fetched.contentBase64);
    count += 1;
  }
  console.log(`downloaded ${count} session artifacts from ${sourceTaskId} -> ${path.resolve(args.out || '.')}`);
}

async function commandTasks(args) {
  const client = makeClient(args);
  const { tasks } = await client.listTasks();
  printTable(tasks, [
    { header: 'id', value: (task) => task.id },
    { header: 'status', value: (task) => task.status },
    { header: 'runtime', value: (task) => task.runtimeDiagnostics?.state || '-' },
    { header: 'prio', value: (task) => task.priority || 0 },
    { header: 'worker', value: (task) => task.assignedWorkerId || task.requestedWorkerId || '-' },
    { header: 'session', value: (task) => task.sessionId || '-' },
    { header: 'batch', value: (task) => task.batchId || '-' },
    { header: 'tools', value: (task) => task.requiredTools?.join(',') || '-' },
    { header: 'labels', value: (task) => formatLabels(task.requiredLabels) },
    { header: 'type', value: (task) => task.type },
    { header: 'title', value: (task) => task.title.slice(0, 48) },
  ]);
}

async function commandTask(args) {
  const taskId = args._[1];
  if (!taskId) {
    throw new Error('Task id is required');
  }
  const client = makeClient(args);
  const { task } = await client.getTask(taskId);
  console.log(JSON.stringify(task, null, 2));
}

async function commandSchedule(args) {
  const taskId = args._[1];
  if (!taskId) {
    throw new Error('Task id is required');
  }
  const client = makeClient(args);
  const { scheduler } = await client.explainSchedule(taskId);
  console.log(JSON.stringify(scheduler || null, null, 2));
}

function isTerminalTask(task) {
  return ['succeeded', 'failed', 'cancelled'].includes(task.status);
}

function printEventLine(event) {
  const worker = event.workerId ? ` worker=${event.workerId}` : '';
  const message = String(event.message || '').replace(/\s+$/g, '');
  console.log(`${event.at} ${event.type}${worker} ${message}`.trimEnd());
}

function taskWaitDiagnosticLines(task) {
  if (!task) {
    return [];
  }
  const scheduler = task.scheduler || {};
  const lines = [
    `taskStatus=${task.status || '-'}`,
    `requestedWorker=${task.requestedWorkerId || '-'}`,
    `assignedWorker=${task.assignedWorkerId || '-'}`,
  ];
  if (scheduler.reason || scheduler.workerId || scheduler.effectiveRequiredCapabilities?.length) {
    lines.push(`schedulerWorker=${scheduler.workerId || '-'}`);
    lines.push(`schedulerReason=${scheduler.reason || '-'}`);
    lines.push(`schedulerEffectiveCapabilities=${scheduler.effectiveRequiredCapabilities?.join(',') || '-'}`);
    lines.push(`schedulerInferredCapabilities=${scheduler.inferredCapabilities?.join(',') || '-'}`);
  }
  for (const warning of scheduler.warnings || []) {
    lines.push(`schedulerWarning=${warning.code || '-'} severity=${warning.severity || '-'} worker=${warning.workerId || '-'} message=${warning.message || '-'}`);
  }
  for (const candidate of scheduler.candidates || []) {
    const score = candidate.score === null || candidate.score === undefined ? '-' : candidate.score;
    lines.push(`schedulerCandidate=${candidate.workerId || '-'} eligible=${candidate.eligible} score=${score} reasons=${candidate.reasons?.join('; ') || '-'}`);
  }
  const lastEvent = Array.isArray(task.events) && task.events.length ? task.events[task.events.length - 1] : null;
  if (lastEvent) {
    lines.push(`lastEvent=${lastEvent.type || '-'} ${String(lastEvent.message || '').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const actionHint = task.runtimeDiagnostics?.nextAction || routingActionHint(task);
  if (actionHint) {
    lines.push(`nextAction=${actionHint.code}`);
    lines.push(`nextActionMessage=${actionHint.message}`);
  }
  return lines;
}

async function commandWait(args) {
  const taskId = args._[1];
  if (!taskId) {
    throw new Error('Task id is required');
  }
  const client = makeClient(args);
  const task = await waitForTaskTerminal(client, taskId, {
    timeoutMs: Number(args.timeout || 60_000),
    watch: Boolean(args.watch),
  });
  console.log(`task=${task.id}`);
  console.log(`status=${task.status}`);
  console.log(`assignedWorker=${task.assignedWorkerId || '-'}`);
  console.log(`exitCode=${task.exitCode ?? '-'}`);
  if (task.status !== 'succeeded') {
    process.exitCode = 1;
  }
}

async function waitForTaskTerminal(client, taskId, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60_000);
  const started = Date.now();
  let printedEvents = 0;
  let lastTask = null;

  while (Date.now() - started <= timeoutMs) {
    const { task } = await client.getTask(taskId);
    lastTask = task;
    if (options.watch) {
      const events = task.events || [];
      for (const event of events.slice(printedEvents)) {
        printEventLine(event);
      }
      printedEvents = events.length;
    }
    if (isTerminalTask(task)) {
      return task;
    }
    await sleep(500);
  }

  const status = lastTask?.status || 'unknown';
  const diagnostics = taskWaitDiagnosticLines(lastTask);
  const detail = diagnostics.length ? `\n${diagnostics.join('\n')}` : '';
  throw new Error(`Timed out waiting for ${taskId}; last status=${status}${detail}`);
}

async function commandRecover(args) {
  const client = makeClient(args);
  const action = args.action || 'list';
  if (action === 'list') {
    const { candidates } = await client.listOfflineRunningTasks(args.worker || '');
    printTable(candidates, [
      { header: 'task', value: (item) => item.task.id },
      { header: 'worker', value: (item) => item.task.assignedWorkerId || '-' },
      { header: 'reason', value: (item) => item.recoveryReason || 'worker_offline' },
      { header: 'offlineMs', value: (item) => item.offlineMs ?? '-' },
      { header: 'leaseExpiredMs', value: (item) => item.leaseExpiredMs ?? '-' },
      { header: 'session', value: (item) => item.task.sessionId || '-' },
      { header: 'title', value: (item) => item.task.title.slice(0, 48) },
    ]);
    return;
  }
  if (action !== 'requeue') {
    throw new Error('Usage: nado recover --action list|requeue');
  }
  const result = await client.recoverOfflineTasks({
    action,
    workerId: args.worker || undefined,
    targetWorkerId: args['target-worker'] || undefined,
    includeSessions: Boolean(args['include-sessions']),
    requiredCapabilities: args.capability !== undefined || args.capabilities !== undefined
      ? valueList(args.capability || args.capabilities)
      : undefined,
    requiredTools: args.tool !== undefined || args.tools !== undefined || args['required-tool'] !== undefined || args['required-tools'] !== undefined
      ? parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools'])
      : undefined,
    requiredLabels: args['required-label'] !== undefined || args['required-labels'] !== undefined
      ? parseLabels(args['required-label'] || args['required-labels'])
      : undefined,
    reason: args.reason || '',
  });
  console.log(`candidates=${result.candidates.length}`);
  console.log(`recovered=${result.recovered.length}`);
  console.log(`exhausted=${result.exhausted?.length || 0}`);
  console.log(`skipped=${result.skipped.length}`);
  for (const task of result.recovered) {
    console.log(`- recovered ${task.id} requestedWorker=${task.requestedWorkerId || '-'} status=${task.status} notBefore=${task.notBeforeAt || '-'}`);
  }
  for (const task of result.exhausted || []) {
    console.log(`- exhausted ${task.id}: ${task.error}`);
  }
  for (const skipped of result.skipped) {
    console.log(`- skipped ${skipped.task.id}: ${skipped.reason}`);
  }
}

async function commandTaskManage(args) {
  const taskId = args._[2];
  const action = requireValue(args.action, 'Task manage requires --action');
  if (!taskId) {
    throw new Error('Usage: nado task manage TASK_ID --action cancel|requeue|reschedule');
  }
  const client = makeClient(args);
  const options = {
    reason: args.reason || '',
  };
  if (args.worker !== undefined) {
    options.workerId = args.worker;
  }
  if (args.capability !== undefined || args.capabilities !== undefined) {
    options.requiredCapabilities = valueList(args.capability || args.capabilities);
  }
  if (args.tool !== undefined || args.tools !== undefined || args['required-tool'] !== undefined || args['required-tools'] !== undefined) {
    options.requiredTools = parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']);
  }
  if (args.slots !== undefined || args['task-slots'] !== undefined) {
    options.slots = parseSlots(args.slots || args['task-slots']);
  }
  if (args['required-label'] !== undefined || args['required-labels'] !== undefined) {
    options.requiredLabels = parseLabels(args['required-label'] || args['required-labels']);
  }
  if (resourceRequirementsFromArgs(args)) {
    options.requiredResources = resourceRequirementsFromArgs(args);
  }
  const { task } = await client.manageTask(taskId, action, options);
  console.log(`task=${task.id}`);
  console.log(`status=${task.status}`);
  console.log(`requestedWorker=${task.requestedWorkerId || '-'}`);
  console.log(`slots=${task.slots || 1}`);
  console.log(`requiredTools=${task.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(task.requiredLabels)}`);
  console.log(`requiredResources=${JSON.stringify(task.requiredResources || {})}`);
  if (task.scheduler) {
    console.log(`scheduler=${task.scheduler.reason}`);
  }
}

async function commandEvents(args) {
  const taskId = args._[1];
  if (!taskId) {
    throw new Error('Task id is required');
  }
  const client = makeClient(args);
  const { events } = await client.listTaskEvents(taskId, {
    tail: args.tail !== undefined ? Number(args.tail) : undefined,
  });
  printTable(events || [], [
    { header: 'at', value: (event) => event.at },
    { header: 'type', value: (event) => event.type },
    { header: 'worker', value: (event) => event.workerId || '-' },
    { header: 'message', value: (event) => String(event.message || '').replace(/\s+/g, ' ').slice(0, 80) },
  ]);
}

async function commandArtifacts(args) {
  const taskId = args._[1];
  if (!taskId) {
    throw new Error('Task id is required');
  }
  const client = makeClient(args);
  const { artifacts } = await client.listArtifacts(taskId);
  printTable(artifacts, [
    { header: 'id', value: (artifact) => artifact.id },
    { header: 'path', value: (artifact) => artifact.path },
    { header: 'size', value: (artifact) => artifact.size },
    { header: 'sha256', value: (artifact) => artifact.sha256?.slice(0, 12) || '-' },
    { header: 'status', value: (artifact) => (artifact.skipped ? `skipped:${artifact.reason}` : 'stored') },
  ]);
}

async function commandArtifactDownload(args) {
  const taskId = args._[2];
  const artifactId = args._[3];
  if (!taskId || !artifactId) {
    throw new Error('Usage: nado artifact download TASK_ID ARTIFACT_ID --out ./downloads');
  }
  const client = makeClient(args);
  const { artifact, bytes } = await client.downloadArtifact(taskId, artifactId);
  const outFile = await writeArtifactBytes(args.out || '.', artifact, bytes);
  console.log(`downloaded ${artifact.path} -> ${outFile}`);
}

async function writeArtifact(outRootValue, artifact, contentBase64) {
  return writeArtifactBytes(outRootValue, artifact, Buffer.from(contentBase64, 'base64'));
}

async function writeArtifactBytes(outRootValue, artifact, bytes) {
  const outRoot = path.resolve(outRootValue || '.');
  const outFile = path.resolve(outRoot, artifact.path);
  if (outFile !== outRoot && !outFile.startsWith(`${outRoot}${path.sep}`)) {
    throw new Error(`Unsafe artifact path: ${artifact.path}`);
  }
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, bytes);
  return outFile;
}

async function commandArtifactsDownload(args) {
  const taskId = args._[2];
  if (!taskId) {
    throw new Error('Usage: nado artifacts download TASK_ID --out ./downloads');
  }
  const client = makeClient(args);
  const downloaded = await downloadTaskArtifacts(client, taskId, args.out || '.');
  console.log(`downloaded ${downloaded.count} artifacts -> ${downloaded.outRoot}`);
}

async function downloadTaskArtifacts(client, taskId, outRootValue) {
  const { artifacts } = await client.listArtifacts(taskId);
  let count = 0;
  const outRoot = path.resolve(outRootValue || '.');
  for (const artifact of artifacts) {
    if (artifact.skipped) {
      continue;
    }
    const fetched = await client.downloadArtifact(taskId, artifact.id);
    await writeArtifactBytes(outRoot, fetched.artifact, fetched.bytes);
    count += 1;
  }
  return { count, outRoot };
}

async function commandContext(args) {
  const controlUrl = controlUrlFrom(args);
  const client = makeClient(args);
  const [{ workers }, { sessions }] = await Promise.all([
    client.listWorkers(),
    client.listSessions(),
  ]);
  const out = path.resolve(args.out || path.join('.nado', 'AGENTS.md'));
  const context = buildAgentContext({ controlUrl, workers, sessions });
  await writeAgentContext(out, context);
  console.log(`wrote ${out}`);
}

async function commandContextInstall(args) {
  const controlUrl = controlUrlFrom(args);
  const client = makeClient(args);
  const [{ workers }, { sessions }] = await Promise.all([
    client.listWorkers(),
    client.listSessions(),
  ]);
  const out = path.resolve(args.out || 'AGENTS.md');
  const context = buildAgentContext({ controlUrl, workers, sessions });
  const installed = await installAgentContext(out, context, {
    marker: args.marker || undefined,
  });
  console.log(`${installed.mode} ${installed.file}`);
  console.log(`marker=${installed.marker}`);
}

async function commandMcpConfig(args) {
  const token = tokenFrom(args);
  const controlUrl = controlUrlFrom(args);
  const name = args.name || 'nado';
  const config = buildMcpClientConfig({ controlUrl, token, name });
  const format = args.format || 'json';
  if (format === 'json') {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  if (format === 'command') {
    console.log(formatMcpCommand(config, name));
    return;
  }
  throw new Error('Usage: nado mcp config --format json|command');
}

async function commandCapabilities(args) {
  const client = makeClient(args);
  const manifest = await client.capabilities();
  console.log(JSON.stringify(manifest, null, 2));
}

function formatCheckDetail(detail = {}) {
  const entries = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) {
    return '';
  }
  return ` ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}

async function commandDemoHealth(args) {
  const client = makeClient(args);
  const controlUrl = controlUrlFrom(args).replace(/\/+$/, '');
  const result = {
    ok: true,
    controlUrl,
    dashboardUrl: `${controlUrl}/dashboard`,
    generatedAt: new Date().toISOString(),
    status: null,
    network: null,
    routeChecks: [],
    verify: null,
    prune: null,
    problems: [],
  };

  try {
    result.status = await client.status();
  } catch (error) {
    result.problems.push(`status: ${error.message}`);
  }

  try {
    result.network = await client.networkInfo();
  } catch (error) {
    result.problems.push(`network: ${error.message}`);
  }

  if (result.status?.workers?.items) {
    try {
      result.routeChecks = await buildDemoRouteChecks({
        workers: result.status.workers.items,
        planDispatch: async (spec) => (await client.planDispatch(spec)).plan,
      });
      if (!demoRouteChecksOk(result.routeChecks)) {
        result.problems.push('routeChecks: one or more advertised capabilities did not route correctly');
      }
    } catch (error) {
      result.problems.push(`routeChecks: ${error.message}`);
    }
  }

  if (!args['skip-verify'] && !args.skipVerify) {
    result.verify = await runVerify(client, {
      allWorkers: true,
      timeoutMs: Number(args.timeout || 60_000),
    });
    if (!result.verify.ok) {
      result.problems.push(...result.verify.problems.map((problem) => `verify: ${problem}`));
    }
  }

  if (!args['no-prune'] && !args.noPrune) {
    try {
      result.prune = await client.pruneSystemHistory();
    } catch (error) {
      result.problems.push(`prune: ${error.message}`);
    }
  }

  try {
    result.status = await client.status();
  } catch (error) {
    result.problems.push(`finalStatus: ${error.message}`);
  }

  result.ok = result.problems.length === 0
    && Number(result.status?.workers?.active || 0) > 0;

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const status = result.status || {};
    const network = result.network || {};
    const attention = status.tasks?.attention?.total || 0;
    console.log(`demoHealth=${result.ok ? 'ok' : 'failed'}`);
    console.log(`control=${result.controlUrl}`);
    console.log(`dashboard=${result.dashboardUrl}`);
    console.log(`workers=${status.workers?.total || 0} active=${status.workers?.active || 0}`);
    console.log(`tasks=${status.tasks?.total || 0} attention=${attention}`);
    console.log(`networkRequest=${network.requestUrl || '-'} loopback=${network.requestIsLoopback ?? '-'}`);
    console.log(`publicControl=${network.publicControlUrl || '-'}`);
    console.log(`remoteWorkerReady=${network.remoteWorkerReady ?? '-'} preferredControl=${network.preferredRemoteControlUrl || '-'}`);
    if (network.nextAction) {
      console.log(`networkAction=${network.nextAction.code || '-'} severity=${network.nextAction.severity || '-'}`);
      console.log(`networkHint=${network.nextAction.message || '-'}`);
    }
    for (const worker of status.workers?.items || []) {
      const resources = workerResourceDiagnostics(worker);
      const gpu = resources.gpu;
      const readiness = worker.readiness || workerReadinessDiagnostics(worker);
      const agent = readiness.agent;
      console.log(`worker=${worker.id} state=${worker.gatewayState} admin=${worker.adminState} slots=${worker.runningSlots ?? worker.runningTasks ?? 0}/${worker.maxConcurrency || 1} caps=${worker.capabilities?.join(',') || '-'} gpu=${gpu.source} agent=${agent.status}/${agent.mode}`);
      if (gpu.warning) {
        console.log(`workerWarning=${worker.id} ${gpu.warning}`);
      }
      if (agent.warning) {
        console.log(`workerWarning=${worker.id} ${agent.warning}`);
      }
    }
    for (const check of result.routeChecks) {
      const inferred = check.inferredCapabilities.length ? check.inferredCapabilities.join(',') : '-';
      console.log(`routeCheck=${check.key} status=${check.status} worker=${check.workerId || '-'} inferred=${inferred} reason=${check.reason || '-'}`);
      for (const warning of check.warnings || []) {
        console.log(`routeWarning=${check.key} ${warning}`);
      }
    }
    if (result.verify) {
      console.log(`verify=${result.verify.ok ? 'ok' : 'failed'} checks=${result.verify.checks.length}`);
    } else {
      console.log('verify=skipped');
    }
    if (result.prune) {
      console.log(`prunedSystemHistory tasks=${result.prune.prunedTaskCount || 0} batches=${result.prune.prunedBatchCount || 0}`);
    }
    if (result.problems.length) {
      console.log('problems:');
      for (const problem of result.problems) {
        console.log(`- ${problem}`);
      }
    }
  }

  if (!result.ok) {
    process.exitCode = 2;
  }
}

async function commandDemoReset(args) {
  const client = makeClient(args);
  const keepValue = Number(args.keep ?? 0);
  const keep = Number.isFinite(keepValue) ? Math.max(0, keepValue) : 0;
  const taskPreview = await client.previewTaskPrune({ keep });
  const keepEmptySessions = Boolean(args['keep-empty-sessions'] || args.keepEmptySessions);
  const sessionPreview = keepEmptySessions ? { prunableCount: 0, sessions: [] } : await client.previewEmptySessions();
  let systemPreview = null;
  if (!args['no-system'] && !args.noSystem) {
    systemPreview = await client.previewSystemHistoryPrune();
  }
  const dryRun = Boolean(args['dry-run'] || args.dryRun);
  const yes = Boolean(args.yes);
  if (dryRun || !yes) {
    const preview = {
      dryRun: true,
      requiresYes: !yes,
      keep,
      standaloneTerminalTasks: taskPreview.totalStandaloneTerminal || 0,
      prunableTasks: taskPreview.prunableCount || 0,
      emptySessions: sessionPreview.prunableCount || 0,
      prunableSystemTasks: systemPreview?.prunableTaskCount || 0,
      prunableSystemBatches: systemPreview?.prunableBatchCount || 0,
      tasks: taskPreview.tasks || [],
      sessions: sessionPreview.sessions || [],
      systemTasks: systemPreview?.tasks || [],
      systemBatches: systemPreview?.batches || [],
    };
    if (args.json) {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      console.log('demoReset=dry-run');
      console.log(`keep=${keep}`);
      console.log(`prunableTasks=${preview.prunableTasks}`);
      console.log(`emptySessions=${preview.emptySessions}`);
      console.log(`prunableSystemTasks=${preview.prunableSystemTasks}`);
      console.log(`prunableSystemBatches=${preview.prunableSystemBatches}`);
      if (!yes) {
        console.log('applyWith=--yes');
      }
      for (const task of preview.tasks.slice(0, 20)) {
        console.log(`- task ${task.id} status=${task.status} title=${task.title}`);
      }
    }
    if (!dryRun && !yes) {
      process.exitCode = 2;
    }
    return;
  }

  const taskResult = await client.pruneTaskHistory({ keep });
  const emptySessionResult = keepEmptySessions ? { prunedCount: 0, sessions: [] } : await client.pruneEmptySessions();
  const systemResult = systemPreview ? await client.pruneSystemHistory() : null;
  const result = {
    dryRun: false,
    keep,
    prunedTasks: taskResult.prunedCount || 0,
    prunedEmptySessions: emptySessionResult.prunedCount || 0,
    closedEmptySessions: 0,
    prunedSystemTasks: systemResult?.prunedTaskCount || 0,
    prunedSystemBatches: systemResult?.prunedBatchCount || 0,
    sessions: emptySessionResult.sessions || [],
    taskResult,
    systemResult,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('demoReset=ok');
  console.log(`keep=${keep}`);
  console.log(`prunedTasks=${result.prunedTasks}`);
  console.log(`prunedEmptySessions=${result.prunedEmptySessions}`);
  console.log(`prunedSystemTasks=${result.prunedSystemTasks}`);
  console.log(`prunedSystemBatches=${result.prunedSystemBatches}`);
}

async function commandVerify(args) {
  const client = makeClient(args);
  const result = await runVerify(client, {
    workerId: args.worker || undefined,
    allWorkers: Boolean(args['all-workers']),
    requiredCapabilities: valueList(args.capability || args.capabilities),
    requiredTools: parseTools(args.tool || args.tools || args['required-tool'] || args['required-tools']),
    requiredLabels: parseLabels(args['required-label'] || args['required-labels']),
    timeoutMs: Number(args.timeout || 30_000),
    skipDoctor: Boolean(args['skip-doctor']),
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`verify=${result.ok ? 'ok' : 'failed'}`);
    console.log(`workers=${result.summary.workers.total} active=${result.summary.workers.active}`);
    for (const check of result.checks) {
      if (check.ok) {
        console.log(`${check.name}=ok durationMs=${check.durationMs}${formatCheckDetail(check.detail)}`);
      } else {
        console.log(`${check.name}=failed durationMs=${check.durationMs} error=${check.error}`);
      }
    }
    if (result.summary.taskId) {
      console.log(`task=${result.summary.taskId}`);
    }
    if (result.summary.batchId) {
      console.log(`batch=${result.summary.batchId}`);
    }
    if (result.problems.length) {
      console.log('problems:');
      for (const problem of result.problems) {
        console.log(`- ${problem}`);
      }
    }
  }

  if (!result.ok) {
    process.exitCode = 2;
  }
}

async function commandHistoryPruneSystem(args) {
  const client = makeClient(args);
  if (args['dry-run'] || args.dryRun) {
    const preview = await client.previewSystemHistoryPrune();
    if (args.json) {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    console.log(`prunableTasks=${preview.prunableTaskCount || 0}`);
    console.log(`prunableBatches=${preview.prunableBatchCount || 0}`);
    for (const batch of preview.batches || []) {
      console.log(`- batch ${batch.id} status=${batch.status} tasks=${batch.totalTasks || 0} title=${batch.title}`);
    }
    for (const task of preview.tasks || []) {
      console.log(`- task ${task.id} status=${task.status} title=${task.title}`);
    }
    return;
  }
  const result = await client.pruneSystemHistory();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`prunedTasks=${result.prunedTaskCount || 0}`);
  console.log(`prunedBatches=${result.prunedBatchCount || 0}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [command, subcommand] = args._;

  if (!command || command === 'help' || args.help) {
    console.log(usage());
    return;
  }

  if (command === 'quickstart') {
    await commandQuickstart(args);
    return;
  }
  if (command === 'control' && subcommand === 'start') {
    await commandControlStart(args);
    return;
  }
  if (command === 'store' && subcommand === 'backup') {
    await commandStoreBackup(args);
    return;
  }
  if (command === 'store' && subcommand === 'verify') {
    await commandStoreVerify(args);
    return;
  }
  if (command === 'store' && subcommand === 'restore') {
    await commandStoreRestore(args);
    return;
  }
  if (command === 'worker' && subcommand === 'start') {
    await commandWorkerStart(args);
    return;
  }
  if (command === 'worker' && subcommand === 'bootstrap-start') {
    await commandWorkerBootstrapStart(args);
    return;
  }
  if (command === 'worker' && subcommand === 'inspect') {
    await commandWorkerInspect(args);
    return;
  }
  if (command === 'worker' && subcommand === 'preflight') {
    await commandWorkerPreflight(args);
    return;
  }
  if (command === 'worker' && subcommand === 'logs') {
    await commandWorkerLogs(args);
    return;
  }
  if (command === 'worker' && subcommand === 'invite') {
    await commandWorkerInvite(args);
    return;
  }
  if (command === 'worker' && subcommand === 'bundle') {
    await commandWorkerBundle(args);
    return;
  }
  if (command === 'worker' && subcommand === 'bootstrap-bundle') {
    await commandWorkerBootstrapBundle(args);
    return;
  }
  if (command === 'worker' && subcommand === 'tokens') {
    await commandWorkerTokens(args);
    return;
  }
  if (command === 'worker' && subcommand === 'enrollments' && args._[2] === 'prune') {
    await commandWorkerEnrollmentPrune(args);
    return;
  }
  if (command === 'worker' && subcommand === 'enrollments') {
    await commandWorkerEnrollments(args);
    return;
  }
  if (command === 'worker' && subcommand === 'token' && args._[2] === 'create') {
    await commandWorkerTokenCreate(args);
    return;
  }
  if (command === 'worker' && subcommand === 'token' && args._[2] === 'rotate') {
    await commandWorkerTokenRotate(args);
    return;
  }
  if (command === 'worker' && subcommand === 'token' && args._[2] === 'revoke') {
    await commandWorkerTokenRevoke(args);
    return;
  }
  if (command === 'worker' && subcommand === 'enrollment' && args._[2] === 'revoke') {
    await commandWorkerEnrollmentRevoke(args);
    return;
  }
  if (command === 'worker' && subcommand === 'manage') {
    await commandWorkerManage(args);
    return;
  }
  if (command === 'agents') {
    await commandAgents();
    return;
  }
  if (command === 'status') {
    await commandStatus(args);
    return;
  }
  if (command === 'audit') {
    await commandAudit(args);
    return;
  }
  if (command === 'acceptance' && subcommand === 'template') {
    await commandAcceptanceTemplate(args);
    return;
  }
  if (command === 'acceptance' && subcommand === 'runbook') {
    await commandAcceptanceRunbook(args);
    return;
  }
  if (command === 'acceptance' && subcommand === 'evidence' && args._[2] === 'init') {
    await commandAcceptanceEvidenceInit(args);
    return;
  }
  if (command === 'acceptance' && subcommand === 'evidence' && args._[2] === 'record') {
    await commandAcceptanceEvidenceRecord(args);
    return;
  }
  if (command === 'acceptance' && subcommand === 'exercise') {
    await commandAcceptanceExercise(args);
    return;
  }
  if (command === 'acceptance') {
    await commandAcceptance(args);
    return;
  }
  if (command === 'deployment' && subcommand === 'check') {
    await commandDeploymentCheck(args);
    return;
  }
  if (command === 'network') {
    await commandNetwork(args);
    return;
  }
  if (command === 'demo' && subcommand === 'health') {
    await commandDemoHealth(args);
    return;
  }
  if (command === 'demo' && subcommand === 'reset') {
    await commandDemoReset(args);
    return;
  }
  if (command === 'capabilities') {
    await commandCapabilities(args);
    return;
  }
  if (command === 'verify') {
    await commandVerify(args);
    return;
  }
  if (command === 'doctor') {
    await commandDoctor(args);
    return;
  }
  if (command === 'workers') {
    await commandWorkers(args);
    return;
  }
  if (command === 'session' && subcommand === 'create') {
    await commandSessionCreate(args);
    return;
  }
  if (command === 'sessions') {
    await commandSessions(args);
    return;
  }
  if (command === 'session' && subcommand === 'close') {
    await commandSessionClose(args);
    return;
  }
  if (command === 'session' && subcommand === 'download') {
    await commandSessionDownload(args);
    return;
  }
  if (command === 'session') {
    await commandSession(args);
    return;
  }
  if (command === 'submit') {
    await commandSubmit(args);
    return;
  }
  if (command === 'batch' && subcommand === 'submit') {
    await commandBatchSubmit(args);
    return;
  }
  if (command === 'batch' && subcommand === 'plan') {
    await commandBatchPlan(args);
    return;
  }
  if (command === 'planner' && subcommand === 'plan') {
    await commandPlannerPlan(args);
    return;
  }
  if (command === 'planner' && subcommand === 'run') {
    await commandPlannerRun(args);
    return;
  }
  if (command === 'dispatch' && subcommand === 'plan') {
    await commandDispatchPlan(args);
    return;
  }
  if (command === 'batches') {
    await commandBatches(args);
    return;
  }
  if (command === 'batch' && subcommand === 'wait') {
    await commandBatchWait(args);
    return;
  }
  if (command === 'batch' && subcommand === 'events') {
    await commandBatchEvents(args);
    return;
  }
  if (command === 'batch' && subcommand === 'report') {
    await commandBatchReport(args);
    return;
  }
  if (command === 'batch' && subcommand === 'download') {
    await commandBatchDownload(args);
    return;
  }
  if (command === 'batch' && subcommand === 'manage') {
    await commandBatchManage(args);
    return;
  }
  if (command === 'batch') {
    await commandBatch(args);
    return;
  }
  if (command === 'tasks') {
    await commandTasks(args);
    return;
  }
  if (command === 'task' && subcommand === 'manage') {
    await commandTaskManage(args);
    return;
  }
  if (command === 'history' && subcommand === 'prune-system') {
    await commandHistoryPruneSystem(args);
    return;
  }
  if (command === 'schedule') {
    await commandSchedule(args);
    return;
  }
  if (command === 'wait') {
    await commandWait(args);
    return;
  }
  if (command === 'recover') {
    await commandRecover(args);
    return;
  }
  if (command === 'task') {
    await commandTask(args);
    return;
  }
  if (command === 'events') {
    await commandEvents(args);
    return;
  }
  if (command === 'artifacts' && subcommand === 'download') {
    await commandArtifactsDownload(args);
    return;
  }
  if (command === 'artifacts') {
    await commandArtifacts(args);
    return;
  }
  if (command === 'artifact' && subcommand === 'download') {
    await commandArtifactDownload(args);
    return;
  }
  if (command === 'context' && subcommand === 'install') {
    await commandContextInstall(args);
    return;
  }
  if (command === 'context') {
    await commandContext(args);
    return;
  }
  if (command === 'mcp' && subcommand === 'config') {
    await commandMcpConfig(args);
    return;
  }
  if (command === 'mcp') {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
    return;
  }

  throw new Error(`Unknown command: ${args._.join(' ')}`);
}

function cliErrorHints(error) {
  const hints = [];
  const path = String(error.path || '');
  const message = String(error.message || '');
  const responseError = String(error.response?.error || '');
  const status = Number(error.status || 0);

  if (path === '/api/workers/enroll' && (status === 401 || status === 403)) {
    hints.push('hint=Worker enrollment failed. Generate a fresh self-service bundle from the Dashboard or `nado worker bootstrap-bundle --issue-enrollment-token`, then retry on the worker host.');
    hints.push('hint=Also verify the bundle Control URL is reachable from the worker host and is not a 127.0.0.1/localhost URL from the control machine.');
  }
  if (path.includes('/api/workers/') && path.endsWith('/preflight')) {
    if (status === 401 && error.details?.code === 'worker_clock_skew') {
      hints.push(`hint=Worker clock differs from Control by ${error.details.clockSkewMs ?? 'unknown'}ms; allowed=${error.details.maxClockSkewMs ?? 'unknown'}ms. Synchronize NTP/Windows Time on both hosts, then retry preflight.`);
    }
    if (status === 401 && /Signed worker request headers are required|signature/i.test(responseError || message)) {
      hints.push('hint=Worker preflight needs the signed identity created during self-service enrollment. Keep the generated `.nado/worker-identity.json`, or download a fresh self-service bundle if the identity was deleted or copied from another host.');
    }
    if (status === 403 && /not valid for worker/i.test(responseError || message)) {
      hints.push('hint=Worker token and worker ID do not match. Use the worker ID stored in `.nado/worker-identity.json`, or generate a new invite/bundle for this worker.');
    }
  }
  if (error.code === 'NADO_WORKER_CLOCK_SKEW') {
    hints.push('hint=Synchronize the VM with chrony/systemd-timesyncd and the home host with NTP or Windows Time, then rerun `nado worker preflight`.');
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    hints.push('hint=Control URL is not reachable from this process. Check `--control`, DNS, firewall/VPN, IPv6 brackets, and NADO_PUBLIC_CONTROL_URL before retrying.');
  }
  return hints;
}

main().catch((error) => {
  console.error(error.message);
  for (const hint of cliErrorHints(error)) {
    console.error(hint);
  }
  process.exitCode = 1;
});
