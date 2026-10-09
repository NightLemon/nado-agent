import fs from 'node:fs/promises';
import path from 'node:path';

function errorCode(error) {
  return String(error?.code || error?.name || 'audit_sink_write_failed').slice(0, 80);
}

export function createAuditNdjsonSink(options = {}) {
  const configuredFile = String(options.file || '').trim();
  const file = configuredFile ? path.resolve(configuredFile) : null;
  const maxPendingWrites = Math.max(1, Math.min(100_000, Number(options.maxPendingWrites ?? 1_024) || 1_024));
  const appendLine = options.appendLine || (async (target, line) => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, line, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') {
      await fs.chmod(target, 0o600);
    }
  });
  let tail = Promise.resolve();
  let closed = false;
  const state = {
    writtenEvents: 0,
    failedEvents: 0,
    droppedEvents: 0,
    pendingWrites: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastOperationSucceeded: true,
  };

  const summary = () => ({
    enabled: Boolean(file),
    type: file ? 'ndjson_file' : null,
    state: !file ? 'disabled' : state.lastOperationSucceeded ? 'healthy' : 'degraded',
    deliveryIntegrity: !file ? 'disabled' : state.failedEvents || state.droppedEvents ? 'incomplete' : 'complete',
    writtenEvents: state.writtenEvents,
    failedEvents: state.failedEvents,
    droppedEvents: state.droppedEvents,
    pendingWrites: state.pendingWrites,
    maxPendingWrites,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorAt: state.lastErrorAt,
    lastErrorCode: state.lastErrorCode,
    pathExposed: false,
  });

  const write = (event) => {
    if (!file) {
      return Promise.resolve({ written: false, reason: 'disabled' });
    }
    if (closed) {
      return Promise.reject(Object.assign(new Error('Audit sink is closed'), { code: 'AUDIT_SINK_CLOSED' }));
    }
    if (state.pendingWrites >= maxPendingWrites) {
      const error = Object.assign(new Error('Audit sink queue is full'), { code: 'AUDIT_SINK_QUEUE_FULL' });
      state.droppedEvents += 1;
      state.lastErrorAt = new Date().toISOString();
      state.lastErrorCode = error.code;
      state.lastOperationSucceeded = false;
      return Promise.reject(error);
    }
    state.pendingWrites += 1;
    const operation = tail.catch(() => {}).then(async () => {
      try {
        await appendLine(file, `${JSON.stringify(event)}\n`);
        state.writtenEvents += 1;
        state.lastSuccessAt = new Date().toISOString();
        state.lastOperationSucceeded = true;
        state.lastErrorCode = null;
        return { written: true };
      } catch (error) {
        state.failedEvents += 1;
        state.lastErrorAt = new Date().toISOString();
        state.lastErrorCode = errorCode(error);
        state.lastOperationSucceeded = false;
        throw error;
      } finally {
        state.pendingWrites -= 1;
      }
    });
    tail = operation;
    return operation;
  };

  const close = async () => {
    closed = true;
    await tail.catch(() => {});
  };

  return { write, close, summary };
}
