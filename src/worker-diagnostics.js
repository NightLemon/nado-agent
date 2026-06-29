export function gpuResourceDiagnostic(worker = {}) {
  const tools = worker.inventory?.tools || {};
  const probes = [
    {
      name: 'nvidia-smi',
      tool: 'nvidiaSmi',
      available: Boolean(tools.nvidiaSmi?.available),
      version: tools.nvidiaSmi?.version || null,
    },
    {
      name: 'rocm-smi',
      tool: 'rocmSmi',
      available: Boolean(tools.rocmSmi?.available),
      version: tools.rocmSmi?.version || null,
    },
  ];
  const advertised = (worker.capabilities || []).includes('gpu');
  const detected = probes.some((probe) => probe.available);
  const source = detected ? 'probe' : (advertised ? 'advertised' : 'none');
  const warning = advertised && !detected
    ? 'gpu capability is advertised but no NVIDIA/ROCm probe was reported; verify the worker GPU runtime before scheduling real accelerator workloads'
    : '';
  return {
    advertised,
    detected,
    source,
    probes,
    warning,
  };
}

export function workerResourceDiagnostics(worker = {}) {
  return {
    gpu: gpuResourceDiagnostic(worker),
  };
}

function toolAvailable(worker, name) {
  return Boolean(worker.inventory?.tools?.[name]?.available);
}

export function agentReadinessDiagnostic(worker = {}) {
  const configured = Boolean(worker.agentCommandConfigured);
  const preset = worker.agentPreset || null;
  const selfTest = worker.diagnostics?.agentSelfTest || null;
  const selfTestStatus = String(selfTest?.status || '').toLowerCase();
  const selfTestFailed = selfTestStatus && selfTestStatus !== 'succeeded';
  const codexAvailable = toolAvailable(worker, 'codex');
  const claudeAvailable = toolAvailable(worker, 'claude');
  const expectedTool = preset === 'codex' || preset === 'claude' ? preset : null;
  const expectedToolAvailable = expectedTool
    ? toolAvailable(worker, expectedTool)
    : codexAvailable || claudeAvailable;

  if (!configured) {
    return {
      configured: false,
      preset,
      mode: 'shell-only',
      status: 'unavailable',
      expectedTool,
      expectedToolAvailable,
      realTerminalAgent: false,
      readyForAgentTasks: false,
      selfTest,
      warning: 'no agent command configured; this worker can run shell tasks but not terminal-agent tasks',
    };
  }

  if (preset === 'node-copy') {
    return {
      configured,
      preset,
      mode: 'demo-echo',
      status: selfTestFailed ? 'self-test-failed' : 'demo',
      expectedTool: null,
      expectedToolAvailable: false,
      realTerminalAgent: false,
      readyForAgentTasks: !selfTestFailed,
      selfTest,
      warning: selfTestFailed
        ? 'agent self-test did not succeed; inspect worker diagnostics before assigning agent tasks'
        : 'demo echo agent is configured; it validates scheduling and artifacts but does not perform real LLM reasoning',
    };
  }

  if (expectedTool && !expectedToolAvailable) {
    return {
      configured,
      preset,
      mode: 'missing-tool',
      status: 'warning',
      expectedTool,
      expectedToolAvailable: false,
      realTerminalAgent: false,
      readyForAgentTasks: false,
      selfTest,
      warning: `${expectedTool} preset is configured but the ${expectedTool} CLI was not reported in worker inventory`,
    };
  }

  if (selfTestFailed) {
    return {
      configured,
      preset,
      mode: expectedTool ? 'real-terminal-agent' : 'custom',
      status: 'self-test-failed',
      expectedTool,
      expectedToolAvailable,
      realTerminalAgent: Boolean(expectedTool && expectedToolAvailable),
      readyForAgentTasks: false,
      selfTest,
      warning: 'agent self-test did not succeed; inspect worker diagnostics before assigning agent tasks',
    };
  }

  if (expectedTool && expectedToolAvailable) {
    return {
      configured,
      preset,
      mode: 'real-terminal-agent',
      status: selfTestStatus === 'succeeded' ? 'verified' : 'ready',
      expectedTool,
      expectedToolAvailable: true,
      realTerminalAgent: true,
      readyForAgentTasks: true,
      selfTest,
      warning: selfTestStatus === 'succeeded' ? '' : 'agent command is configured, but no successful agent self-test has been recorded yet',
    };
  }

  return {
    configured,
    preset,
    mode: 'custom',
    status: selfTestStatus === 'succeeded' ? 'verified' : 'configured',
    expectedTool,
    expectedToolAvailable,
    realTerminalAgent: false,
    readyForAgentTasks: true,
    selfTest,
    warning: selfTestStatus === 'succeeded'
      ? ''
      : 'custom agent command is configured; run an agent self-test before trusting real agent work',
  };
}

export function workerReadinessDiagnostics(worker = {}) {
  return {
    agent: agentReadinessDiagnostic(worker),
  };
}
