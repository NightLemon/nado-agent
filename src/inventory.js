import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function probeCommand(name, args = ['--version']) {
  try {
    const { stdout, stderr } = await execFileAsync(name, args, {
      timeout: 2_000,
      windowsHide: true,
    });
    return {
      available: true,
      version: `${stdout || stderr}`.trim().split(/\r?\n/)[0] || 'available',
    };
  } catch (error) {
    return {
      available: false,
      error: error.code || error.message,
    };
  }
}

export function inferCapabilitiesFromInventory(extraCapabilities = [], tools = {}) {
  const inferredCapabilities = new Set(extraCapabilities);
  inferredCapabilities.add('shell');
  if (tools.git?.available) {
    inferredCapabilities.add('git');
  }
  if (tools.codex?.available || tools.claude?.available) {
    inferredCapabilities.add('agent');
    inferredCapabilities.add('code');
  }
  if (tools.gh?.available) {
    inferredCapabilities.add('github');
  }
  if (tools.nvidiaSmi?.available || tools.rocmSmi?.available) {
    inferredCapabilities.add('gpu');
  }
  return Array.from(inferredCapabilities).sort();
}

export async function collectInventory(extraCapabilities = []) {
  const tools = {
    node: {
      available: true,
      version: process.version,
    },
    git: await probeCommand('git'),
    gh: await probeCommand('gh'),
    codex: await probeCommand('codex', ['--version']),
    claude: await probeCommand('claude', ['--version']),
    nvidiaSmi: await probeCommand('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']),
    rocmSmi: await probeCommand('rocm-smi', ['--showproductname']),
  };

  return {
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      totalmem: os.totalmem(),
    },
    tools,
    inferredCapabilities: inferCapabilitiesFromInventory(extraCapabilities, tools),
    collectedAt: new Date().toISOString(),
  };
}
