import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { startWorker } from '../src/worker-client.js';

const cliPath = path.resolve('src', 'cli.js');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-mcp-'));
}

function encode(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

class McpTestClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    child.stdout.on('data', (chunk) => this.read(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr || ''}${chunk.toString('utf8')}`;
    });
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!length || this.buffer.length < bodyEnd) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyEnd).toString('utf8');
      this.buffer = this.buffer.slice(bodyEnd);
      const message = JSON.parse(body);
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}; stderr=${this.stderr || ''}`));
        }
      }, 8_000).unref();
    });
    this.child.stdin.write(encode(message));
    return promise;
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }
}

function jsonFromTool(result) {
  return JSON.parse(result.content[0].text);
}

test('MCP tools expose gateway worker discovery, dispatch, and task waiting', async () => {
  const root = await makeTempDir();
  const token = 'mcp-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  let worker;
  let mcpProcess;

  try {
    worker = await startWorker({
      id: 'mcp-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['code', 'docs'],
      labels: { zone: 'mcp' },
      agentCommand: 'node -e "const fs=require(\'fs\'); const p=process.argv[1]; fs.writeFileSync(\'mcp-agent.txt\', fs.readFileSync(p,\'utf8\')); console.log(\'mcp-agent-ok\')" {promptFile}',
      pollMs: 50,
    });

    mcpProcess = spawn(process.execPath, [
      cliPath,
      'mcp',
      '--control',
      controlUrl,
    ], {
      env: { ...process.env, NADO_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const mcp = new McpTestClient(mcpProcess);

    const init = await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    assert.equal(init.serverInfo.name, 'nado-agent-gateway');
    mcp.notify('notifications/initialized');

    const tools = await mcp.request('tools/list');
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_submit_task'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_status'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_network'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_worker_preflight'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_worker_events'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_doctor'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_capabilities'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_verify'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_demo_health'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_manage_worker'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_create_session'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_session_artifacts'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_get_session_artifacts'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_recover_offline_tasks'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_create_worker_invite'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_create_worker_bundle'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_create_worker_bootstrap_bundle'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_agent_presets'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_worker_tokens'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_revoke_worker_token'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_worker_enrollment_tokens'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_revoke_worker_enrollment_token'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_prune_worker_enrollment_tokens'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_prune_system_history'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_submit_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_run_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_plan_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_plan_dispatch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_get_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_wait_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_batch_artifacts'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_get_batch_artifacts'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_batch_report'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_batch_events'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_manage_batch'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_list_task_events'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_run_task'));
    assert.ok(tools.tools.some((tool) => tool.name === 'nado_get_task_artifacts'));
    const manageWorkerTool = tools.tools.find((tool) => tool.name === 'nado_manage_worker');
    assert.ok(manageWorkerTool.inputSchema.properties.action.enum.includes('forget'));
    const manageBatchTool = tools.tools.find((tool) => tool.name === 'nado_manage_batch');
    assert.deepEqual(manageBatchTool.inputSchema.properties.action.enum, ['retry_failed', 'cancel']);
    const runBatchTool = tools.tools.find((tool) => tool.name === 'nado_run_batch');
    assert.equal(runBatchTool.inputSchema.properties.waitTimeoutMs.type, 'number');
    assert.equal(runBatchTool.inputSchema.properties.includeReport.type, 'boolean');
    assert.equal(runBatchTool.inputSchema.properties.includeArtifactContent.type, 'boolean');
    assert.equal(runBatchTool.inputSchema.properties.defaults.properties.requireRoutable.type, 'boolean');
    const submitTaskTool = tools.tools.find((tool) => tool.name === 'nado_submit_task');
    assert.equal(submitTaskTool.inputSchema.properties.keepWorkspace.type, 'boolean');
    assert.equal(submitTaskTool.inputSchema.properties.env.type, 'object');
    assert.equal(submitTaskTool.inputSchema.properties.tools.type, 'array');
    assert.equal(submitTaskTool.inputSchema.properties.slots.type, 'number');
    assert.equal(submitTaskTool.inputSchema.properties.artifactPolicy.type, 'object');
    assert.ok(Array.isArray(submitTaskTool.inputSchema.properties.dependencyArtifacts.oneOf));
    assert.deepEqual(submitTaskTool.inputSchema.properties.sandboxProfile.enum, ['default', 'isolated']);
    assert.equal(submitTaskTool.inputSchema.properties.requireRoutable.type, 'boolean');
    const runTaskTool = tools.tools.find((tool) => tool.name === 'nado_run_task');
    assert.equal(runTaskTool.inputSchema.properties.waitTimeoutMs.type, 'number');
    assert.equal(runTaskTool.inputSchema.properties.includeArtifactContent.type, 'boolean');
    const workerBundleTool = tools.tools.find((tool) => tool.name === 'nado_create_worker_bundle');
    assert.equal(workerBundleTool.inputSchema.properties.bundleControlUrl.type, 'string');
    assert.equal(workerBundleTool.inputSchema.properties.publicControlUrl.type, 'string');
    const bootstrapBundleTool = tools.tools.find((tool) => tool.name === 'nado_create_worker_bootstrap_bundle');
    assert.equal(bootstrapBundleTool.inputSchema.properties.bundleControlUrl.type, 'string');
    assert.equal(bootstrapBundleTool.inputSchema.properties.publicControlUrl.type, 'string');
    const pruneSystemTool = tools.tools.find((tool) => tool.name === 'nado_prune_system_history');
    assert.equal(pruneSystemTool.inputSchema.properties.dryRun.type, 'boolean');
    const pruneEnrollmentTool = tools.tools.find((tool) => tool.name === 'nado_prune_worker_enrollment_tokens');
    assert.equal(pruneEnrollmentTool.inputSchema.properties.dryRun.type, 'boolean');
    const revokeEnrollmentTool = tools.tools.find((tool) => tool.name === 'nado_revoke_worker_enrollment_token');
    assert.equal(revokeEnrollmentTool.inputSchema.properties.tokenId.type, 'string');
    const demoHealthTool = tools.tools.find((tool) => tool.name === 'nado_demo_health');
    assert.equal(demoHealthTool.inputSchema.properties.skipVerify.type, 'boolean');
    assert.equal(demoHealthTool.inputSchema.properties.noPrune.type, 'boolean');
    assert.equal(demoHealthTool.inputSchema.properties.timeoutMs.type, 'number');
    const doctorTool = tools.tools.find((tool) => tool.name === 'nado_doctor');
    assert.equal(doctorTool.inputSchema.properties.agentSelfTest.type, 'boolean');

    const preflight = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_worker_preflight',
      arguments: { workerId: 'mcp-worker' },
    }));
    assert.equal(preflight.ok, true);
    assert.equal(preflight.workerId, 'mcp-worker');

    const workerEvents = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_worker_events',
      arguments: { workerId: 'mcp-worker', tail: 20 },
    }));
    assert.equal(workerEvents.workerId, 'mcp-worker');
    assert.ok(workerEvents.events.some((event) => event.type === 'registered'));

    const presets = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_agent_presets',
      arguments: {},
    }));
    assert.ok(presets.presets.some((preset) => preset.name === 'codex'));
    assert.ok(presets.presets.some((preset) => preset.name === 'node-copy'));

    const planned = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_plan_batch',
      arguments: {
        title: 'mcp planned batch',
        type: 'agent',
        tasks: ['docs: Draft docs', 'checks: Review tests'],
        workerId: 'mcp-worker',
        labels: { zone: 'mcp' },
        sandboxProfile: 'isolated',
      },
    }));
    assert.equal(planned.batch.title, 'mcp planned batch');
    assert.equal(planned.batch.defaults.workerId, 'mcp-worker');
    assert.equal(planned.batch.defaults.sandboxProfile, 'isolated');
    assert.equal(planned.batch.tasks[0].key, 'docs');
    assert.equal(planned.batch.tasks[0].prompt, 'Draft docs');

    const dispatchPlan = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_plan_dispatch',
      arguments: {
        title: 'mcp dispatch preview',
        defaults: { capabilities: ['code'], labels: { zone: 'mcp' } },
        tasks: [
          { key: 'one', title: 'one', type: 'shell', command: 'echo one' },
          { key: 'two', title: 'two', type: 'shell', command: 'echo two' },
        ],
      },
    }));
    assert.equal(dispatchPlan.plan.totalTasks, 2);
    assert.equal(dispatchPlan.plan.counts.assigned, 1);
    assert.equal(dispatchPlan.plan.counts.unassigned, 1);
    assert.equal(dispatchPlan.plan.items[0].scheduler.workerId, 'mcp-worker');
    assert.equal(dispatchPlan.plan.items[1].scheduler.workerId, null);
    assert.equal(dispatchPlan.plan.items[1].nextAction.code, 'wait_or_add_capacity');
    assert.ok(dispatchPlan.plan.items[1].scheduler.candidates.some(
      (candidate) => candidate.workerId === 'mcp-worker' && candidate.eligible === false,
    ));

    const invite = await mcp.request('tools/call', {
      name: 'nado_create_worker_invite',
      arguments: {
        id: 'mcp-gpu-worker',
        capabilities: ['gpu', 'code'],
        labels: { zone: 'lab' },
        agent: 'codex',
        maxConcurrency: 2,
        cleanupWorkspaces: true,
        pollMs: 500,
        bundleControlUrl: controlUrl,
      },
    });
    assert.match(invite.content[0].text, /export NADO_TOKEN='mcp-token'/);
    assert.ok(invite.content[0].text.includes(`export NADO_CONTROL='${controlUrl}'`));
    assert.match(invite.content[0].text, /--id 'mcp-gpu-worker'/);
    assert.match(invite.content[0].text, /--capability 'gpu'/);
    assert.match(invite.content[0].text, /--label 'zone=lab'/);
    assert.match(invite.content[0].text, /--agent 'codex'/);
    assert.match(invite.content[0].text, /--cleanup-workspaces/);

    const issuedInvite = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_worker_invite',
      arguments: {
        id: 'mcp-issued-worker',
        issueToken: true,
        tokenLabel: 'mcp issued',
        bundleControlUrl: controlUrl,
      },
    }));
    assert.equal(issuedInvite.workerToken.workerId, 'mcp-issued-worker');
    assert.equal(issuedInvite.workerToken.label, 'mcp issued');
    assert.match(issuedInvite.invite, /export NADO_TOKEN='nado_wt_[a-f0-9]+'/);
    assert.doesNotMatch(issuedInvite.invite, /export NADO_TOKEN='mcp-token'/);

    const bundle = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_worker_bundle',
      arguments: {
        id: 'mcp-bundle-worker',
        capabilities: ['code'],
        labels: { zone: 'mcp' },
        includeContent: false,
        bundleControlUrl: controlUrl,
      },
    }));
    assert.equal(bundle.manifest.workerId, 'mcp-bundle-worker');
    assert.equal(bundle.manifest.controlUrl, controlUrl);
    assert.equal(bundle.bundleRoot, 'nado-worker-mcp-bundle-worker');
    assert.match(bundle.fileName, /nado-worker-mcp-bundle-worker\.zip/);
    assert.equal(bundle.contentBase64, undefined);
    assert.ok(bundle.files > 4);
    assert.ok(bundle.bytes > 1000);

    const publicBundle = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_worker_bundle',
      arguments: {
        id: 'mcp-public-bundle-worker',
        workerToken: 'nado_wt_public_demo',
        publicControlUrl: 'http://[2001:db8::77]:8765',
        includeContent: false,
      },
    }));
    assert.equal(publicBundle.manifest.controlUrl, 'http://[2001:db8::77]:8765');
    assert.equal(publicBundle.controlUrl, 'http://[2001:db8::77]:8765');
    assert.equal(publicBundle.controlSource, 'publicControlUrl');

    const bootstrapBundle = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_worker_bootstrap_bundle',
      arguments: {
        capabilities: ['code'],
        labels: { zone: 'mcp' },
        includeContent: false,
        maxUses: 4,
        bundleControlUrl: controlUrl,
      },
    }));
    assert.equal(bootstrapBundle.manifest.name, 'nado-worker-bootstrap-bundle');
    assert.equal(bootstrapBundle.manifest.controlUrl, controlUrl);
    assert.equal(bootstrapBundle.manifest.enrollment.workerIdAssignedByControl, true);
    assert.match(bootstrapBundle.enrollmentToken.id, /^wenroll_/);
    assert.equal(bootstrapBundle.bundleRoot, 'nado-worker-bootstrap');
    assert.match(bootstrapBundle.fileName, /nado-worker-bootstrap\.zip/);
    assert.equal(bootstrapBundle.contentBase64, undefined);
    assert.ok(bootstrapBundle.files > 4);
    assert.ok(bootstrapBundle.bytes > 1000);

    const enrollmentTokens = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_worker_enrollment_tokens',
      arguments: {},
    }));
    assert.ok(enrollmentTokens.enrollmentTokens.some((item) => item.id === bootstrapBundle.enrollmentToken.id));
    assert.equal(
      enrollmentTokens.enrollmentTokens.find((item) => item.id === bootstrapBundle.enrollmentToken.id).label,
      'mcp bootstrap bundle',
    );
    const revokedEnrollment = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_revoke_worker_enrollment_token',
      arguments: { tokenId: bootstrapBundle.enrollmentToken.id },
    }));
    assert.equal(revokedEnrollment.enrollmentToken.revokedAt !== null, true);

    const unusedBootstrapBundle = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_worker_bootstrap_bundle',
      arguments: {
        includeContent: false,
        bundleControlUrl: controlUrl,
        tokenLabel: 'mcp unused bootstrap bundle',
      },
    }));
    const pruneEnrollmentPreview = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_prune_worker_enrollment_tokens',
      arguments: { dryRun: true },
    }));
    assert.ok(pruneEnrollmentPreview.prunableTokens.some((item) => item.id === unusedBootstrapBundle.enrollmentToken.id));
    const prunedEnrollmentTokens = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_prune_worker_enrollment_tokens',
      arguments: {},
    }));
    assert.ok(prunedEnrollmentTokens.prunedTokens.some((item) => item.id === unusedBootstrapBundle.enrollmentToken.id));

    const workerTokens = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_worker_tokens',
      arguments: { workerId: 'mcp-issued-worker' },
    }));
    assert.equal(workerTokens.workerTokens.length, 1);
    assert.equal(workerTokens.workerTokens[0].workerId, 'mcp-issued-worker');
    const revokedToken = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_revoke_worker_token',
      arguments: { tokenId: workerTokens.workerTokens[0].id },
    }));
    assert.equal(revokedToken.workerToken.revokedAt !== null, true);

    const workers = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_workers',
      arguments: {},
    }));
    assert.ok(workers.workers.some((item) => item.id === 'mcp-worker'));
    assert.equal(workers.workers.find((item) => item.id === 'mcp-worker').labels.zone, 'mcp');

    const initialStatus = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_status',
      arguments: {},
    }));
    assert.equal(initialStatus.workers.total, 1);
    assert.equal(initialStatus.workers.active, 1);
    assert.equal(initialStatus.sessions.total, 0);
    assert.equal(initialStatus.tasks.total, 0);
    assert.equal(initialStatus.tasks.attention.total, 0);

    const network = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_network',
      arguments: {},
    }));
    assert.equal(network.requestUrl, controlUrl);
    assert.equal(network.requestIsLoopback, true);
    assert.ok(['use_preferred_remote_url', 'configure_public_control_url'].includes(network.nextAction.code));
    assert.ok(network.nextAction.message);
    assert.ok(Array.isArray(network.candidates));

    const capabilities = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_capabilities',
      arguments: {},
    }));
    assert.equal(capabilities.name, 'nado-agent');
    assert.equal(capabilities.controlUrl, controlUrl);
    assert.equal(capabilities.surfaces.dashboard, `${controlUrl}/dashboard`);
    assert.equal(capabilities.features.demoHealth, true);
    assert.equal(capabilities.features.ipv6ControlUrls, true);
    assert.equal(capabilities.features.networkActionHints, true);
    assert.equal(capabilities.features.trustedProxyHeaders, true);
    assert.equal(capabilities.features.workerResourceDiagnostics, true);
    assert.equal(capabilities.features.workerReadinessDiagnostics, true);
    assert.deepEqual(capabilities.features.autoCapabilityRouting, ['gpu', 'docs', 'ppt']);
    assert.equal(capabilities.networking.publicControlUrlEnv, 'NADO_PUBLIC_CONTROL_URL');
    assert.equal(capabilities.networking.trustProxyEnv, 'NADO_TRUST_PROXY');
    assert.equal(capabilities.networking.diagnosticsNextActionField, 'network.nextAction');
    assert.ok(capabilities.routingPolicy.automaticInference.some(
      (policy) => policy.capability === 'gpu' && policy.rules.includes('CUDA keyword'),
    ));
    assert.equal(capabilities.routingPolicy.agentReadiness.agentTasksRequireConfiguredCommand, true);
    assert.equal(capabilities.routingPolicy.resourcePreference.preserveGpuCapacityWhenGpuNotRequired, true);
    assert.equal(capabilities.routingPolicy.resourcePreference.preferProbeDetectedGpuWhenGpuRequired, true);
    assert.equal(capabilities.endpoints.demoHealth, 'POST /api/demo/health');
    assert.ok(capabilities.mcp.tools.includes('nado_capabilities'));
    assert.ok(capabilities.mcp.tools.includes('nado_network'));
    assert.ok(capabilities.mcp.tools.includes('nado_demo_health'));
    assert.ok(capabilities.mcp.tools.includes('nado_list_worker_enrollment_tokens'));
    assert.ok(capabilities.workers.some((workerSummary) => workerSummary.id === 'mcp-worker'));
    assert.equal(
      capabilities.workers.find((workerSummary) => workerSummary.id === 'mcp-worker').readiness.agent.mode,
      'custom',
    );

    const demoHealth = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_demo_health',
      arguments: {
        skipVerify: true,
        noPrune: true,
      },
    }));
    assert.equal(demoHealth.ok, true);
    assert.equal(demoHealth.dashboardUrl, `${controlUrl}/dashboard`);
    assert.equal(demoHealth.status.workers.active, 1);
    assert.equal(demoHealth.verify, null);
    assert.equal(demoHealth.prune, null);
    assert.equal(demoHealth.routeChecks.find((check) => check.capability === 'docs').workerId, 'mcp-worker');
    assert.equal(demoHealth.routeChecks.find((check) => check.capability === 'gpu').status, 'skipped');

    const doctor = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_doctor',
      arguments: {
        selfTest: true,
        allWorkers: true,
        workerId: 'mcp-worker',
        timeoutMs: 8_000,
      },
    }));
    assert.equal(doctor.ok, true);
    assert.equal(doctor.selfTests.length, 1);
    assert.equal(doctor.selfTest.status, 'succeeded');
    assert.ok(doctor.selfTest.artifacts.some((artifact) => artifact.path === 'doctor.txt'));

    const verify = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_verify',
      arguments: {
        workerId: 'mcp-worker',
        labels: { zone: 'mcp' },
        timeoutMs: 8_000,
        skipDoctor: true,
      },
    }));
    assert.equal(verify.ok, true);
    assert.equal(verify.summary.workers.active, 1);
    assert.ok(verify.checks.some((check) => check.name === 'taskArtifact' && check.ok));
    assert.ok(verify.checks.some((check) => check.name === 'batchZip' && check.ok));

    const prunePreview = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_prune_system_history',
      arguments: { dryRun: true },
    }));
    assert.ok(prunePreview.prunableTaskCount >= 1);
    const prunedSystem = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_prune_system_history',
      arguments: {},
    }));
    assert.ok(prunedSystem.prunedTaskCount >= 1);

    const labeledTask = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp label route',
        type: 'shell',
        command: 'node -e "console.log(process.env.NADO_WORKER_ID)"',
        env: { MCP_ENV: 'from-mcp' },
        tools: ['node'],
        slots: 1,
        labels: { zone: 'mcp' },
        priority: 3,
        keepWorkspace: true,
        sandboxProfile: 'isolated',
      },
    }));
    assert.equal(labeledTask.task.requiredLabels.zone, 'mcp');
    assert.equal(labeledTask.task.priority, 3);
    assert.equal(labeledTask.task.keepWorkspace, true);
    assert.equal(labeledTask.task.sandboxProfile, 'isolated');
    assert.equal(labeledTask.task.env.MCP_ENV, 'from-mcp');
    assert.deepEqual(labeledTask.task.requiredTools, ['node']);
    assert.equal(labeledTask.task.slots, 1);
    assert.equal(labeledTask.routing.taskId, labeledTask.task.id);
    assert.equal(labeledTask.routing.selectedWorkerId, 'mcp-worker');
    assert.equal(labeledTask.routing.reason, 'scheduled by score 135');
    assert.deepEqual(labeledTask.routing.effectiveRequiredCapabilities, []);
    assert.ok(labeledTask.routing.candidates.some((candidate) => (
      candidate.workerId === 'mcp-worker'
      && candidate.eligible === true
      && candidate.reasons.includes('idle')
    )));
    const labeledDone = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_wait_task',
      arguments: { taskId: labeledTask.task.id, timeoutMs: 8_000 },
    }));
    assert.equal(labeledDone.task.assignedWorkerId, 'mcp-worker');

    const taskEvents = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_task_events',
      arguments: { taskId: labeledTask.task.id, tail: 3 },
    }));
    assert.equal(taskEvents.taskId, labeledTask.task.id);
    assert.equal(taskEvents.status, 'succeeded');
    assert.ok(taskEvents.events.length <= 3);
    assert.ok(taskEvents.events.some((event) => event.type === 'succeeded'));

    const runTask = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_run_task',
      arguments: {
        title: 'mcp run task flow',
        type: 'shell',
        workerId: 'mcp-worker',
        tools: ['node'],
        requireRoutable: true,
        artifactPolicy: { include: ['mcp-run.txt'] },
        command: 'node -e "require(\'fs\').writeFileSync(\'mcp-run.txt\', \'run-ok\'); console.log(\'run task ok\')"',
        waitTimeoutMs: 8_000,
        includeArtifactContent: true,
      },
    }));
    assert.equal(runTask.submittedTask.requestedWorkerId, 'mcp-worker');
    assert.equal(runTask.routing.selectedWorkerId, 'mcp-worker');
    assert.equal(runTask.routing.reason, 'explicit worker requested');
    assert.equal(runTask.finalRouting.selectedWorkerId, 'mcp-worker');
    assert.equal(runTask.task.status, 'succeeded');
    assert.equal(runTask.task.assignedWorkerId, 'mcp-worker');
    assert.match(runTask.task.stdout, /run task ok/);
    const runArtifact = runTask.artifacts.artifacts.find((item) => item.path === 'mcp-run.txt');
    assert.equal(Buffer.from(runArtifact.contentBase64, 'base64').toString('utf8'), 'run-ok');

    const requireRoutableError = await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp require routable missing capability',
        type: 'shell',
        command: 'echo should-not-create',
        capabilities: ['fpga'],
        requireRoutable: true,
      },
    });
    assert.equal(requireRoutableError.isError, true);
    const requireRoutableBody = jsonFromTool(requireRoutableError);
    assert.equal(requireRoutableBody.status, 409);
    assert.deepEqual(requireRoutableBody.nextActions, ['add_worker_or_relax_constraints']);
    assert.equal(requireRoutableBody.dispatchPlan.items[0].nextAction.code, 'add_worker_or_relax_constraints');

    const unroutableTarget = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp explicit missing target',
        type: 'shell',
        workerId: 'missing-worker',
        command: 'echo should-not-run',
      },
    }));
    assert.equal(unroutableTarget.task.requestedWorkerId, 'missing-worker');
    assert.equal(unroutableTarget.routing.selectedWorkerId, null);
    assert.equal(unroutableTarget.routing.targetWorkerId, 'missing-worker');
    assert.equal(unroutableTarget.routing.targetEligible, false);
    assert.equal(unroutableTarget.routing.routeStatus, 'target_not_eligible');
    assert.equal(unroutableTarget.routing.reason, 'explicit worker requested; target not eligible');
    assert.equal(unroutableTarget.routing.nextAction.code, 'fix_target_or_reschedule');
    assert.ok(unroutableTarget.routing.nextAction.mcp.includes('nado_manage_task'));
    await mcp.request('tools/call', {
      name: 'nado_manage_task',
      arguments: {
        taskId: unroutableTarget.task.id,
        action: 'cancel',
        reason: 'cleanup unroutable route summary test',
      },
    });

    const warnedAgentTask = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp agent warning route',
        type: 'agent',
        prompt: 'Return a tiny note.',
        workerId: 'mcp-worker',
      },
    }));
    assert.ok(Array.isArray(warnedAgentTask.routing.warnings));
    assert.ok(warnedAgentTask.routing.warnings.some(
      (warning) => warning.code === 'agent_readiness_warning',
    ));
    await mcp.request('tools/call', {
      name: 'nado_manage_task',
      arguments: {
        taskId: warnedAgentTask.task.id,
        action: 'cancel',
        reason: 'cleanup routing warning test',
      },
    });

    const createdSession = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_create_session',
      arguments: {
        title: 'mcp session',
        workerId: 'mcp-worker',
      },
    }));
    const sessionId = createdSession.session.id;

    const submitted = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp dispatch',
        type: 'shell',
        sessionId,
        command: 'node -e "require(\'fs\').writeFileSync(\'mcp.txt\', \'ok\'); console.log(\'mcp ok\')"',
      },
    }));
    const taskId = submitted.task.id;
    assert.equal(submitted.routing.taskId, taskId);
    assert.equal(submitted.routing.selectedWorkerId, 'mcp-worker');
    const waited = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_wait_task',
      arguments: { taskId, timeoutMs: 8_000 },
    }));

    assert.equal(waited.task.status, 'succeeded');
    assert.equal(waited.task.assignedWorkerId, 'mcp-worker');
    assert.equal(waited.task.sessionId, sessionId);
    assert.equal(await fs.readFile(path.join(waited.task.workspace, 'mcp.txt'), 'utf8'), 'ok');

    const fetchedSession = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_get_session',
      arguments: { sessionId },
    }));
    assert.equal(fetchedSession.session.assignedWorkerId, 'mcp-worker');

    const sessionArtifacts = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_session_artifacts',
      arguments: { sessionId },
    }));
    assert.equal(sessionArtifacts.sourceTaskId, taskId);
    assert.ok(sessionArtifacts.artifacts.some((item) => item.path === 'mcp.txt'));

    const sessionArtifactContent = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_get_session_artifacts',
      arguments: { sessionId },
    }));
    const mcpSessionArtifact = sessionArtifactContent.artifacts.find((item) => item.path === 'mcp.txt');
    assert.equal(Buffer.from(mcpSessionArtifact.contentBase64, 'base64').toString('utf8'), 'ok');

    const artifacts = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_artifacts',
      arguments: { taskId },
    }));
    const artifact = artifacts.artifacts.find((item) => item.path === 'mcp.txt');
    assert.ok(artifact);

    const fetched = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_get_artifact',
      arguments: { taskId, artifactId: artifact.id },
    }));
    assert.equal(Buffer.from(fetched.contentBase64, 'base64').toString('utf8'), 'ok');

    const taskArtifactContent = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_get_task_artifacts',
      arguments: { taskId },
    }));
    assert.equal(taskArtifactContent.task.id, taskId);
    const groupedTaskArtifact = taskArtifactContent.artifacts.find((item) => item.path === 'mcp.txt');
    assert.equal(Buffer.from(groupedTaskArtifact.contentBase64, 'base64').toString('utf8'), 'ok');

    const inputTask = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_task',
      arguments: {
        title: 'mcp input file',
        type: 'shell',
        workerId: 'mcp-worker',
        inputFiles: [
          {
            path: 'brief.txt',
            contentBase64: Buffer.from('brief-from-control', 'utf8').toString('base64'),
          },
        ],
        command: 'node -e "const fs=require(\'fs\'); const value=fs.readFileSync(\'brief.txt\',\'utf8\'); fs.writeFileSync(\'brief-copy.txt\', value); console.log(value)"',
      },
    }));
    const inputDone = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_wait_task',
      arguments: { taskId: inputTask.task.id, timeoutMs: 8_000 },
    }));
    assert.equal(inputDone.task.status, 'succeeded');
    assert.match(inputDone.task.stdout, /brief-from-control/);

    const runBatch = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_run_batch',
      arguments: {
        title: 'mcp run batch flow',
        requireRoutable: true,
        defaults: {
          workerId: 'mcp-worker',
          tools: ['node'],
          artifactPolicy: { include: ['run-*.txt'] },
        },
        tasks: [
          {
            key: 'one',
            title: 'mcp run batch one',
            type: 'shell',
            command: 'node -e "require(\'fs\').writeFileSync(\'run-one.txt\', \'one\'); console.log(\'run one\')"',
          },
          {
            key: 'two',
            title: 'mcp run batch two',
            type: 'shell',
            command: 'node -e "require(\'fs\').writeFileSync(\'run-two.txt\', \'two\'); console.log(\'run two\')"',
          },
        ],
        waitTimeoutMs: 8_000,
        includeReport: true,
        includeArtifactContent: true,
        stdoutChars: 200,
      },
    }));
    assert.equal(runBatch.batch.status, 'succeeded');
    assert.equal(runBatch.tasks.length, 2);
    assert.equal(runBatch.routing.length, 2);
    assert.ok(runBatch.routing.every((item) => item.selectedWorkerId === 'mcp-worker'));
    assert.ok(runBatch.routing.every((item) => item.reason === 'explicit worker requested'));
    assert.equal(runBatch.finalRouting.length, 2);
    assert.ok(runBatch.finalRouting.every((item) => item.assignedWorkerId === 'mcp-worker'));
    assert.equal(runBatch.report.batch.status, 'succeeded');
    assert.equal(runBatch.report.batch.artifactTotal, 2);
    const runBatchOne = runBatch.artifacts.tasks
      .find((item) => item.batchKey === 'one')
      .artifacts
      .find((item) => item.path === 'run-one.txt');
    const runBatchTwo = runBatch.artifacts.tasks
      .find((item) => item.batchKey === 'two')
      .artifacts
      .find((item) => item.path === 'run-two.txt');
    assert.equal(Buffer.from(runBatchOne.contentBase64, 'base64').toString('utf8'), 'one');
    assert.equal(Buffer.from(runBatchTwo.contentBase64, 'base64').toString('utf8'), 'two');

    const batchCreated = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_submit_batch',
      arguments: {
        title: 'mcp batch outputs',
        requireRoutable: true,
        defaults: {
          workerId: 'mcp-worker',
          labels: { zone: 'mcp' },
          env: { BATCH_ENV: 'mcp-batch' },
          tools: ['node'],
          slots: 1,
          artifactPolicy: { include: ['*.txt'] },
          priority: 4,
          keepWorkspace: true,
        },
        tasks: [
          {
            key: 'docs',
            title: 'mcp batch docs',
            type: 'shell',
            command: 'node -e "require(\'fs\').writeFileSync(\'docs.txt\', \'docs\'); console.log(\'docs\')"',
          },
          {
            key: 'code',
            title: 'mcp batch code',
            type: 'shell',
            command: 'node -e "require(\'fs\').writeFileSync(\'code.txt\', \'code\'); console.log(\'code\')"',
          },
        ],
      },
    }));
    assert.ok(batchCreated.tasks.every((task) => task.requestedWorkerId === 'mcp-worker'));
    assert.equal(batchCreated.routing.length, 2);
    assert.ok(batchCreated.routing.every((item) => item.selectedWorkerId === 'mcp-worker'));
    assert.ok(batchCreated.routing.every((item) => item.reason === 'explicit worker requested'));
    assert.ok(batchCreated.routing.every((item) => item.candidates.some((candidate) => (
      candidate.workerId === 'mcp-worker'
      && candidate.eligible === true
    ))));
    assert.ok(batchCreated.tasks.every((task) => task.requiredLabels.zone === 'mcp'));
    assert.ok(batchCreated.tasks.every((task) => task.env.BATCH_ENV === 'mcp-batch'));
    assert.ok(batchCreated.tasks.every((task) => task.requiredTools.includes('node')));
    assert.ok(batchCreated.tasks.every((task) => task.slots === 1));
    assert.ok(batchCreated.tasks.every((task) => task.artifactPolicy.include.includes('*.txt')));
    assert.ok(batchCreated.tasks.every((task) => task.priority === 4));
    assert.ok(batchCreated.tasks.every((task) => task.keepWorkspace === true));
    const batchWaited = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_wait_batch',
      arguments: { batchId: batchCreated.batch.id, timeoutMs: 8_000 },
    }));
    assert.equal(batchWaited.batch.status, 'succeeded');
    assert.equal(batchWaited.tasks.length, 2);

    const batchArtifacts = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_batch_artifacts',
      arguments: { batchId: batchCreated.batch.id },
    }));
    assert.equal(batchArtifacts.totalArtifacts, 2);
    assert.ok(batchArtifacts.tasks.some((item) => item.batchKey === 'docs' && item.artifacts.some((artifactItem) => artifactItem.path === 'docs.txt')));
    assert.ok(batchArtifacts.tasks.some((item) => item.batchKey === 'code' && item.artifacts.some((artifactItem) => artifactItem.path === 'code.txt')));

    const fetchedBatchArtifacts = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_get_batch_artifacts',
      arguments: { batchId: batchCreated.batch.id },
    }));
    const docsArtifact = fetchedBatchArtifacts.tasks
      .find((item) => item.batchKey === 'docs')
      .artifacts
      .find((artifactItem) => artifactItem.path === 'docs.txt');
    assert.equal(Buffer.from(docsArtifact.contentBase64, 'base64').toString('utf8'), 'docs');

    const batchReport = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_batch_report',
      arguments: { batchId: batchCreated.batch.id, stdoutChars: 200 },
    }));
    assert.equal(batchReport.batch.status, 'succeeded');
    assert.equal(batchReport.batch.artifactTotal, 2);
    assert.ok(batchReport.tasks.some((item) => item.batchKey === 'docs' && item.stdoutTail.includes('docs')));

    const batchEvents = jsonFromTool(await mcp.request('tools/call', {
      name: 'nado_list_batch_events',
      arguments: { batchId: batchCreated.batch.id },
    }));
    assert.equal(batchEvents.batch.id, batchCreated.batch.id);
    assert.ok(batchEvents.events.some((event) => event.source === 'batch' && event.type === 'created'));
    assert.ok(batchEvents.events.some((event) => event.source === 'task' && event.task === 'docs' && event.type === 'succeeded'));
    assert.ok(batchEvents.events.some((event) => event.source === 'task' && event.task === 'code' && event.type === 'succeeded'));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    if (mcpProcess && !mcpProcess.killed) {
      mcpProcess.kill();
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
