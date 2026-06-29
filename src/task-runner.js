import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, safeName, truncateText } from './utils.js';
import { collectArtifacts } from './artifacts.js';

function shellCommand(command) {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    };
  }
  return {
    file: '/bin/bash',
    args: ['-lc', command],
  };
}

function quoteForShell(value) {
  const text = String(value);
  if (process.platform === 'win32') {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

function renderAgentCommand(template, { prompt, promptFile, workspace }) {
  return template
    .replaceAll('{prompt}', quoteForShell(prompt))
    .replaceAll('{promptFile}', quoteForShell(promptFile))
    .replaceAll('{workspace}', quoteForShell(workspace));
}

function minimalHostEnv() {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    keep
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
}

function processEnvForTask(taskEnv, nadoEnv, sandboxProfile) {
  const base = sandboxProfile === 'isolated' ? minimalHostEnv() : process.env;
  return {
    ...base,
    ...taskEnv,
    ...nadoEnv,
  };
}

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function buildAgentPrompt(task, workspace, prompt) {
  if (!task.sessionId) {
    return {
      promptText: prompt,
      transcriptFile: null,
    };
  }

  const sessionDir = path.join(workspace, '.nado-session');
  const promptsDir = path.join(sessionDir, 'prompts');
  await fs.mkdir(promptsDir, { recursive: true });
  const transcriptFile = path.join(sessionDir, 'transcript.md');
  const transcript = await readIfExists(transcriptFile);
  const trimmedTranscript = transcript.length > 60_000
    ? transcript.slice(transcript.length - 60_000)
    : transcript;

  const promptText = `# Nado Session Agent Prompt

Session: ${task.sessionId}
Task: ${task.id}
Title: ${task.title}

## Prior Session Transcript

${trimmedTranscript || '(No prior agent transcript in this session.)'}

## Current Task Prompt

${prompt}
`;

  return {
    promptText,
    transcriptFile,
    promptFile: path.join(promptsDir, `${safeName(task.id)}.md`),
  };
}

async function appendAgentTranscript({ task, transcriptFile, prompt, result }) {
  if (!transcriptFile) {
    return;
  }
  const entry = `\n\n## Task ${task.id}: ${task.title}

Status: ${result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'succeeded' : 'failed'}
Exit code: ${result.exitCode}

### Prompt

${prompt}

### Stdout

\`\`\`
${truncateText(result.stdout || '', 20_000)}
\`\`\`

### Stderr

\`\`\`
${truncateText(result.stderr || '', 20_000)}
\`\`\`

### Error

${result.error || '(none)'}
`;
  await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
  await fs.appendFile(transcriptFile, entry, 'utf8');
}

async function writeInputFiles(workspace, inputFiles = []) {
  const root = path.resolve(workspace);
  for (const file of inputFiles) {
    const relativePath = String(file.path || '').replaceAll('\\', '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..')) {
      throw new Error(`Unsafe input file path: ${file.path}`);
    }
    const target = path.resolve(workspace, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Unsafe input file path: ${file.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(file.contentBase64 || '', 'base64'));
  }
}

function runProcess(command, { cwd, timeoutMs, maxOutputChars, env, signal, onOutput }) {
  return new Promise((resolve) => {
    const shell = shellCommand(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    const pendingOutputEvents = [];

    const emitOutput = (stream, text) => {
      if (!onOutput || !text) {
        return;
      }
      const maybePromise = onOutput(stream, text);
      if (maybePromise?.then) {
        pendingOutputEvents.push(maybePromise.catch(() => {}));
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref();
    }, timeoutMs);
    timeout.unref();

    const abort = () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2_000).unref();
    };

    if (signal) {
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout = truncateText(stdout + text, maxOutputChars);
      emitOutput('stdout', text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr = truncateText(stderr + text, maxOutputChars);
      emitOutput('stderr', text);
    });

    child.on('error', async (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abort);
      await Promise.allSettled(pendingOutputEvents);
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        error: error.message,
        timedOut,
      });
    });

    child.on('close', async (code, terminationSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abort);
      await Promise.allSettled(pendingOutputEvents);
      const timeoutMessage = timedOut ? `Timed out after ${timeoutMs}ms` : null;
      const cancelMessage = cancelled ? 'Cancelled by gateway management command' : null;
      resolve({
        exitCode: timedOut ? 124 : cancelled ? 130 : code ?? 1,
        stdout,
        stderr,
        error: timeoutMessage || cancelMessage || (terminationSignal ? `Terminated by ${terminationSignal}` : null),
        timedOut,
        cancelled,
      });
    });
  });
}

export async function runTask(task, options) {
  const workerDir = path.join(options.dataDir, 'workers', safeName(options.workerId));
  const workspace = task.sessionId
    ? path.join(workerDir, 'sessions', safeName(task.sessionId))
    : path.join(workerDir, 'tasks', safeName(task.id));
  await ensureDir(workspace);
  await writeInputFiles(workspace, [
    ...(task.inputFiles || []),
    ...(task.dependencyInputFiles || []),
  ]);
  const shouldCleanupWorkspace = !task.sessionId && (
    task.keepWorkspace === false
    || (task.keepWorkspace === undefined && options.cleanupWorkspaces)
  );

  const finish = async (result, { collect = true } = {}) => {
    const artifacts = collect ? await collectArtifacts(workspace, {
      ...options,
      artifactPolicy: task.artifactPolicy,
    }) : [];
    let workspaceCleaned = false;
    if (shouldCleanupWorkspace) {
      await fs.rm(workspace, { recursive: true, force: true });
      workspaceCleaned = true;
    }
    return {
      ...result,
      workspace,
      workspaceCleaned,
      artifacts,
    };
  };

  const timeoutMs = Number(task.timeoutMs || options.timeoutMs || 10 * 60 * 1000);
  const maxOutputChars = Number(task.maxOutputChars || options.maxOutputChars || 80_000);

  let command = task.command;
  let transcriptFile = null;
  let originalAgentPrompt = null;
  if (task.type === 'agent') {
    if (!options.agentCommand) {
      return finish({
        status: 'failed',
        exitCode: 1,
        stdout: '',
        stderr: '',
        error: 'Worker has no agent command configured',
      });
    }
    const prompt = task.prompt || task.command || '';
    originalAgentPrompt = prompt;
    const agentPrompt = await buildAgentPrompt(task, workspace, prompt);
    transcriptFile = agentPrompt.transcriptFile;
    const promptFile = agentPrompt.promptFile || path.join(workspace, '.nado', 'prompt.md');
    await ensureDir(path.dirname(promptFile));
    await fs.writeFile(promptFile, agentPrompt.promptText, 'utf8');
    command = renderAgentCommand(options.agentCommand, {
      prompt: agentPrompt.promptText,
      promptFile,
      workspace,
    });
  }

  if (!command) {
    return finish({
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: '',
      error: `Task type ${task.type} requires a command`,
    });
  }

  const result = await runProcess(command, {
    cwd: workspace,
    timeoutMs,
    maxOutputChars,
    env: processEnvForTask(task.env || {}, {
      NADO_TASK_ID: task.id,
      NADO_BATCH_ID: task.batchId || '',
      NADO_BATCH_KEY: task.batchKey || '',
      NADO_BATCH_DEPENDS_ON: (task.dependencyKeys || []).join(','),
      NADO_SESSION_ID: task.sessionId || '',
      NADO_WORKER_ID: options.workerId,
      NADO_WORKSPACE: workspace,
      NADO_AGENT_TRANSCRIPT: transcriptFile || '',
      NADO_HOSTNAME: os.hostname(),
      NADO_SANDBOX_PROFILE: task.sandboxProfile || 'default',
    }, task.sandboxProfile || 'default'),
    signal: options.signal,
    onOutput: options.onOutput,
  });

  if (task.type === 'agent') {
    await appendAgentTranscript({
      task,
      transcriptFile,
      prompt: originalAgentPrompt || '',
      result,
    });
  }

  return finish({
    status: result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  });
}
