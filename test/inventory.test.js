import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import {
  inferCapabilitiesFromInventory,
  normalizeLinuxTemperatureC,
  parseAmdSmiJson,
  parseMacOsCpuTemperatureOutput,
  parseRocmSmiJson,
  parseWindowsHardwareMonitorOutput,
  parseWindowsThermalOutput,
  probeHostTemperatures,
  probeLinuxTemperatures,
  probeMacOsTemperatures,
  probeWindowsTemperatures,
} from '../src/inventory.js';
import { startWorker } from '../src/worker-client.js';
import { agentReadinessDiagnostic, gpuResourceDiagnostic } from '../src/worker-diagnostics.js';
import { workerResourceCapacity } from '../src/resource-model.js';

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
      longPollMs: 0,
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
    assert.ok(Array.isArray(registered.inventory.resources.temperatures));
    assert.equal(registered.runtime.build.protocolVersion, 1);
    assert.match(registered.runtime.build.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);

    const gatewayCapabilities = await client.capabilities();
    const summarizedWorker = gatewayCapabilities.workers.find((item) => item.id === registered.id);
    assert.equal(summarizedWorker.buildCompatibility.status, 'compatible');
    assert.equal(summarizedWorker.runtime.build.sourceFingerprint, gatewayCapabilities.runtime.build.sourceFingerprint);

    const telemetry = await waitForWorker(
      client,
      'inventory-worker',
      (item) => item.metrics?.disk?.available
        && item.metrics?.control?.lastSuccessAt
        && item.metrics?.control?.bandwidth?.available
        && Number.isFinite(Number(item.metrics?.cpu?.utilizationPercent)),
    );
    assert.ok(telemetry.metrics.disk.totalBytes > 0);
    assert.ok(telemetry.metrics.disk.availableBytes >= 0);
    assert.ok(telemetry.metrics.control.roundTripMs >= 0);
    assert.ok(telemetry.metrics.control.bandwidth.downloadBytesPerSecond > 0);
    assert.ok(telemetry.metrics.control.bandwidth.uploadBytesPerSecond > 0);
    assert.ok(telemetry.metrics.cpu.utilizationPercent >= 0);
    assert.ok(telemetry.metrics.cpu.utilizationPercent <= 100);
    assert.ok(telemetry.metrics.memory.totalBytes > 0);
    assert.ok(telemetry.metrics.memory.freeBytes >= 0);
    assert.equal(telemetry.resources.cpu.utilizationPercent, telemetry.metrics.cpu.utilizationPercent);
    assert.equal(telemetry.resources.memory.usedPercent, telemetry.metrics.memory.usedPercent);
    assert.equal(telemetry.resources.disk.available, true);
    assert.equal(telemetry.resources.network.measurement, 'previous successful heartbeat request/response');
    assert.equal(telemetry.resources.network.bandwidth.measurement, 'bounded worker-initiated control transfer probe');
  } finally {
    worker?.stop();
    if (worker) {
      await Promise.allSettled([worker.done]);
    }
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('inventory infers gpu capability from NVIDIA, AMD SMI, or ROCm tooling', () => {
  assert.ok(inferCapabilitiesFromInventory([], {
    nvidiaSmi: { available: true },
  }).includes('gpu'));
  assert.ok(inferCapabilitiesFromInventory([], {
    amdSmi: { available: true },
  }).includes('gpu'));
  assert.ok(inferCapabilitiesFromInventory([], {
    rocmSmi: { available: true },
  }).includes('gpu'));
});

test('AMD SMI inventory merges static identity with metric VRAM and telemetry', () => {
  const devices = parseAmdSmiJson(
    `AMD SMI diagnostic\n${JSON.stringify([
      {
        gpu: 0,
        asic: { market_name: 'AMD Instinct MI300X' },
        vram: { size: { value: 196608, unit: 'MB' } },
      },
      {
        gpu: 1,
        asic: { market_name: 'AMD Radeon PRO W7900' },
        vram: { size: { value: 48, unit: 'GiB' } },
      },
    ])}`,
    JSON.stringify([
      {
        gpu: 0,
        mem_usage: {
          total_vram: { value: 196608, unit: 'MB' },
          used_vram: { value: 8192, unit: 'MB' },
        },
        temperature: {
          edge: { value: 52.5, unit: 'C' },
          hotspot: { value: 67, unit: 'C' },
        },
        usage: { gfx_activity: { value: 73, unit: '%' } },
      },
      {
        gpu: 1,
        mem_usage: {
          total_vram: { value: 48, unit: 'GiB' },
          free_vram: { value: 40, unit: 'GiB' },
        },
        temperature: { hotspot: { value: 61.5, unit: 'C' } },
        usage: { average_gfx_activity: 31 },
      },
    ]),
  );
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    index: 0,
    vendor: 'amd',
    name: 'AMD Instinct MI300X',
    memoryTotalBytes: 196608 * 1_000 ** 2,
    memoryFreeBytes: (196608 - 8192) * 1_000 ** 2,
    temperatureC: 52.5,
    utilizationPercent: 73,
  });
  assert.equal(devices[1].memoryTotalBytes, 48 * 1024 ** 3);
  assert.equal(devices[1].memoryFreeBytes, 40 * 1024 ** 3);
  assert.equal(devices[1].temperatureC, 61.5);
  const capacity = workerResourceCapacity({ inventory: { resources: { gpus: devices } } }, { gpuModel: 'MI300X' });
  assert.equal(capacity.gpuCount, 1);
  assert.equal(capacity.gpuMemoryBytes, 196608 * 1_000 ** 2);
});

test('ROCm inventory normalizes AMD model VRAM temperature and utilization', () => {
  const devices = parseRocmSmiJson(`ROCm-SMI version 6\n${JSON.stringify({
    system: { version: '6.1.0' },
    card0: {
      'Card series': 'AMD Radeon RX 7900 XTX',
      'VRAM Total Memory (B)': '25753026560',
      'VRAM Total Used Memory (B)': '2147483648',
      'Temperature (Sensor edge) (C)': '47.5',
      'GPU use (%)': '12',
    },
    card1: {
      'Device Name': 'AMD Instinct MI210',
      'VRAM Total Memory': '64 GiB',
      'VRAM Total Used Memory': '4 GiB',
      'Temperature (Sensor junction) (C)': '55.0',
      'GPU Utilization (%)': '31',
    },
  })}`);
  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    index: 0,
    vendor: 'amd',
    name: 'AMD Radeon RX 7900 XTX',
    memoryTotalBytes: 25_753_026_560,
    memoryFreeBytes: 23_605_542_912,
    temperatureC: 47.5,
    utilizationPercent: 12,
  });
  assert.equal(devices[1].memoryTotalBytes, 64 * 1024 ** 3);
  assert.equal(devices[1].memoryFreeBytes, 60 * 1024 ** 3);
  const capacity = workerResourceCapacity({ inventory: { resources: { gpus: devices } } }, { gpuModel: 'MI210' });
  assert.equal(capacity.gpuCount, 1);
  assert.equal(capacity.gpuMemoryBytes, 64 * 1024 ** 3);
  assert.equal(capacity.gpus[0].vendor, 'amd');
});

test('host temperature parsers normalize Linux millidegrees and Windows ACPI decikelvin', () => {
  assert.equal(normalizeLinuxTemperatureC('42500'), 42.5);
  assert.equal(normalizeLinuxTemperatureC('1000'), 1);
  assert.equal(normalizeLinuxTemperatureC('51.2'), 51.2);
  assert.equal(normalizeLinuxTemperatureC('999999'), null);
  assert.deepEqual(parseWindowsThermalOutput('ACPI\\ThermalZone\\TZ00,3000'), [{
    name: 'ACPI\\ThermalZone\\TZ00',
    source: 'windows-acpi',
    temperatureC: 26.9,
  }]);
});

test('Windows hardware monitor inventory normalizes common desktop sensors and prefers LibreHardwareMonitor duplicates', () => {
  const temperatures = parseWindowsHardwareMonitorOutput(JSON.stringify({
    sensors: [
      {
        name: '/intelcpu/0: CPU Package',
        source: 'windows-libre-hardware-monitor',
        identifier: '/intelcpu/0/temperature/0',
        temperatureC: 68.24,
      },
      {
        name: '/intelcpu/0: CPU Package',
        source: 'windows-open-hardware-monitor',
        identifier: '/intelcpu/0/temperature/0',
        temperatureC: 68.5,
      },
      {
        name: '/gpu-nvidia/0: GPU Core',
        source: 'windows-libre-hardware-monitor',
        identifier: '/gpu-nvidia/0/temperature/0',
        temperatureC: 54,
      },
      {
        name: '/mainboard/0: System',
        source: 'windows-libre-hardware-monitor',
        identifier: '/mainboard/0/temperature/0',
        temperatureC: 37.6,
      },
      {
        name: '/nvme/0: Temperature',
        source: 'windows-libre-hardware-monitor',
        identifier: '/nvme/0/temperature/0',
        temperatureC: 42,
      },
      {
        name: 'ACPI\\ThermalZone\\TZ00',
        source: 'windows-acpi',
        identifier: 'acpi\\thermalzone\\tz00',
        temperatureC: 26.9,
      },
      { name: 'broken', source: 'windows-acpi', temperatureC: 999 },
      { name: 'missing', source: 'windows-acpi' },
    ],
  }));

  assert.deepEqual(temperatures, [
    { name: '/intelcpu/0: CPU Package', source: 'windows-libre-hardware-monitor', temperatureC: 68.2 },
    { name: '/gpu-nvidia/0: GPU Core', source: 'windows-libre-hardware-monitor', temperatureC: 54 },
    { name: '/mainboard/0: System', source: 'windows-libre-hardware-monitor', temperatureC: 37.6 },
    { name: '/nvme/0: Temperature', source: 'windows-libre-hardware-monitor', temperatureC: 42 },
    { name: 'ACPI\\ThermalZone\\TZ00', source: 'windows-acpi', temperatureC: 26.9 },
  ]);
  assert.deepEqual(parseWindowsHardwareMonitorOutput('not-json'), []);
  assert.deepEqual(parseWindowsHardwareMonitorOutput('{"sensors":{}}'), []);
});

test('Windows temperature probe queries optional hardware monitors and degrades to an empty sample on failure', async () => {
  let invocation;
  const temperatures = await probeWindowsTemperatures({
    execFileAsync: async (...args) => {
      invocation = args;
      return {
        stdout: JSON.stringify({
          sensors: [{
            name: '/amdcpu/0: CPU Package',
            source: 'windows-libre-hardware-monitor',
            identifier: '/amdcpu/0/temperature/0',
            temperatureC: 71.25,
          }],
        }),
      };
    },
  });
  assert.equal(invocation[0], 'powershell.exe');
  assert.match(invocation[1].at(-1), /root\/LibreHardwareMonitor/);
  assert.match(invocation[1].at(-1), /root\/OpenHardwareMonitor/);
  assert.match(invocation[1].at(-1), /MSAcpi_ThermalZoneTemperature/);
  assert.deepEqual(temperatures, [{
    name: '/amdcpu/0: CPU Package',
    source: 'windows-libre-hardware-monitor',
    temperatureC: 71.3,
  }]);

  assert.deepEqual(await probeWindowsTemperatures({
    execFileAsync: async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'ENOENT' });
    },
  }), []);
});

test('macOS temperature probe reads an optional unprivileged tool and fails closed when unavailable', async () => {
  assert.deepEqual(parseMacOsCpuTemperatureOutput('61.25°C\n'), [{
    name: 'CPU temperature',
    source: 'macos-osx-cpu-temp',
    temperatureC: 61.3,
  }]);
  assert.deepEqual(parseMacOsCpuTemperatureOutput('CPU temperature: 54.5 C\n'), [{
    name: 'CPU temperature',
    source: 'macos-osx-cpu-temp',
    temperatureC: 54.5,
  }]);
  assert.deepEqual(parseMacOsCpuTemperatureOutput('osx-cpu-temp 1.1\n'), []);
  assert.deepEqual(parseMacOsCpuTemperatureOutput('999°C\n'), []);

  let invocation;
  assert.deepEqual(await probeMacOsTemperatures({
    execFileAsync: async (...args) => {
      invocation = args;
      return { stdout: '48.8°C\n' };
    },
  }), [{
    name: 'CPU temperature',
    source: 'macos-osx-cpu-temp',
    temperatureC: 48.8,
  }]);
  assert.equal(invocation[0], 'osx-cpu-temp');
  assert.deepEqual(invocation[1], []);
  assert.equal(invocation[2].timeout, 3_000);
  assert.equal(invocation[2].maxBuffer, 64 * 1_024);

  assert.deepEqual(await probeMacOsTemperatures({
    execFileAsync: async () => {
      throw Object.assign(new Error('optional command unavailable'), { code: 'ENOENT' });
    },
  }), []);

  assert.deepEqual(await probeHostTemperatures({
    platform: 'darwin',
    execFileAsync: async () => ({ stdout: '49.2°C\n' }),
  }), [{
    name: 'CPU temperature',
    source: 'macos-osx-cpu-temp',
    temperatureC: 49.2,
  }]);
  assert.deepEqual(await probeHostTemperatures({ platform: 'freebsd' }), []);
});

test('Linux host temperatures merge hwmon sensors with thermal zones and ignore invalid readings', async () => {
  const root = await makeTempDir();
  const thermalRoot = path.join(root, 'thermal');
  const hwmonRoot = path.join(root, 'hwmon');
  try {
    await Promise.all([
      fs.mkdir(path.join(thermalRoot, 'thermal_zone0'), { recursive: true }),
      fs.mkdir(path.join(thermalRoot, 'thermal_zone1'), { recursive: true }),
      fs.mkdir(path.join(hwmonRoot, 'hwmon0'), { recursive: true }),
      fs.mkdir(path.join(hwmonRoot, 'hwmon1'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(thermalRoot, 'thermal_zone0', 'type'), 'coretemp: Package id 0\n'),
      fs.writeFile(path.join(thermalRoot, 'thermal_zone0', 'temp'), '42500\n'),
      fs.writeFile(path.join(thermalRoot, 'thermal_zone1', 'type'), 'broken sensor\n'),
      fs.writeFile(path.join(thermalRoot, 'thermal_zone1', 'temp'), '999999\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon0', 'name'), 'coretemp\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon0', 'temp1_label'), 'Package id 0\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon0', 'temp1_input'), '42500\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon0', 'temp2_label'), 'Core 0\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon0', 'temp2_input'), '40000\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon1', 'name'), 'nvme\n'),
      fs.writeFile(path.join(hwmonRoot, 'hwmon1', 'temp1_input'), '-999999\n'),
    ]);

    assert.deepEqual(await probeLinuxTemperatures({ thermalRoot, hwmonRoot }), [
      { name: 'coretemp: Package id 0', source: 'linux-hwmon', temperatureC: 42.5 },
      { name: 'coretemp: Core 0', source: 'linux-hwmon', temperatureC: 40 },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

  const amdProbed = gpuResourceDiagnostic({
    capabilities: ['gpu'],
    inventory: { tools: { amdSmi: { available: true, version: 'AMD SMI 26.1' } } },
  });
  assert.equal(amdProbed.detected, true);
  assert.equal(amdProbed.probes.find((probe) => probe.tool === 'amdSmi').available, true);

  const advertisedOnly = gpuResourceDiagnostic({
    capabilities: ['gpu'],
    inventory: { tools: {
      nvidiaSmi: { available: false },
      amdSmi: { available: false },
      rocmSmi: { available: false },
    } },
  });
  assert.equal(advertisedOnly.advertised, true);
  assert.equal(advertisedOnly.detected, false);
  assert.equal(advertisedOnly.source, 'advertised');
  assert.match(advertisedOnly.warning, /no NVIDIA\/AMD SMI probe/);
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
