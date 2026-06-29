import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { inferCapabilitiesFromInventory } from '../src/inventory.js';
import { startWorker } from '../src/worker-client.js';
import { agentReadinessDiagnostic, gpuResourceDiagnostic } from '../src/worker-diagnostics.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nado-inventory-'));
}

async function waitForWorker(client, workerId, predicate, timeoutMs = 10_000) {
  const started = Date.now();
  let lastWorker = null;
  while (Date.now() - started < timeoutMs) {
    const { worker } = await client.getWorker(workerId);
    lastWorker = worker;
    if (predicate(worker)) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for worker ${workerId}; last=${JSON.stringify(lastWorker)}`);
}

test('workers report self-discovered inventory and inferred capabilities', async () => {
  const root = await makeTempDir();
  const token = 'inventory-token';
  const { server, port } = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dataDir: path.join(root, 'control'),
  });
  const controlUrl = `http://127.0.0.1:${port}`;
  const client = new NadoClient({ controlUrl, token });
  let worker;

  try {
    worker = await startWorker({
      id: 'inventory-worker',
      controlUrl,
      token,
      dataDir: root,
      capabilities: ['docs'],
      pollMs: 50,
    });

    const registered = await waitForWorker(
      client,
      'inventory-worker',
      (item) => item.inventory?.tools?.node?.available,
    );
    assert.equal(registered.inventory.tools.node.version, process.version);
    assert.equal(registered.inventory.host.hostname, os.hostname());
    assert.ok(registered.capabilities.includes('docs'));
    assert.ok(registered.capabilities.includes('shell'));
    assert.ok(Array.isArray(registered.inventory.inferredCapabilities));
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('inventory infers gpu capability from NVIDIA or ROCm tooling', () => {
  assert.ok(inferCapabilitiesFromInventory([], {
    nvidiaSmi: { available: true },
  }).includes('gpu'));
  assert.ok(inferCapabilitiesFromInventory([], {
    rocmSmi: { available: true },
  }).includes('gpu'));
});

test('gpu resource diagnostics distinguish probes from advertised-only capability', () => {
  const probed = gpuResourceDiagnostic({
    capabilities: ['code', 'gpu'],
    inventory: { tools: { nvidiaSmi: { available: true, version: 'NVIDIA A100, 40960 MiB' } } },
  });
  assert.equal(probed.advertised, true);
  assert.equal(probed.detected, true);
  assert.equal(probed.source, 'probe');
  assert.equal(probed.warning, '');

  const advertisedOnly = gpuResourceDiagnostic({
    capabilities: ['gpu'],
    inventory: { tools: { nvidiaSmi: { available: false }, rocmSmi: { available: false } } },
  });
  assert.equal(advertisedOnly.advertised, true);
  assert.equal(advertisedOnly.detected, false);
  assert.equal(advertisedOnly.source, 'advertised');
  assert.match(advertisedOnly.warning, /no NVIDIA\/ROCm probe/);
});

test('agent readiness diagnostics distinguish real, demo, and missing-tool agents', () => {
  const real = agentReadinessDiagnostic({
    agentCommandConfigured: true,
    agentPreset: 'claude',
    inventory: { tools: { claude: { available: true, version: 'Claude Code' } } },
    diagnostics: { agentSelfTest: { status: 'succeeded', at: new Date().toISOString() } },
  });
  assert.equal(real.mode, 'real-terminal-agent');
  assert.equal(real.status, 'verified');
  assert.equal(real.realTerminalAgent, true);
  assert.equal(real.readyForAgentTasks, true);

  const demo = agentReadinessDiagnostic({
    agentCommandConfigured: true,
    agentPreset: 'node-copy',
    inventory: { tools: {} },
  });
  assert.equal(demo.mode, 'demo-echo');
  assert.equal(demo.realTerminalAgent, false);
  assert.match(demo.warning, /demo echo agent/);

  const missingTool = agentReadinessDiagnostic({
    agentCommandConfigured: true,
    agentPreset: 'codex',
    inventory: { tools: { codex: { available: false } } },
  });
  assert.equal(missingTool.mode, 'missing-tool');
  assert.equal(missingTool.status, 'warning');
  assert.equal(missingTool.readyForAgentTasks, false);
  assert.match(missingTool.warning, /codex CLI/);
});
