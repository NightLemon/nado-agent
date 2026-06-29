import os from 'node:os';
import path from 'node:path';
import { NadoClient } from './http-client.js';
import { runTask } from './task-runner.js';
import { collectInventory } from './inventory.js';
import { sleep } from './utils.js';

function collectMetrics() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    loadavg: os.loadavg(),
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    uptime: os.uptime(),
    pid: process.pid,
  };
}

function normalizeConcurrency(value) {
  return Math.max(1, Number(value || 1));
}

export async function startWorker(options) {
  const client = options.client || new NadoClient({
    controlUrl: options.controlUrl,
    token: options.token,
    workerId: options.privateKeyPem ? options.id : null,
    privateKeyPem: options.privateKeyPem || null,
  });

  let inventory = await collectInventory(options.capabilities || []);
  const maxConcurrency = normalizeConcurrency(options.maxConcurrency);
  const worker = {
    id: options.id,
    name: options.name || options.id,
    host: os.hostname(),
    capabilities: inventory.inferredCapabilities,
    labels: options.labels || {},
    agentCommandConfigured: Boolean(options.agentCommand),
    agentPreset: options.agentPreset || null,
    maxConcurrency,
    inventory,
  };

  await client.registerWorker(worker);

  const emitLog = (type, message, details = {}) => {
    options.onLog?.(message);
    void client.addWorkerEvent(worker.id, {
      type,
      level: details.level || 'info',
      message,
      data: details.data,
    }).catch(() => {});
  };

  emitLog('registered', `registered ${worker.id} (${worker.capabilities.join(',') || 'no capabilities'}; maxConcurrency=${maxConcurrency})`, {
    data: {
      capabilities: worker.capabilities,
      labels: worker.labels,
      inventory,
      maxConcurrency,
    },
  });

  let stopped = false;
  let adminState = 'enabled';
  const runningTasks = new Map();

  const stop = () => {
    stopped = true;
    for (const running of runningTasks.values()) {
      running.controller.abort();
    }
  };

  const handleCommands = async (commands = []) => {
    for (const command of commands) {
      try {
        if (command.action === 'pause') {
          adminState = 'paused';
        } else if (command.action === 'resume') {
          adminState = 'enabled';
        } else if (command.action === 'drain') {
          adminState = 'draining';
        } else if (command.action === 'shutdown') {
          adminState = 'shutdown_requested';
          stopped = true;
        } else if (command.action === 'cancel_current') {
          if (command.taskId) {
            runningTasks.get(command.taskId)?.controller.abort();
          } else {
            for (const running of runningTasks.values()) {
              running.controller.abort();
            }
          }
        }
        await client.acknowledgeCommand(worker.id, command.id, 'completed', `applied ${command.action}`);
        emitLog('command_applied', `management command ${command.action} applied`, {
          data: {
            commandId: command.id,
            action: command.action,
            taskId: command.taskId || null,
          },
        });
      } catch (error) {
        await client.acknowledgeCommand(worker.id, command.id, 'failed', error.message);
        emitLog('command_failed', `management command ${command.action} failed: ${error.message}`, {
          level: 'error',
          data: {
            commandId: command.id,
            action: command.action,
          },
        });
      }
    }
  };

  const heartbeat = async () => {
    const currentTaskIds = [...runningTasks.keys()];
    const observedState = currentTaskIds.length ? 'running' : adminState === 'enabled' ? 'idle' : adminState;
    const result = await client.heartbeat(worker.id, {
      observedState,
      currentTaskId: currentTaskIds[0] || null,
      currentTaskIds,
      maxConcurrency,
      metrics: collectMetrics(),
      inventory,
    });
    adminState = result.worker.adminState || adminState;
    await handleCommands(result.commands);
    return result.worker;
  };

  const startClaimedTask = (task) => {
    const controller = new AbortController();
    runningTasks.set(task.id, { task, controller });
    emitLog('task_claimed', `claimed ${task.id}: ${task.title}`, {
      data: {
        taskId: task.id,
        attemptId: task.currentAttemptId,
      },
    });

    const promise = (async () => {
      try {
        await client.addTaskEvent(task.id, {
          type: 'started',
          message: `Worker ${worker.id} started task`,
          workerId: worker.id,
          attemptId: task.currentAttemptId,
        });

        const result = await runTask(task, {
          dataDir: options.dataDir || path.resolve('.nado'),
          workerId: worker.id,
          agentCommand: options.agentCommand,
          cleanupWorkspaces: Boolean(options.cleanupWorkspaces),
          signal: controller.signal,
          onOutput: (stream, text) => client.addTaskEvent(task.id, {
            type: stream,
            message: text,
            workerId: worker.id,
            attemptId: task.currentAttemptId,
            data: {
              stream,
            },
          }),
        });

        await client.completeTask(task.id, {
          ...result,
          attemptId: task.currentAttemptId,
        });
        emitLog('task_completed', `completed ${task.id}: ${result.status}`, {
          level: result.status === 'succeeded' ? 'info' : 'error',
          data: {
            taskId: task.id,
            status: result.status,
            exitCode: result.exitCode,
            attemptId: task.currentAttemptId,
          },
        });
      } catch (error) {
        await client.completeTask(task.id, {
          attemptId: task.currentAttemptId,
          status: 'failed',
          exitCode: 1,
          stdout: '',
          stderr: '',
          error: error.message,
        });
        emitLog('task_failed', `failed ${task.id}: ${error.message}`, {
          level: 'error',
          data: {
            taskId: task.id,
            attemptId: task.currentAttemptId,
          },
        });
      } finally {
        runningTasks.delete(task.id);
      }
    })();
    runningTasks.set(task.id, { task, controller, promise });
    return promise;
  };

  const loop = async () => {
    while (!stopped) {
      try {
        await heartbeat();

        const canClaim = adminState === 'enabled' && runningTasks.size < maxConcurrency;
        if (canClaim && Date.now() - Date.parse(inventory.collectedAt) > 60_000) {
          inventory = await collectInventory(options.capabilities || []);
        }
        while (adminState === 'enabled' && runningTasks.size < maxConcurrency) {
          if (Date.now() - Date.parse(inventory.collectedAt) > 60_000) {
            inventory = await collectInventory(options.capabilities || []);
          }
          const { task } = await client.claimTask(worker.id);
          if (task) {
            startClaimedTask(task);
          } else if (options.once) {
            break;
          } else {
            break;
          }
        }

        if (options.once && runningTasks.size === 0) {
          break;
        }

        await sleep(options.pollMs || 2_000);
      } catch (error) {
        emitLog('worker_error', `worker error: ${error.message}`, { level: 'error' });
        if (options.once) {
          throw error;
        }
        await sleep(options.pollMs || 2_000);
      }
    }
    await Promise.allSettled([...runningTasks.values()].map((running) => running.promise));
    emitLog('stopped', `worker ${worker.id} stopped`);
  };

  const done = loop();
  return { stop, done };
}
