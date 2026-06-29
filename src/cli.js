#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startControlServer } from './control-server.js';
import { NadoClient } from './http-client.js';
import { startWorker } from './worker-client.js';
import { formatBatchReport } from './batch-report.js';
import { buildAgentContext, installAgentContext, writeAgentContext } from './context.js';
import { runDoctor } from './doctor.js';
import { collectLocalInputFiles } from './input-files.js';
import { buildWorkerInvite } from './invite.js';
import { buildWorkerBootstrapBundle, buildWorkerBundle } from './worker-bundle.js';
import { ensureEnrolledWorker } from './worker-enrollment.js';
import { buildMcpClientConfig, formatMcpCommand } from './mcp-config.js';
import { listAgentPresets, resolveAgentCommand } from './agent-presets.js';
import { buildBatchPlan } from './batch-plan.js';
import { runVerify } from './verify.js';
import { buildDemoRouteChecks, demoRouteChecksOk } from './demo-health.js';
import { routingActionHint } from './routing-diagnostics.js';
import { controlUrlFromHostPort, parseCsvValues, requireValue, safeName, sleep } from './utils.js';
import { workerReadinessDiagnostics, workerResourceDiagnostics } from './worker-diagnostics.js';

function usage() {
  return `Nado Agent

Usage:
  nado quickstart [--host 127.0.0.1] [--port 8765] [--public-control-url URL] [--trust-proxy] [--data-dir .nado/quickstart] [--store json|sqlite] [--token TOKEN] [--worker local-worker] [--capability code] [--agent codex|claude|node-copy] [--agent-command CMD] [--mcp-name nado] [--no-dashboard-auto-token] [--once]
  nado control start [--host 127.0.0.1] [--port 8765] [--public-control-url URL] [--trust-proxy] [--data-dir .nado] [--store json|sqlite] [--token TOKEN] [--dashboard-auto-token]
  nado worker start --control URL --id ID [--capability code] [--agent codex|claude|node-copy] [--agent-command CMD] [--max-concurrency 1] [--cleanup-workspaces]
  nado worker bootstrap-start --control URL --enrollment-token TOKEN [--id optional-id] [--capability code] [--agent codex|claude|node-copy] [--max-concurrency 1] [--cleanup-workspaces]
  nado worker preflight --control URL --id ID [--data-dir .nado]
  nado worker logs --control URL --id ID [--tail 50] [--watch]
  nado worker invite --control URL --id ID [--bundle-control-url URL] [--public-control-url URL] [--capability code] [--agent codex|claude|node-copy] [--issue-token] [--format bash|powershell] [--cleanup-workspaces]
  nado worker bundle --control URL --id ID [--bundle-control-url URL] [--public-control-url URL] [--capability code] [--agent codex|claude|node-copy] [--issue-token] [--out ./nado-worker.zip] [--cleanup-workspaces]
  nado worker bootstrap-bundle --control URL [--bundle-control-url URL] [--public-control-url URL] [--out ./nado-worker-bootstrap.zip] [--capability code] [--agent codex|claude|node-copy] [--max-uses N] [--cleanup-workspaces]
  nado agents
  nado worker token create --control URL --id ID [--label LABEL] [--expires-at ISO]
  nado worker tokens --control URL [--worker ID]
  nado worker token revoke TOKEN_ID --control URL
  nado worker enrollments --control URL
  nado worker enrollments prune [--dry-run] [--json] --control URL
  nado worker enrollment revoke TOKEN_ID --control URL
  nado worker manage --control URL --id ID --action pause|resume|drain|shutdown|cancel_current|forget
  nado status --control URL
  nado network --control URL [--json]
  nado demo health --control URL [--timeout 60000] [--skip-verify] [--no-prune] [--json]
  nado demo reset --control URL [--keep 0] [--dry-run] [--yes] [--no-system] [--keep-empty-sessions] [--json]
  nado capabilities --control URL
  nado verify --control URL [--worker ID] [--all-workers] [--capability code] [--tool node] [--required-label zone=lab] [--timeout 30000] [--skip-doctor] [--json]
  nado doctor --control URL [--self-test] [--agent-self-test] [--all-workers] [--worker ID] [--capability code] [--tool node] [--required-label zone=lab] [--timeout 15000]
  nado workers --control URL
  nado session create --control URL --title TITLE [--worker ID] [--capability code] [--tool codex] [--required-label zone=lab]
  nado sessions --control URL
  nado session SESSION_ID --control URL
  nado session close SESSION_ID --control URL
  nado session download SESSION_ID --out ./downloads --control URL
  nado submit --control URL (--command CMD | --prompt PROMPT) [--worker ID] [--capability gpu] [--tool codex] [--required-label zone=lab] [--env KEY=value] [--sandbox|--sandbox-profile isolated] [--artifact dist/**] [--exclude-artifact tmp/**] [--dependency-artifacts] [--slots 2] [--priority 10] [--session SESSION_ID] [--file ./input.md] [--dir ./project] [--cleanup-workspace] [--keep-workspace] [--require-routable] [--wait] [--watch] [--download --out ./downloads] [--wait-timeout 60000] [--type shell|agent]
  nado batch plan --title TITLE (--task "key: task" | --tasks-file ./tasks.txt) [--type agent|shell] [--command-template CMD] [--worker ID] [--capability code] [--tool node] [--required-label zone=lab] [--out ./batch.json]
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
  NADO_TRUST_PROXY         trust X-Forwarded-Host and X-Forwarded-Proto when control is behind a reverse proxy
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

function printSchedulerSummary(scheduler) {
  if (!scheduler) {
    return;
  }
  console.log(`schedulerWorker=${scheduler.workerId || '-'}`);
  console.log(`schedulerReason=${scheduler.reason || '-'}`);
  console.log(`schedulerInferredCapabilities=${scheduler.inferredCapabilities?.join(',') || '-'}`);
  console.log(`schedulerEffectiveCapabilities=${scheduler.effectiveRequiredCapabilities?.join(',') || '-'}`);
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
  const token = tokenFrom(args, { allowGenerate: true });
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 8765);
  const publicControlUrl = args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';

  const running = await startControlServer({
    host,
    port,
    token,
    dataDir,
    storeBackend: args.store || process.env.NADO_STORE,
    dashboardAutoToken: Boolean(args['dashboard-auto-token']),
    publicControlUrl,
    trustProxy: Boolean(args['trust-proxy'] || args.trustProxy),
  });
  console.log(`Nado control server listening on ${controlUrlFromHostPort(host, running.port)}`);
  if (publicControlUrl) {
    console.log(`Public control URL: ${publicControlUrl}`);
  }
  console.log(`NADO_TOKEN=${token}`);
  console.log(`Data dir: ${dataDir}`);
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
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

async function commandQuickstart(args) {
  const token = tokenFrom(args, { allowGenerate: true });
  const root = path.resolve(args['data-dir'] || path.join('.nado', 'quickstart'));
  const host = args.host || '127.0.0.1';
  const port = Number(args.port || 8765);
  const publicControlUrl = args['public-control-url'] || args.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '';
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
    dashboardAutoToken: args['no-dashboard-auto-token'] ? false : true,
    publicControlUrl,
    trustProxy: Boolean(args['trust-proxy'] || args.trustProxy),
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
    console.log(`token=${token}`);
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
    console.log(`submitExample=NADO_TOKEN=${token} node ./src/cli.js submit --control ${advertisedControlUrl} --worker ${workerId} --command "node -e \\"console.log('hello from '+process.env.NADO_WORKER_ID)\\"" --wait`);
    console.log(`installContextExample=NADO_TOKEN=${token} node ./src/cli.js context install --control ${advertisedControlUrl} --out ./AGENTS.md`);
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
    onLog: (line) => console.log(`[worker:${id}] ${line}`),
  });

  process.on('SIGINT', () => worker.stop());
  process.on('SIGTERM', () => worker.stop());
  await worker.done;
}

async function commandWorkerBootstrapStart(args) {
  const controlUrl = controlUrlFrom(args);
  const dataDir = path.resolve(args['data-dir'] || '.nado');
  const agentOptions = agentOptionsFromArgs(args);
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

  const worker = await startWorker({
    id: identity.workerId,
    name: args.name || identity.workerId,
    controlUrl,
    token: identity.workerToken,
    privateKeyPem: identity.privateKeyPem,
    dataDir,
    capabilities: valueList(args.capability || args.capabilities),
    labels: parseLabels(args.label),
    agentCommand: agentOptions.agentCommand,
    agentPreset: agentOptions.agentPreset,
    maxConcurrency: Number(args['max-concurrency'] || args.concurrency || 1),
    cleanupWorkspaces: Boolean(args['cleanup-workspaces']),
    pollMs: Number(args['poll-ms'] || 2_000),
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

  const health = await client.health();
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
  const { workers } = await client.listWorkers();
  printTable(workers, [
    { header: 'id', value: (worker) => worker.id },
    { header: 'gateway', value: (worker) => worker.gatewayState },
    { header: 'admin', value: (worker) => worker.adminState },
    { header: 'observed', value: (worker) => worker.observedState },
    { header: 'currentTask', value: (worker) => worker.currentTaskId || '-' },
    { header: 'slots', value: (worker) => `${worker.runningSlots ?? worker.runningTasks ?? 0}/${worker.maxConcurrency || 1}` },
    { header: 'capabilities', value: (worker) => worker.capabilities.join(',') || '-' },
    { header: 'labels', value: (worker) => formatLabels(worker.labels) },
    { header: 'tools', value: (worker) => Object.entries(worker.inventory?.tools || {}).filter(([, tool]) => tool.available).map(([name]) => name).join(',') || '-' },
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
}

async function commandStatus(args) {
  const client = makeClient(args);
  const snapshot = await client.status();
  const workers = snapshot.workers.items;
  const taskCounts = snapshot.tasks.counts;
  const batchCounts = snapshot.batches.counts;
  const attention = snapshot.tasks.attention || { total: 0, items: [] };
  console.log(`workers=${snapshot.workers.total} active=${snapshot.workers.active}`);
  console.log(`sessions=${snapshot.sessions.total} open=${snapshot.sessions.open}`);
  console.log(`tasks=${snapshot.tasks.total} queued=${taskCounts.queued || 0} running=${taskCounts.running || 0} succeeded=${taskCounts.succeeded || 0} failed=${taskCounts.failed || 0} cancelled=${taskCounts.cancelled || 0} attention=${attention.total || 0}`);
  console.log(`batches=${snapshot.batches.total} queued=${batchCounts.queued || 0} running=${batchCounts.running || 0} succeeded=${batchCounts.succeeded || 0} completed_with_errors=${batchCounts.completed_with_errors || 0}`);
  if (attention.total) {
    console.log('attention:');
    for (const task of attention.items || []) {
      console.log(`- ${task.id} reason=${task.schedulerReason || '-'} worker=${task.requestedWorkerId || '-'} nextAction=${task.nextAction?.code || '-'} title=${task.title}`);
    }
  }
  printTable(workers, [
    { header: 'id', value: (worker) => worker.id },
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
  const { task } = await client.createTask({
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
    slots: parseSlots(args.slots || args['task-slots']),
    env: parseEnv(args.env),
    sandboxProfile: sandboxProfileFromArgs(args),
    artifactPolicy: artifactPolicyFromArgs(args),
    dependencyArtifacts: dependencyArtifactsFromArgs(args),
    requireRoutable: Boolean(args['require-routable'] || args.requireRoutable),
    inputFiles: await buildInputFiles({ files: args.file, dirs: args.dir }),
    keepWorkspace: args['cleanup-workspace'] ? false : args['keep-workspace'] ? true : undefined,
    timeoutMs: args.timeout ? Number(args.timeout) : undefined,
  });
  console.log(`submitted ${task.id}`);
  console.log(`status=${task.status}`);
  console.log(`requestedWorker=${task.requestedWorkerId || '-'}`);
  console.log(`session=${task.sessionId || '-'}`);
  console.log(`priority=${task.priority || 0}`);
  console.log(`slots=${task.slots || 1}`);
  console.log(`inputFiles=${task.inputFiles?.map((file) => file.path).join(',') || '-'}`);
  console.log(`keepWorkspace=${task.keepWorkspace === undefined ? 'worker-default' : task.keepWorkspace}`);
  console.log(`env=${Object.keys(task.env || {}).join(',') || '-'}`);
  console.log(`sandboxProfile=${task.sandboxProfile || 'default'}`);
  console.log(`artifactPolicy=${formatArtifactPolicy(task.artifactPolicy)}`);
  console.log(`dependencyArtifacts=${task.dependencyArtifacts?.enabled ? task.dependencyArtifacts.prefix : 'disabled'}`);
  console.log(`requiredCapabilities=${task.requiredCapabilities.join(',') || '-'}`);
  console.log(`requiredTools=${task.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(task.requiredLabels)}`);
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
  if (args['require-routable'] || args.requireRoutable) {
    materialized.requireRoutable = true;
  }
  const client = makeClient(args);
  const { batch, tasks } = await client.createBatch(materialized);
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
    labels: parseLabels(args.label),
  });
  console.log(`created ${session.id}`);
  console.log(`title=${session.title}`);
  console.log(`requestedWorker=${session.requestedWorkerId || '-'}`);
  console.log(`requiredCapabilities=${session.requiredCapabilities.join(',') || '-'}`);
  console.log(`requiredTools=${session.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(session.requiredLabels)}`);
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
  const actionHint = routingActionHint(task);
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
      { header: 'offlineMs', value: (item) => item.offlineMs ?? '-' },
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
  console.log(`skipped=${result.skipped.length}`);
  for (const task of result.recovered) {
    console.log(`- recovered ${task.id} requestedWorker=${task.requestedWorkerId || '-'} status=${task.status}`);
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
  const { task } = await client.manageTask(taskId, action, options);
  console.log(`task=${task.id}`);
  console.log(`status=${task.status}`);
  console.log(`requestedWorker=${task.requestedWorkerId || '-'}`);
  console.log(`slots=${task.slots || 1}`);
  console.log(`requiredTools=${task.requiredTools?.join(',') || '-'}`);
  console.log(`requiredLabels=${formatLabels(task.requiredLabels)}`);
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
  if (command === 'worker' && subcommand === 'start') {
    await commandWorkerStart(args);
    return;
  }
  if (command === 'worker' && subcommand === 'bootstrap-start') {
    await commandWorkerBootstrapStart(args);
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
    if (status === 401 && /Signed worker request headers are required|signature/i.test(responseError || message)) {
      hints.push('hint=Worker preflight needs the signed identity created during self-service enrollment. Keep the generated `.nado/worker-identity.json`, or download a fresh self-service bundle if the identity was deleted or copied from another host.');
    }
    if (status === 403 && /not valid for worker/i.test(responseError || message)) {
      hints.push('hint=Worker token and worker ID do not match. Use the worker ID stored in `.nado/worker-identity.json`, or generate a new invite/bundle for this worker.');
    }
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
