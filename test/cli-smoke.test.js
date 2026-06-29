import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { NadoClient } from '../src/http-client.js';
import { startControlServer } from '../src/control-server.js';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-cli-'));
}

function waitForStdout(child, regex, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${regex}. stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    }

    function onStdout(chunk) {
      stdout += chunk.toString('utf8');
      const match = stdout.match(regex);
      if (match) {
        cleanup();
        resolve(match);
      }
    }

    function onStderr(chunk) {
      stderr += chunk.toString('utf8');
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Process exited with ${code}. stdout=${stdout} stderr=${stderr}`));
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
  });
}

async function runCli(args, env, timeout = 8_000) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, ...env },
    timeout,
  });
  return stdout;
}

async function waitForCliTask(taskId, controlUrl, token, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const stdout = await runCli(['task', taskId, '--control', controlUrl], { NADO_TOKEN: token });
    const task = JSON.parse(stdout);
    if (task.status === 'succeeded' || task.status === 'failed') {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Timed out waiting for CLI task ${taskId}`);
}

test('CLI prints a reusable worker invite command', async () => {
  const stdout = await runCli([
    'worker',
    'invite',
    '--control',
    'http://10.0.0.5:8765',
    '--id',
    'gpu-worker',
    '--capability',
    'gpu',
    '--capability',
    'code',
    '--label',
    'zone=lab',
    '--agent',
    'codex',
    '--agent-command',
    'codex exec --ask-for-approval never {promptFile}',
    '--max-concurrency',
    '2',
    '--poll-ms',
    '500',
    '--cleanup-workspaces',
  ], { NADO_TOKEN: 'invite-token' });

  assert.match(stdout, /export NADO_TOKEN='invite-token'/);
  assert.match(stdout, /export NADO_CONTROL='http:\/\/10\.0\.0\.5:8765'/);
  assert.match(stdout, /node \.\/src\/cli\.js worker preflight --control "\$NADO_CONTROL" --id 'gpu-worker'/);
  assert.match(stdout, /node \.\/src\/cli\.js worker start/);
  assert.match(stdout, /--id 'gpu-worker'/);
  assert.match(stdout, /--capability 'gpu'/);
  assert.match(stdout, /--capability 'code'/);
  assert.match(stdout, /--label 'zone=lab'/);
  assert.match(stdout, /--agent 'codex'/);
  assert.match(stdout, /--agent-command 'codex exec --ask-for-approval never \{promptFile\}'/);
  assert.match(stdout, /--max-concurrency '2'/);
  assert.match(stdout, /--poll-ms '500'/);
  assert.match(stdout, /--cleanup-workspaces/);
});

test('CLI builds a portable worker bundle from the real worker runtime', async () => {
  const root = await makeTempDir();
  try {
    const out = path.join(root, 'gpu-worker-bundle.zip');
    const stdout = await runCli([
      'worker',
      'bundle',
      '--control',
      'http://10.0.0.5:8765',
      '--id',
      'gpu-worker',
      '--capability',
      'gpu',
      '--label',
      'zone=lab',
      '--agent',
      'node-copy',
      '--max-concurrency',
      '2',
      '--poll-ms',
      '500',
      '--cleanup-workspaces',
      '--out',
      out,
    ], { NADO_TOKEN: 'bundle-token' });

    assert.match(stdout, /bundle=.*gpu-worker-bundle\.zip/);
    assert.match(stdout, /worker=gpu-worker/);
    assert.match(stdout, /start=bash \.\/start-worker\.sh/);
    const zip = await fs.readFile(out);
    assert.ok(zip.includes(Buffer.from('nado-worker-gpu-worker/start-worker.sh')));
    assert.ok(zip.includes(Buffer.from('nado-worker-gpu-worker/start-worker.ps1')));
    assert.ok(zip.includes(Buffer.from('nado-worker-gpu-worker/src/cli.js')));
    assert.ok(zip.includes(Buffer.from('nado-worker-gpu-worker/package.json')));
    assert.ok(zip.includes(Buffer.from("export NADO_TOKEN='bundle-token'")));
    assert.ok(zip.includes(Buffer.from('worker preflight --control "$NADO_CONTROL" --id')));
    assert.ok(zip.includes(Buffer.from("--capability 'gpu'")));
    assert.ok(zip.includes(Buffer.from("--label 'zone=lab'")));
    assert.ok(zip.includes(Buffer.from("--max-concurrency '2'")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI builds a self-service worker bootstrap bundle', async () => {
  const root = await makeTempDir();
  try {
    const out = path.join(root, 'worker-bootstrap.zip');
    const stdout = await runCli([
      'worker',
      'bootstrap-bundle',
      '--control',
      'http://10.0.0.5:8765',
      '--enrollment-token',
      'nado_enroll_testtoken',
      '--capability',
      'code',
      '--label',
      'zone=auto',
      '--agent',
      'node-copy',
      '--max-concurrency',
      '2',
      '--poll-ms',
      '500',
      '--cleanup-workspaces',
      '--out',
      out,
    ], {});

    assert.match(stdout, /bundle=.*worker-bootstrap\.zip/);
    assert.match(stdout, /root=nado-worker-bootstrap/);
    const zip = await fs.readFile(out);
    assert.ok(zip.includes(Buffer.from('nado-worker-bootstrap/start-worker.sh')));
    assert.ok(zip.includes(Buffer.from('nado-worker-bootstrap/start-worker.ps1')));
    assert.ok(zip.includes(Buffer.from('nado-worker-bootstrap/src/cli.js')));
    assert.ok(zip.includes(Buffer.from('worker bootstrap-start')));
    assert.ok(zip.includes(Buffer.from("--enrollment-token 'nado_enroll_testtoken'")));
    assert.ok(zip.includes(Buffer.from("--capability 'code'")));
    assert.ok(zip.includes(Buffer.from("--label 'zone=auto'")));
    assert.ok(zip.includes(Buffer.from("--max-concurrency '2'")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI prints reusable MCP client config', async () => {
  const jsonOut = await runCli([
    'mcp',
    'config',
    '--control',
    'http://127.0.0.1:8765',
    '--name',
    'nado-test',
  ], { NADO_TOKEN: 'mcp-config-token' });
  const config = JSON.parse(jsonOut);
  assert.equal(config.mcpServers['nado-test'].command, process.execPath);
  assert.ok(config.mcpServers['nado-test'].args.some((item) => item.endsWith('cli.js')));
  assert.deepEqual(config.mcpServers['nado-test'].args.slice(-3), ['mcp', '--control', 'http://127.0.0.1:8765']);
  assert.equal(config.mcpServers['nado-test'].env.NADO_TOKEN, 'mcp-config-token');

  const commandOut = await runCli([
    'mcp',
    'config',
    '--control',
    'http://127.0.0.1:8765',
    '--format',
    'command',
  ], { NADO_TOKEN: 'mcp-config-token' });
  assert.match(commandOut, /NADO_TOKEN/);
  assert.match(commandOut, /mcp/);
  assert.match(commandOut, /--control/);
  assert.match(commandOut, /http:\/\/127\.0\.0\.1:8765/);
});

test('CLI prints network diagnostics for remote worker onboarding', async () => {
  const root = await makeTempDir();
  const token = 'network-cli-token';
  const publicControlUrl = 'http://[2001:db8::10]:8765';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    publicControlUrl,
  });
  const controlUrl = `http://127.0.0.1:${port}`;

  try {
    const stdout = await runCli([
      'network',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    assert.match(stdout, new RegExp(`networkRequest=http://127\\.0\\.0\\.1:${port}`));
    assert.match(stdout, /remoteWorkerReady=true/);
    assert.match(stdout, /preferredControl=http:\/\/\[2001:db8::10\]:8765/);
    assert.match(stdout, /publicControl=http:\/\/\[2001:db8::10\]:8765/);
    assert.match(stdout, /nextAction=generate_worker_bundle/);
    assert.match(stdout, /candidates:/);
    assert.match(stdout, /NADO_PUBLIC_CONTROL_URL/);

    const jsonOut = await runCli([
      'network',
      '--control',
      controlUrl,
      '--json',
    ], { NADO_TOKEN: token });
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.requestUrl, controlUrl);
    assert.equal(parsed.preferredRemoteControlUrl, publicControlUrl);
    assert.equal(parsed.nextAction.code, 'generate_worker_bundle');
    assert.equal(parsed.candidates[0].source, 'NADO_PUBLIC_CONTROL_URL');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI worker bundles prefer advertised public control URLs over loopback API URLs', async () => {
  const root = await makeTempDir();
  const token = 'bundle-public-url-token';
  const publicControlUrl = 'http://[2001:db8::20]:8765';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
    publicControlUrl,
  });
  const apiControlUrl = `http://127.0.0.1:${port}`;

  try {
    const inviteStdout = await runCli([
      'worker',
      'invite',
      '--control',
      apiControlUrl,
      '--id',
      'public-invite-worker',
      '--capability',
      'code',
    ], { NADO_TOKEN: token });
    assert.match(inviteStdout, /export NADO_CONTROL='http:\/\/\[2001:db8::20\]:8765'/);
    assert.doesNotMatch(inviteStdout, new RegExp(`export NADO_CONTROL='${apiControlUrl}'`));
    assert.match(inviteStdout, /Control URL source: generate_worker_bundle/);

    const bootstrapOut = path.join(root, 'public-bootstrap.zip');
    const bootstrapStdout = await runCli([
      'worker',
      'bootstrap-bundle',
      '--control',
      apiControlUrl,
      '--capability',
      'code',
      '--out',
      bootstrapOut,
    ], { NADO_TOKEN: token });
    assert.match(bootstrapStdout, /control=http:\/\/\[2001:db8::20\]:8765/);
    assert.match(bootstrapStdout, /controlSource=generate_worker_bundle/);
    const bootstrapZip = await fs.readFile(bootstrapOut);
    assert.ok(bootstrapZip.includes(Buffer.from(`--control '${publicControlUrl}'`)));
    assert.equal(bootstrapZip.includes(Buffer.from(`--control '${apiControlUrl}'`)), false);

    const fixedOut = path.join(root, 'public-fixed.zip');
    const fixedStdout = await runCli([
      'worker',
      'bundle',
      '--control',
      apiControlUrl,
      '--id',
      'public-fixed-worker',
      '--worker-token',
      'nado_wt_testtoken',
      '--bundle-control-url',
      'http://[2001:db8::30]:8765',
      '--out',
      fixedOut,
    ], {});
    assert.match(fixedStdout, /control=http:\/\/\[2001:db8::30\]:8765/);
    assert.match(fixedStdout, /controlSource=bundle-control-url/);
    const fixedZip = await fs.readFile(fixedOut);
    assert.ok(fixedZip.includes(Buffer.from("export NADO_CONTROL='http://[2001:db8::30]:8765'")));
    assert.equal(fixedZip.includes(Buffer.from(`export NADO_CONTROL='${apiControlUrl}'`)), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI lists reusable worker agent presets', async () => {
  const stdout = await runCli(['agents'], {});
  assert.match(stdout, /codex/);
  assert.match(stdout, /claude/);
  assert.match(stdout, /node-copy/);
  assert.match(stdout, /\{promptFile\}/);
});

test('CLI demo reset previews and clears completed standalone demo history', async () => {
  const root = await makeTempDir();
  const token = 'cli-demo-reset-token';
  const { server, port, store } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });

  try {
    const oldStandalone = await store.createTask({
      title: 'old demo standalone',
      command: 'echo old',
      status: 'succeeded',
    });
    oldStandalone.completedAt = '2026-01-01T00:00:00.000Z';
    oldStandalone.updatedAt = oldStandalone.completedAt;
    const middleStandalone = await store.createTask({
      title: 'middle demo standalone',
      command: 'echo middle',
      status: 'failed',
    });
    middleStandalone.completedAt = '2026-01-02T00:00:00.000Z';
    middleStandalone.updatedAt = middleStandalone.completedAt;
    const newestStandalone = await store.createTask({
      title: 'newest demo standalone',
      command: 'echo newest',
      status: 'succeeded',
    });
    newestStandalone.completedAt = '2026-01-03T00:00:00.000Z';
    newestStandalone.updatedAt = newestStandalone.completedAt;
    const batchTask = await store.createTask({
      title: 'batch task kept by demo reset',
      command: 'echo batch',
      status: 'succeeded',
      batchId: 'batch_cli_demo_reset',
    });
    const session = await store.createSession({ title: 'cli demo reset session' });
    const emptySession = await store.createSession({ title: 'empty demo session' });
    await store.closeSession(emptySession.id);
    const sessionTask = await store.createTask({
      title: 'session task kept by demo reset',
      command: 'echo session',
      status: 'succeeded',
      sessionId: session.id,
    });
    await store.save();

    const previewOut = await runCli([
      'demo',
      'reset',
      '--dry-run',
      '--json',
      '--no-system',
      '--keep',
      '1',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    const preview = JSON.parse(previewOut);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.keep, 1);
    assert.equal(preview.standaloneTerminalTasks, 3);
    assert.equal(preview.prunableTasks, 2);
    assert.equal(preview.emptySessions, 1);
    assert.deepEqual(preview.sessions.map((item) => item.id), [emptySession.id]);
    assert.deepEqual(preview.tasks.map((task) => task.id), [middleStandalone.id, oldStandalone.id]);

    const resetOut = await runCli([
      'demo',
      'reset',
      '--yes',
      '--json',
      '--no-system',
      '--keep',
      '1',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    const reset = JSON.parse(resetOut);
    assert.equal(reset.dryRun, false);
    assert.equal(reset.keep, 1);
    assert.equal(reset.prunedTasks, 2);
    assert.equal(reset.prunedEmptySessions, 1);
    assert.equal(reset.closedEmptySessions, 0);

    const { tasks } = await client.listTasks();
    const { sessions } = await client.listSessions();
    assert.ok(tasks.some((task) => task.id === newestStandalone.id));
    assert.ok(tasks.some((task) => task.id === batchTask.id));
    assert.ok(tasks.some((task) => task.id === sessionTask.id));
    assert.equal(tasks.some((task) => task.id === oldStandalone.id), false);
    assert.equal(tasks.some((task) => task.id === middleStandalone.id), false);
    assert.equal(sessions.some((item) => item.id === emptySession.id), false);
    assert.equal(sessions.find((item) => item.id === session.id).status, 'open');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI wait timeout includes scheduler diagnostics for unroutable queued tasks', async () => {
  const root = await makeTempDir();
  const token = 'cli-wait-diagnostic-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;

  try {
    let stderr = '';
    let stdout = '';
    await assert.rejects(async () => {
      try {
        await runCli([
          'submit',
          '--control',
          controlUrl,
          '--capability',
          'gpu',
          '--title',
          'queued gpu task with no workers',
          '--wait',
          '--wait-timeout',
          '500',
          '--command',
          'echo gpu',
        ], { NADO_TOKEN: token }, 4_000);
      } catch (error) {
        stdout = error.stdout || '';
        stderr = error.stderr || '';
        throw error;
      }
    });
    assert.match(stdout, /submitted task_[a-f0-9]+/);
    assert.match(stdout, /schedulerReason=no eligible worker/);
    assert.match(stderr, /Timed out waiting for task_[a-f0-9]+; last status=queued/);
    assert.match(stderr, /schedulerReason=no eligible worker/);
    assert.match(stderr, /schedulerEffectiveCapabilities=gpu/);
    assert.match(stderr, /nextAction=add_worker_or_relax_constraints/);
    assert.match(stderr, /nextActionMessage=Add or resume a worker/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI quickstart boots a usable local gateway and writes agent files', async () => {
  const root = await makeTempDir();
  try {
    const stdout = await runCli([
      'quickstart',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      root,
      '--token',
      'quickstart-token',
      '--worker',
      'quick-worker',
      '--poll-ms',
      '50',
      '--once',
    ], {}, 20_000);

    assert.match(stdout, /quickstart=ready/);
    assert.match(stdout, /control=http:\/\/127\.0\.0\.1:\d+/);
    assert.match(stdout, /dashboard=http:\/\/127\.0\.0\.1:\d+\/dashboard/);
    assert.match(stdout, /worker=quick-worker/);
    assert.match(stdout, /selfTest=succeeded/);
    assert.match(stdout, /selfTestArtifacts=doctor\.txt/);
    assert.match(stdout, /doctor=ok/);
    assert.match(stdout, /submitExample=.*submit --control/);
    assert.match(stdout, /installContextExample=.*context install --control/);

    const context = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    assert.match(context, /quick-worker/);
    assert.match(context, /dashboard/);
    assert.match(context, /## MCP Tools/);
    assert.match(context, /`nado_capabilities`/);
    assert.match(context, /`nado_demo_health`/);

    const config = JSON.parse(await fs.readFile(path.join(root, 'mcp.json'), 'utf8'));
    assert.equal(config.mcpServers.nado.env.NADO_TOKEN, 'quickstart-token');
    assert.ok(config.mcpServers.nado.args.includes('mcp'));
    assert.ok(config.mcpServers.nado.args.some((item) => /^http:\/\/127\.0\.0\.1:\d+$/.test(item)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI starts control and worker processes and completes a submitted task', async () => {
  const root = await makeTempDir();
  const token = 'cli-token';
  const publicControlUrl = 'http://public-control.example:8765';
  const processes = [];

  try {
    const control = spawn(process.execPath, [
      cliPath,
      'control',
      'start',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      path.join(root, 'control'),
      '--token',
      token,
      '--public-control-url',
      publicControlUrl,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    processes.push(control);
    const controlMatch = await waitForStdout(control, /listening on (http:\/\/127\.0\.0\.1:(\d+))/);
    const controlUrl = controlMatch[1];

    const worker = spawn(process.execPath, [
      cliPath,
      'worker',
      'start',
      '--control',
      controlUrl,
      '--id',
      'cli-worker',
      '--capability',
      'code',
      '--capability',
      'gpu',
      '--agent',
      'node-copy',
      '--label',
      'zone=cli',
      '--poll-ms',
      '50',
      '--data-dir',
      root,
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processes.push(worker);
    await waitForStdout(worker, /registered cli-worker/);

    const workersOut = await runCli(['workers', '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(workersOut, /cli-worker/);
    assert.match(workersOut, /code/);
    assert.match(workersOut, /gpu/);
    assert.match(workersOut, /zone=cli/);
    assert.match(workersOut, /node-copy/);

    const statusOut = await runCli(['status', '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(statusOut, /workers=1 active=1/);
    assert.match(statusOut, /sessions=0 open=0/);
    assert.match(statusOut, /tasks=0/);
    assert.match(statusOut, /attention=0/);
    assert.match(statusOut, /batches=0/);

    const demoHealthOut = await runCli([
      'demo',
      'health',
      '--control',
      controlUrl,
      '--skip-verify',
      '--no-prune',
    ], { NADO_TOKEN: token });
    assert.match(demoHealthOut, /demoHealth=ok/);
    assert.match(demoHealthOut, new RegExp(`dashboard=${controlUrl.replaceAll('/', '\\/')}/dashboard`));
    assert.match(demoHealthOut, /workers=1 active=1/);
    assert.match(demoHealthOut, /worker=cli-worker .*caps=.*gpu/);
    assert.match(demoHealthOut, /routeCheck=gpu status=assigned worker=cli-worker inferred=gpu/);
    assert.match(demoHealthOut, /routeCheck=ppt status=skipped/);
    assert.match(demoHealthOut, /routeCheck=docs status=skipped/);
    assert.match(demoHealthOut, /verify=skipped/);

    const capabilitiesOut = await runCli(['capabilities', '--control', controlUrl], { NADO_TOKEN: token });
    const capabilities = JSON.parse(capabilitiesOut);
    assert.equal(capabilities.name, 'nado-agent');
    assert.equal(capabilities.controlUrl, publicControlUrl);
    assert.equal(capabilities.surfaces.dashboard, `${publicControlUrl}/dashboard`);
    assert.ok(capabilities.mcp.tools.includes('nado_capabilities'));
    assert.ok(capabilities.mcp.tools.includes('nado_demo_health'));
    assert.equal(capabilities.features.workerDiscovery, true);
    assert.equal(capabilities.features.workerPreflight, true);
    assert.equal(capabilities.features.workerEvents, true);
    assert.equal(capabilities.features.workerBundles, true);
    assert.equal(capabilities.features.groupedArtifactZipDownload, true);
    assert.equal(capabilities.features.readinessVerification, true);
    assert.equal(capabilities.features.dispatchPlanning, true);
    assert.equal(capabilities.features.requireRoutableSubmit, true);
    assert.equal(capabilities.features.cliSubmitFlow, true);
    assert.equal(capabilities.features.cliBatchSubmitFlow, true);
    assert.equal(capabilities.features.mcpRunTaskFlow, true);
    assert.equal(capabilities.features.mcpRunBatchFlow, true);
    assert.equal(capabilities.features.systemHistoryPruning, true);
    assert.equal(capabilities.features.workerEnrollmentTokenPruning, true);
    assert.equal(capabilities.workers[0].id, 'cli-worker');
    assert.equal(capabilities.endpoints.workers.preflight, 'GET /api/workers/{workerId}/preflight');
    assert.equal(capabilities.endpoints.workers.events, 'GET|POST /api/workers/{workerId}/events');
    assert.equal(capabilities.endpoints.workers.enrollmentTokenPrune, 'POST /api/worker-enrollment-tokens/prune');
    assert.match(capabilities.endpoints.batches.artifactsZip, /download/);
    assert.match(capabilities.endpoints.tasks.artifactsJson, /artifacts\/content/);
    assert.match(capabilities.endpoints.tasks.artifactsZip, /artifacts\/download/);
    assert.equal(capabilities.endpoints.tasks.systemPrune, 'POST /api/system-history/prune');
    assert.equal(capabilities.endpoints.dispatch.plan, 'POST /api/dispatch/plan');

    const doctorOut = await runCli([
      'doctor',
      '--control',
      controlUrl,
      '--self-test',
      '--all-workers',
      '--worker',
      'cli-worker',
      '--timeout',
      '8000',
    ], { NADO_TOKEN: token });
    assert.match(doctorOut, /doctor=ok/);
    assert.match(doctorOut, /selfTest=succeeded/);
    assert.match(doctorOut, /selfTestArtifacts=doctor\.txt/);

    const agentDoctorOut = await runCli([
      'doctor',
      '--control',
      controlUrl,
      '--agent-self-test',
      '--worker',
      'cli-worker',
      '--timeout',
      '10000',
    ], { NADO_TOKEN: token }, 25_000);
    assert.match(agentDoctorOut, /doctor=ok/);
    assert.match(agentDoctorOut, /agentSelfTest=succeeded/);
    assert.match(agentDoctorOut, /agentSelfTestArtifacts=agent-output\.md/);

    const preflightOut = await runCli([
      'worker',
      'preflight',
      '--control',
      controlUrl,
      '--id',
      'cli-worker',
      '--data-dir',
      path.join(root, 'preflight-worker'),
    ], { NADO_TOKEN: token });
    assert.match(preflightOut, /preflight=ok/);
    assert.match(preflightOut, /worker=cli-worker/);
    assert.match(preflightOut, /health=ok/);
    assert.match(preflightOut, /auth=admin/);

    const verifyOut = await runCli([
      'verify',
      '--control',
      controlUrl,
      '--worker',
      'cli-worker',
      '--timeout',
      '10000',
    ], { NADO_TOKEN: token }, 25_000);
    assert.match(verifyOut, /verify=ok/);
    assert.match(verifyOut, /capabilities=ok/);
    assert.match(verifyOut, /doctor=ok/);
    assert.match(verifyOut, /taskArtifact=ok/);
    assert.match(verifyOut, /taskEvents=ok/);
    assert.match(verifyOut, /batchZip=ok/);

    const httpVerify = await new NadoClient({ controlUrl, token }).verify({
      workerId: 'cli-worker',
      timeoutMs: 10_000,
      skipDoctor: true,
    });
    assert.equal(httpVerify.ok, true);
    assert.equal(httpVerify.summary.workers.active, 1);
    assert.equal(httpVerify.checks.some((check) => check.name === 'taskArtifact' && check.ok), true);
    assert.equal(httpVerify.checks.some((check) => check.name === 'batchZip' && check.ok), true);

    const prunePreviewOut = await runCli([
      'history',
      'prune-system',
      '--dry-run',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    assert.match(prunePreviewOut, /prunableTasks=\d+/);
    assert.match(prunePreviewOut, /prunableBatches=\d+/);

    const pruneOut = await runCli([
      'history',
      'prune-system',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    assert.match(pruneOut, /prunedTasks=\d+/);
    assert.match(pruneOut, /prunedBatches=\d+/);

    const sessionOut = await runCli([
      'session',
      'create',
      '--control',
      controlUrl,
      '--title',
      'cli session',
      '--worker',
      'cli-worker',
    ], { NADO_TOKEN: token });
    const sessionId = sessionOut.match(/created (session_[a-f0-9]+)/)?.[1];
    assert.ok(sessionId);

    const submitFlowDownloadDir = path.join(root, 'submit-flow-download');
    const submitOut = await runCli([
      'submit',
      '--control',
      controlUrl,
      '--worker',
      'cli-worker',
      '--title',
      'cli smoke',
      '--required-label',
      'zone=cli',
      '--tool',
      'node',
      '--slots',
      '1',
      '--priority',
      '7',
      '--keep-workspace',
      '--sandbox',
      '--env',
      'CLI_MARK=env-ok',
      '--artifact',
      'cli.txt',
      '--exclude-artifact',
      'cli-env.txt',
      '--wait',
      '--download',
      '--out',
      submitFlowDownloadDir,
      '--wait-timeout',
      '10000',
      '--command',
      'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'cli.txt\', \'ok\'); fs.writeFileSync(\'cli-env.txt\', process.env.CLI_MARK); console.log(\'cli ok\')"',
    ], { NADO_TOKEN: token }, 20_000);
    assert.match(submitOut, /requiredLabels=zone=cli/);
    assert.match(submitOut, /priority=7/);
    assert.match(submitOut, /slots=1/);
    assert.match(submitOut, /keepWorkspace=true/);
    assert.match(submitOut, /sandboxProfile=isolated/);
    assert.match(submitOut, /env=CLI_MARK/);
    assert.match(submitOut, /artifactPolicy=include:cli\.txt exclude:cli-env\.txt/);
    assert.match(submitOut, /requiredTools=node/);
    assert.match(submitOut, /schedulerWorker=cli-worker/);
    assert.match(submitOut, /schedulerReason=explicit worker requested/);
    assert.match(submitOut, /schedulerCandidate=cli-worker eligible=true/);
    assert.match(submitOut, /waitStatus=succeeded/);
    assert.match(submitOut, /downloaded \d+ artifacts/);
    const taskId = submitOut.match(/submitted (task_[a-f0-9]+)/)?.[1];
    assert.ok(taskId);
    assert.equal(await fs.readFile(path.join(submitFlowDownloadDir, 'cli.txt'), 'utf8'), 'ok');
    await assert.rejects(() => fs.readFile(path.join(submitFlowDownloadDir, 'cli-env.txt'), 'utf8'), { code: 'ENOENT' });

    const waitOut = await runCli(['wait', taskId, '--watch', '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(waitOut, /status=succeeded/);
    assert.match(waitOut, /assignedWorker=cli-worker/);

    const task = await waitForCliTask(taskId, controlUrl, token);
    assert.equal(task.status, 'succeeded');
    assert.equal(task.assignedWorkerId, 'cli-worker');
    assert.match(task.stdout, /cli ok/);
    assert.equal(await fs.readFile(path.join(task.workspace, 'cli.txt'), 'utf8'), 'ok');
    assert.equal(await fs.readFile(path.join(task.workspace, 'cli-env.txt'), 'utf8'), 'env-ok');

    const gpuSubmitOut = await runCli([
      'submit',
      '--control',
      controlUrl,
      '--title',
      'Run CUDA inference for CLI route explanation',
      '--wait',
      '--command',
      'node -e "console.log(process.env.NADO_WORKER_ID)"',
    ], { NADO_TOKEN: token }, 20_000);
    assert.match(gpuSubmitOut, /requestedWorker=cli-worker/);
    assert.match(gpuSubmitOut, /schedulerInferredCapabilities=gpu/);
    assert.match(gpuSubmitOut, /schedulerEffectiveCapabilities=gpu/);
    assert.match(gpuSubmitOut, /schedulerInference=gpu reason=CUDA keyword/);
    assert.match(gpuSubmitOut, /schedulerCandidate=cli-worker eligible=true.*inferred capability: gpu.*gpu match/);
    assert.match(gpuSubmitOut, /waitStatus=succeeded/);

    let failedSubmitOut = '';
    await assert.rejects(async () => {
      try {
        await runCli([
          'submit',
          '--control',
          controlUrl,
          '--worker',
          'cli-worker',
          '--title',
          'cli failed submit wait',
          '--wait',
          '--command',
          'node -e "console.error(\'expected failure\'); process.exit(7)"',
        ], { NADO_TOKEN: token }, 20_000);
      } catch (error) {
        failedSubmitOut = error.stdout || '';
        throw error;
      }
    });
    assert.match(failedSubmitOut, /submitted task_[a-f0-9]+/);
    assert.match(failedSubmitOut, /waitStatus=failed/);
    assert.match(failedSubmitOut, /exitCode=[1-9]\d*/);

    const batchInputFile = path.join(root, 'batch-input.txt');
    const batchInputDir = path.join(root, 'batch-input-dir');
    await fs.writeFile(batchInputFile, 'batch-control-file', 'utf8');
    await fs.mkdir(batchInputDir, { recursive: true });
    await fs.writeFile(path.join(batchInputDir, 'payload.txt'), 'batch-control-dir', 'utf8');
    const batchFile = path.join(root, 'batch.json');
    await fs.writeFile(batchFile, JSON.stringify({
      title: 'cli batch',
      defaults: {
        workerId: 'cli-worker',
        priority: 2,
        tools: ['node'],
        slots: 1,
        keepWorkspace: true,
      },
      tasks: [
        {
          key: 'one',
          title: 'cli batch one',
          type: 'shell',
          file: './batch-input.txt',
          command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'batch-input.txt\',\'utf8\'); fs.writeFileSync(\'batch-one.txt\', value+\':one\'); fs.writeFileSync(\'batch-env.txt\', process.env.NADO_BATCH_KEY+\':\'+(process.env.NADO_BATCH_ID.startsWith(\'batch_\')?\'batch\':\'missing\')); console.log(value)"',
        },
        {
          key: 'two',
          title: 'cli batch two',
          type: 'shell',
          dir: './batch-input-dir',
          command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'payload.txt\',\'utf8\'); fs.writeFileSync(\'batch-two.txt\', value+\':two\'); console.log(value)"',
        },
      ],
    }), 'utf8');
    const dispatchPlanOut = await runCli([
      'dispatch',
      'plan',
      '--control',
      controlUrl,
      '--file',
      batchFile,
    ], { NADO_TOKEN: token });
    assert.match(dispatchPlanOut, /dispatchPlan=cli batch/);
    assert.match(dispatchPlanOut, /tasks=2 assigned=2 unassigned=0/);
    assert.match(dispatchPlanOut, /worker=cli-worker/);

    const batchOut = await runCli([
      'batch',
      'submit',
      '--control',
      controlUrl,
      '--require-routable',
      '--file',
      batchFile,
    ], { NADO_TOKEN: token });
    const batchId = batchOut.match(/batch=(batch_[a-f0-9]+)/)?.[1];
    assert.ok(batchId);
    assert.match(batchOut, /inputFiles=batch-input\.txt/);
    assert.match(batchOut, /inputFiles=payload\.txt/);
    assert.match(batchOut, /requiredTools=node/);
    assert.match(batchOut, /slots=1/);
    assert.match(batchOut, /requestedWorker=cli-worker/);
    assert.match(batchOut, /scheduler worker=cli-worker reason=explicit worker requested/);
    assert.match(batchOut, /candidate cli-worker: eligible=true/);
    const batchWaitOut = await runCli(['batch', 'wait', batchId, '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(batchWaitOut, /status=succeeded/);
    const batchDetail = JSON.parse(await runCli(['batch', batchId, '--control', controlUrl], { NADO_TOKEN: token }));
    assert.equal(batchDetail.batch.totalTasks, 2);
    assert.equal(batchDetail.batch.counts.succeeded, 2);
    const batchEventsOut = await runCli(['batch', 'events', batchId, '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(batchEventsOut, /source/);
    assert.match(batchEventsOut, /one/);
    assert.match(batchEventsOut, /two/);
    assert.match(batchEventsOut, /succeeded/);
    const batchReportOut = await runCli(['batch', 'report', batchId, '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(batchReportOut, /status=succeeded/);
    assert.match(batchReportOut, /batch-one\.txt/);
    assert.match(batchReportOut, /batch-two\.txt/);
    assert.match(batchReportOut, /batch-control-file/);
    const batchDownloadDir = path.join(root, 'batch-download');
    const batchDownloadOut = await runCli([
      'batch',
      'download',
      batchId,
      '--control',
      controlUrl,
      '--out',
      batchDownloadDir,
    ], { NADO_TOKEN: token });
    assert.match(batchDownloadOut, /downloaded \d+ batch artifacts/);
    assert.equal(await fs.readFile(path.join(batchDownloadDir, 'one', 'batch-one.txt'), 'utf8'), 'batch-control-file:one');
    assert.equal(await fs.readFile(path.join(batchDownloadDir, 'one', 'batch-env.txt'), 'utf8'), 'one:batch');
    assert.equal(await fs.readFile(path.join(batchDownloadDir, 'two', 'batch-two.txt'), 'utf8'), 'batch-control-dir:two');

    const oneFlowBatchFile = path.join(root, 'one-flow-batch.json');
    await fs.writeFile(oneFlowBatchFile, JSON.stringify({
      title: 'cli one flow batch',
      defaults: {
        workerId: 'cli-worker',
        tools: ['node'],
      },
      tasks: [
        {
          key: 'flow',
          title: 'cli one flow task',
          type: 'shell',
          command: 'node -e "const fs=require(\'fs\'); fs.writeFileSync(\'flow.txt\', \'one-flow-ok\'); console.log(\'one flow stdout\')"',
        },
      ],
    }), 'utf8');
    const oneFlowDownloadDir = path.join(root, 'one-flow-download');
    const oneFlowOut = await runCli([
      'batch',
      'submit',
      '--control',
      controlUrl,
      '--file',
      oneFlowBatchFile,
      '--require-routable',
      '--wait',
      '--report',
      '--download',
      '--out',
      oneFlowDownloadDir,
    ], { NADO_TOKEN: token }, 20_000);
    assert.match(oneFlowOut, /batch=batch_[a-f0-9]+/);
    assert.match(oneFlowOut, /waitStatus=succeeded/);
    assert.match(oneFlowOut, /completed=1\/1/);
    assert.match(oneFlowOut, /status=succeeded/);
    assert.match(oneFlowOut, /flow\.txt/);
    assert.match(oneFlowOut, /one flow stdout/);
    assert.match(oneFlowOut, /downloaded \d+ batch artifacts/);
    assert.equal(await fs.readFile(path.join(oneFlowDownloadDir, 'flow', 'flow.txt'), 'utf8'), 'one-flow-ok');

    const plannedBatchFile = path.join(root, 'planned-batch.json');
    const planOut = await runCli([
      'batch',
      'plan',
      '--title',
      'planned shell batch',
      '--type',
      'shell',
      '--worker',
      'cli-worker',
      '--tool',
      'node',
      '--sandbox',
      '--command-template',
      'node -e "require(\'fs\').writeFileSync(\'{key}.txt\', \'{title}\')"',
      '--task',
      'alpha: First planned task',
      '--task',
      'beta: Second planned task',
      '--out',
      plannedBatchFile,
    ], { NADO_TOKEN: token });
    assert.match(planOut, /wrote .*planned-batch\.json/);
    const plannedSpec = JSON.parse(await fs.readFile(plannedBatchFile, 'utf8'));
    assert.equal(plannedSpec.defaults.workerId, 'cli-worker');
    assert.equal(plannedSpec.defaults.sandboxProfile, 'isolated');
    assert.equal(plannedSpec.tasks[0].key, 'alpha');
    assert.equal(plannedSpec.tasks[1].command.includes('beta.txt'), true);
    const plannedSubmitOut = await runCli([
      'batch',
      'submit',
      '--control',
      controlUrl,
      '--file',
      plannedBatchFile,
    ], { NADO_TOKEN: token });
    const plannedBatchId = plannedSubmitOut.match(/batch=(batch_[a-f0-9]+)/)?.[1];
    assert.ok(plannedBatchId);
    const plannedWaitOut = await runCli(['batch', 'wait', plannedBatchId, '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(plannedWaitOut, /status=succeeded/);

    const retryBatchFile = path.join(root, 'retry-batch.json');
    await fs.writeFile(retryBatchFile, JSON.stringify({
      title: 'cli retry batch',
      tasks: [
        {
          title: 'cli retry failing first',
          type: 'shell',
          workerId: 'cli-worker',
          command: 'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'retry-marker.txt\')) { fs.writeFileSync(\'retry-marker.txt\', \'x\'); process.exit(3); } fs.writeFileSync(\'retry-ok.txt\', \'ok\'); console.log(\'retry ok\')"',
        },
      ],
    }), 'utf8');
    let retryBatchOut = '';
    await assert.rejects(async () => {
      try {
        await runCli([
          'batch',
          'submit',
          '--control',
          controlUrl,
          '--file',
          retryBatchFile,
          '--wait',
          '--report',
        ], { NADO_TOKEN: token });
      } catch (error) {
        retryBatchOut = error.stdout || '';
        throw error;
      }
    });
    const retryBatchId = retryBatchOut.match(/batch=(batch_[a-f0-9]+)/)?.[1];
    assert.ok(retryBatchId);
    assert.match(retryBatchOut, /waitStatus=completed_with_errors/);
    assert.match(retryBatchOut, /status=completed_with_errors/);
    assert.match(retryBatchOut, /Next actions:/);
    assert.match(retryBatchOut, /retry_failed/);
    const retryManageOut = await runCli([
      'batch',
      'manage',
      retryBatchId,
      '--action',
      'retry_failed',
      '--worker',
      'cli-worker',
      '--control',
      controlUrl,
    ], { NADO_TOKEN: token });
    assert.match(retryManageOut, /retried=1/);
    const retryWaitOut = await runCli(['batch', 'wait', retryBatchId, '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(retryWaitOut, /status=succeeded/);

    const artifactsOut = await runCli(['artifacts', taskId, '--control', controlUrl], { NADO_TOKEN: token });
    const artifactId = artifactsOut.match(/(artifact_[a-f0-9]+)\s+cli\.txt/)?.[1];
    assert.ok(artifactId);
    const downloadDir = path.join(root, 'downloaded');
    const downloadOut = await runCli([
      'artifact',
      'download',
      taskId,
      artifactId,
      '--control',
      controlUrl,
      '--out',
      downloadDir,
    ], { NADO_TOKEN: token });
    assert.match(downloadOut, /downloaded cli\.txt/);
    assert.equal(await fs.readFile(path.join(downloadDir, 'cli.txt'), 'utf8'), 'ok');

    const sessionTaskOut = await runCli([
      'submit',
      '--control',
      controlUrl,
      '--session',
      sessionId,
      '--title',
      'session task',
      '--command',
      'node -e "require(\'fs\').writeFileSync(\'session-cli.txt\', \'session-ok\'); console.log(process.env.NADO_SESSION_ID)"',
    ], { NADO_TOKEN: token });
    const sessionTaskId = sessionTaskOut.match(/submitted (task_[a-f0-9]+)/)?.[1];
    assert.ok(sessionTaskId);
    const sessionTask = await waitForCliTask(sessionTaskId, controlUrl, token);
    assert.equal(sessionTask.status, 'succeeded');
    assert.equal(sessionTask.sessionId, sessionId);
    assert.match(sessionTask.workspace.replaceAll('\\', '/'), new RegExp(`/sessions/${sessionId}$`));
    const sessionsOut = await runCli(['sessions', '--control', controlUrl], { NADO_TOKEN: token });
    assert.match(sessionsOut, new RegExp(sessionId));

    const inputFile = path.join(root, 'input.txt');
    await fs.writeFile(inputFile, 'from-control', 'utf8');
    const inputOut = await runCli([
      'submit',
      '--control',
      controlUrl,
      '--worker',
      'cli-worker',
      '--title',
      'input file task',
      '--file',
      inputFile,
      '--command',
      'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'input.txt\',\'utf8\'); fs.writeFileSync(\'copied.txt\', value+\':worker\'); console.log(value)"',
    ], { NADO_TOKEN: token });
    const inputTaskId = inputOut.match(/submitted (task_[a-f0-9]+)/)?.[1];
    assert.ok(inputTaskId);
    const inputTask = await waitForCliTask(inputTaskId, controlUrl, token);
    assert.equal(inputTask.status, 'succeeded');
    assert.match(inputTask.stdout, /from-control/);
    assert.ok(inputTask.artifacts.some((artifact) => artifact.path === 'input.txt'));
    assert.ok(inputTask.artifacts.some((artifact) => artifact.path === 'copied.txt'));

    const projectDir = path.join(root, 'project');
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'hello.txt'), 'hello-project', 'utf8');
    await fs.writeFile(path.join(projectDir, '.git', 'ignored.txt'), 'ignore-me', 'utf8');
    const dirOut = await runCli([
      'submit',
      '--control',
      controlUrl,
      '--session',
      sessionId,
      '--title',
      'directory sync task',
      '--dir',
      projectDir,
      '--command',
      'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'src/hello.txt\',\'utf8\'); fs.mkdirSync(\'dist\',{recursive:true}); fs.writeFileSync(\'dist/result.txt\', value.toUpperCase()); console.log(value)"',
    ], { NADO_TOKEN: token });
    const dirTaskId = dirOut.match(/submitted (task_[a-f0-9]+)/)?.[1];
    assert.ok(dirTaskId);
    const dirTask = await waitForCliTask(dirTaskId, controlUrl, token);
    assert.equal(dirTask.status, 'succeeded');
    assert.equal(dirTask.sessionId, sessionId);
    assert.match(dirTask.stdout, /hello-project/);
    assert.ok(dirTask.artifacts.some((artifact) => artifact.path === 'src/hello.txt'));
    assert.ok(dirTask.artifacts.some((artifact) => artifact.path === 'dist/result.txt'));
    assert.equal(dirTask.artifacts.some((artifact) => artifact.path === '.git/ignored.txt'), false);

    const allDownloadDir = path.join(root, 'all-artifacts');
    const allDownloadOut = await runCli([
      'artifacts',
      'download',
      dirTaskId,
      '--control',
      controlUrl,
      '--out',
      allDownloadDir,
    ], { NADO_TOKEN: token });
    assert.match(allDownloadOut, /downloaded \d+ artifacts/);
    assert.equal(await fs.readFile(path.join(allDownloadDir, 'src', 'hello.txt'), 'utf8'), 'hello-project');
    assert.equal(await fs.readFile(path.join(allDownloadDir, 'dist', 'result.txt'), 'utf8'), 'HELLO-PROJECT');

    const sessionDownloadDir = path.join(root, 'session-download');
    const sessionDownloadOut = await runCli([
      'session',
      'download',
      sessionId,
      '--control',
      controlUrl,
      '--out',
      sessionDownloadDir,
    ], { NADO_TOKEN: token });
    assert.match(sessionDownloadOut, /downloaded \d+ session artifacts/);
    assert.equal(await fs.readFile(path.join(sessionDownloadDir, 'src', 'hello.txt'), 'utf8'), 'hello-project');
    assert.equal(await fs.readFile(path.join(sessionDownloadDir, 'dist', 'result.txt'), 'utf8'), 'HELLO-PROJECT');

    const contextFile = path.join(root, 'AGENTS.md');
    const contextOut = await runCli([
      'context',
      '--control',
      controlUrl,
      '--out',
      contextFile,
    ], { NADO_TOKEN: token });
    assert.match(contextOut, /AGENTS\.md/);
    assert.match(await fs.readFile(contextFile, 'utf8'), /cli-worker/);

    const migratedContextOut = await runCli([
      'context',
      'install',
      '--control',
      controlUrl,
      '--out',
      contextFile,
    ], { NADO_TOKEN: token });
    assert.match(migratedContextOut, /migrated .*AGENTS\.md/);
    const migratedContext = await fs.readFile(contextFile, 'utf8');
    assert.equal((migratedContext.match(/Nado Agent Control Context/g) || []).length, 1);
    assert.equal((migratedContext.match(/nado-agent-context:start/g) || []).length, 1);
    assert.match(migratedContext, /cli-worker/);

    const installedContextFile = path.join(root, 'installed-AGENTS.md');
    await fs.writeFile(installedContextFile, '# Existing Agent Notes\n\nKeep this user-authored note.\n', 'utf8');
    const installOut = await runCli([
      'context',
      'install',
      '--control',
      controlUrl,
      '--out',
      installedContextFile,
    ], { NADO_TOKEN: token });
    assert.match(installOut, /appended .*installed-AGENTS\.md/);
    let installedContext = await fs.readFile(installedContextFile, 'utf8');
    assert.match(installedContext, /Keep this user-authored note\./);
    assert.match(installedContext, /<!-- nado-agent-context:start -->/);
    assert.match(installedContext, /cli-worker/);
    assert.match(installedContext, /<!-- nado-agent-context:end -->/);

    const reinstallOut = await runCli([
      'context',
      'install',
      '--control',
      controlUrl,
      '--out',
      installedContextFile,
    ], { NADO_TOKEN: token });
    assert.match(reinstallOut, /updated .*installed-AGENTS\.md/);
    installedContext = await fs.readFile(installedContextFile, 'utf8');
    assert.equal((installedContext.match(/nado-agent-context:start/g) || []).length, 1);
    assert.match(installedContext, /Keep this user-authored note\./);
  } finally {
    for (const child of processes.reverse()) {
      if (!child.killed) {
        child.kill();
      }
    }
    await Promise.all(processes.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
      } else {
        child.once('exit', resolve);
        setTimeout(resolve, 2_000).unref();
      }
    })));
    await fs.rm(root, { recursive: true, force: true });
  }
});
