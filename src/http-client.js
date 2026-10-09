import crypto from 'node:crypto';
import { normalizeBaseUrl } from './utils.js';

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== false) {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function parseContentDispositionFileName(value = '') {
  const text = String(value || '');
  const encoded = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  const quoted = text.match(/filename="([^"]+)"/i);
  if (quoted) {
    return quoted[1];
  }
  return null;
}

function retryAfterMs(response) {
  const value = String(response.headers.get('retry-after') || '').trim();
  if (!value) {
    return 1_000;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1_000));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 1_000;
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new Error('Request aborted'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Request aborted'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class NadoClient {
  constructor({ controlUrl, token, workerId = null, privateKeyPem = null, defaultHeaders = {}, now = null }) {
    this.controlUrl = normalizeBaseUrl(controlUrl);
    this.token = token;
    this.workerId = workerId;
    this.privateKeyPem = privateKeyPem;
    this.defaultHeaders = { ...defaultHeaders };
    this.now = typeof now === 'function' ? now : Date.now;
  }

  async fetchWithRateLimitRetry(method, path, createInit, options = {}) {
    const safeMethod = ['GET', 'HEAD'].includes(String(method || '').toUpperCase());
    const maxRetries = safeMethod
      ? Math.max(0, Math.min(5, Math.floor(Number(options.rateLimitRetries ?? 2))))
      : 0;
    for (let attempt = 0; ; attempt += 1) {
      const init = createInit();
      const response = await fetch(`${this.controlUrl}${path}`, init);
      if (response.status !== 429 || attempt >= maxRetries) {
        return response;
      }
      const delayMs = Math.min(60_000, retryAfterMs(response));
      await response.arrayBuffer().catch(() => {});
      await waitForRetry(delayMs, init.signal);
    }
  }

  signingHeaders(method, path, bodyText = '') {
    if (!this.workerId || !this.privateKeyPem) {
      return {};
    }
    const bodyHash = crypto.createHash('sha256').update(bodyText).digest('hex');
    const timestamp = String(this.now());
    const nonce = crypto.randomBytes(12).toString('hex');
    const canonical = [
      String(method || 'GET').toUpperCase(),
      path,
      bodyHash,
      timestamp,
      nonce,
      this.workerId,
    ].join('\n');
    const signature = crypto.sign(
      null,
      Buffer.from(canonical),
      crypto.createPrivateKey(this.privateKeyPem),
    ).toString('base64');
    return {
      'x-nado-worker-id': this.workerId,
      'x-nado-signature-alg': 'ed25519',
      'x-nado-timestamp': timestamp,
      'x-nado-nonce': nonce,
      'x-nado-body-sha256': bodyHash,
      'x-nado-signature': signature,
    };
  }

  async request(method, path, body, options = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      ...this.defaultHeaders,
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response;
    try {
      response = await this.fetchWithRateLimitRetry(method, path, () => ({
        method,
        headers: {
          ...headers,
          ...this.signingHeaders(method, path, payload || ''),
        },
        body: payload,
        signal: options.signal,
      }), options);
    } catch (cause) {
      const error = new Error(`${method} ${path} failed: ${cause.message}`);
      error.method = method;
      error.path = path;
      error.controlUrl = this.controlUrl;
      error.cause = cause;
      throw error;
    }

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const detail = data?.error ? `: ${data.error}` : '';
      const error = new Error(`${method} ${path} failed with ${response.status}${detail}`);
      error.method = method;
      error.path = path;
      error.controlUrl = this.controlUrl;
      error.status = response.status;
      error.response = data;
      error.details = data?.details || null;
      error.expectedOffset = data?.expectedOffset;
      if (data?.dispatchPlan) {
        error.dispatchPlan = data.dispatchPlan;
      }
      if (data?.nextActions) {
        error.nextActions = data.nextActions;
      }
      throw error;
    }
    return data;
  }

  async requestText(method, path, options = {}) {
    const response = await this.fetchWithRateLimitRetry(method, path, () => ({
      method,
      headers: {
        accept: 'text/plain, text/markdown',
        authorization: `Bearer ${this.token}`,
        ...this.signingHeaders(method, path, ''),
      },
      signal: options.signal,
    }), options);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}${text ? `: ${text}` : ''}`);
    }
    return text;
  }

  async requestBinary(method, path, body, options = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      accept: 'application/octet-stream, application/zip',
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.fetchWithRateLimitRetry(method, path, () => ({
      method,
      headers: {
        ...headers,
        ...this.signingHeaders(method, path, payload || ''),
      },
      body: payload,
      signal: options.signal,
    }), options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${path} failed with ${response.status}${text ? `: ${text}` : ''}`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      fileName: parseContentDispositionFileName(response.headers.get('content-disposition')),
      artifact: {
        id: response.headers.get('x-nado-artifact-id') || null,
        path: decodeURIComponent(response.headers.get('x-nado-artifact-path') || ''),
        sha256: response.headers.get('x-nado-artifact-sha256') || null,
        size: response.headers.get('x-nado-artifact-size')
          ? Number(response.headers.get('x-nado-artifact-size'))
          : null,
      },
      workerToken: response.headers.get('x-nado-worker-token-id')
        ? {
          id: response.headers.get('x-nado-worker-token-id'),
          workerId: response.headers.get('x-nado-worker-token-worker-id'),
          tokenPreview: response.headers.get('x-nado-worker-token-preview'),
        }
        : null,
      enrollmentToken: response.headers.get('x-nado-worker-enrollment-token-id')
        ? {
          id: response.headers.get('x-nado-worker-enrollment-token-id'),
          tokenPreview: response.headers.get('x-nado-worker-enrollment-token-preview'),
        }
        : null,
    };
  }

  async requestRaw(method, path, body, extraHeaders = {}, options = {}) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
      ...extraHeaders,
      ...this.signingHeaders(method, path, payload),
    };
    let response;
    try {
      response = await fetch(`${this.controlUrl}${path}`, {
        method,
        headers,
        body: payload,
        signal: options.signal,
      });
    } catch (cause) {
      const error = new Error(`${method} ${path} failed: ${cause.message}`);
      error.method = method;
      error.path = path;
      error.controlUrl = this.controlUrl;
      error.cause = cause;
      throw error;
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text ? { error: text } : null;
    }
    if (!response.ok) {
      const detail = data?.error ? `: ${data.error}` : '';
      const error = new Error(`${method} ${path} failed with ${response.status}${detail}`);
      error.method = method;
      error.path = path;
      error.controlUrl = this.controlUrl;
      error.status = response.status;
      error.response = data;
      error.expectedOffset = data?.expectedOffset;
      throw error;
    }
    return data;
  }

  async downloadWorkerNetworkProbe(workerId, bytes, options = {}) {
    const path = `/api/workers/${encodeURIComponent(workerId)}/network-probe/download?bytes=${encodeURIComponent(bytes)}`;
    const startedAt = performance.now();
    const response = await fetch(`${this.controlUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/octet-stream',
        authorization: `Bearer ${this.token}`,
        ...this.signingHeaders('GET', path, ''),
      },
      signal: AbortSignal.timeout(Math.max(1_000, Number(options.timeoutMs || 10_000))),
    });
    const payload = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const text = payload.toString('utf8');
      let detail = text;
      try {
        detail = JSON.parse(text)?.error || text;
      } catch {
        // Keep the raw response when a proxy returns non-JSON diagnostics.
      }
      const error = new Error(`GET ${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    const expectedBytes = Number(response.headers.get('x-nado-probe-bytes') || bytes);
    const expectedSha256 = response.headers.get('x-nado-probe-sha256') || '';
    const actualSha256 = crypto.createHash('sha256').update(payload).digest('hex');
    if (payload.length !== expectedBytes || expectedSha256 !== actualSha256) {
      throw new Error('Network download probe integrity check failed');
    }
    return {
      bytes: payload.length,
      sha256: actualSha256,
      durationMs: Math.max(0.1, performance.now() - startedAt),
    };
  }

  async uploadWorkerNetworkProbe(workerId, bytes, options = {}) {
    const path = `/api/workers/${encodeURIComponent(workerId)}/network-probe/upload`;
    const payload = crypto.randomBytes(Number(bytes));
    const expectedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
    const startedAt = performance.now();
    const result = await this.requestRaw('POST', path, payload, {}, {
      signal: AbortSignal.timeout(Math.max(1_000, Number(options.timeoutMs || 10_000))),
    });
    if (Number(result.bytes) !== payload.length || result.sha256 !== expectedSha256) {
      throw new Error('Network upload probe integrity check failed');
    }
    return {
      bytes: payload.length,
      sha256: expectedSha256,
      durationMs: Math.max(0.1, performance.now() - startedAt),
    };
  }

  async *streamSse(path, options = {}) {
    const response = await fetch(`${this.controlUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${this.token}`,
        ...this.signingHeaders('GET', path, ''),
      },
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GET ${path} failed with ${response.status}${text ? `: ${text}` : ''}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        const parsed = this.parseSseBlock(part);
        if (parsed) {
          yield parsed;
        }
      }
    }
    buffer += decoder.decode();
    const parsed = this.parseSseBlock(buffer);
    if (parsed) {
      yield parsed;
    }
  }

  parseSseBlock(block) {
    const text = String(block || '').trim();
    if (!text || text.startsWith(':')) {
      return null;
    }
    const parsed = {
      event: 'message',
      id: null,
      data: '',
    };
    const data = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') {
        parsed.event = value || 'message';
      } else if (field === 'id') {
        parsed.id = value;
      } else if (field === 'data') {
        data.push(value);
      }
    }
    if (!data.length) {
      return parsed;
    }
    const body = data.join('\n');
    try {
      parsed.data = JSON.parse(body);
    } catch {
      parsed.data = body;
    }
    return parsed;
  }

  health(options = {}) {
    return fetch(`${this.controlUrl}/health`, { signal: options.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) {
        throw new Error(`health failed with ${response.status}`);
      }
      return data;
    });
  }

  registerWorker(worker) {
    return this.request('POST', '/api/workers/register', worker);
  }

  status() {
    return this.request('GET', '/api/status');
  }

  listAuditEvents(options = {}) {
    return this.request('GET', `/api/audit${queryString({
      tail: options.tail,
      actorType: options.actorType,
      outcome: options.outcome,
      statusCode: options.statusCode,
    })}`);
  }

  exportAuditEvents(options = {}) {
    return this.requestText('GET', `/api/audit/export${queryString({ tail: options.tail })}`);
  }

  capabilities() {
    return this.request('GET', '/api/capabilities');
  }

  networkInfo(options = {}) {
    return this.request('GET', '/api/network', undefined, options);
  }

  context() {
    return this.requestText('GET', '/api/context');
  }

  mcpConfig(options = {}) {
    const params = new URLSearchParams();
    if (options.name) {
      params.set('name', options.name);
    }
    if (options.format) {
      params.set('format', options.format);
    }
    const suffix = params.toString() ? `?${params}` : '';
    return options.format === 'command'
      ? this.requestText('GET', `/api/mcp-config${suffix}`)
      : this.request('GET', `/api/mcp-config${suffix}`);
  }

  doctor(options = {}) {
    return this.request('POST', '/api/doctor', options);
  }

  verify(options = {}) {
    return this.request('POST', '/api/verify', options);
  }

  acceptanceTemplate() {
    return this.request('GET', '/api/acceptance/template');
  }

  acceptanceRunbook(options = {}) {
    return this.request('GET', `/api/acceptance/runbook${queryString({
      workerId: options.workerId,
      deploymentMode: options.deploymentMode,
      overlayInterface: options.overlayInterface,
      requireGpu: options.requireGpu,
      requireAgent: options.requireAgent === false ? 'false' : undefined,
    })}`);
  }

  recordAcceptanceEvidence(document, record) {
    return this.request('POST', '/api/acceptance/evidence/record', {
      document,
      record,
    });
  }

  acceptanceReport(options = {}) {
    return this.request('POST', '/api/acceptance/report', options);
  }

  demoHealth(options = {}) {
    return this.request('POST', '/api/demo/health', options);
  }

  heartbeat(workerId, state = {}) {
    return this.request('POST', `/api/workers/${encodeURIComponent(workerId)}/heartbeat`, state);
  }

  listWorkers() {
    return this.request('GET', '/api/workers');
  }

  createWorkerToken(options) {
    return this.request('POST', '/api/worker-tokens', options);
  }

  createWorkerEnrollmentToken(options = {}) {
    return this.request('POST', '/api/worker-enrollment-tokens', options);
  }

  listWorkerEnrollmentTokens() {
    return this.request('GET', '/api/worker-enrollment-tokens');
  }

  revokeWorkerEnrollmentToken(tokenId) {
    return this.request('POST', `/api/worker-enrollment-tokens/${encodeURIComponent(tokenId)}/revoke`, {});
  }

  previewWorkerEnrollmentTokenPrune() {
    return this.request('GET', '/api/worker-enrollment-tokens/prune');
  }

  pruneWorkerEnrollmentTokens() {
    return this.request('POST', '/api/worker-enrollment-tokens/prune', {});
  }

  listWorkerTokens(options = {}) {
    return this.request(
      'GET',
      `/api/worker-tokens${queryString({ workerId: options.workerId })}`,
    );
  }

  downloadWorkerBundle(options = {}) {
    return this.requestBinary('POST', '/api/workers/bundle', options);
  }

  downloadWorkerBootstrapBundle(options = {}) {
    return this.requestBinary('POST', '/api/workers/bootstrap-bundle', options);
  }

  enrollWorker(options = {}) {
    return this.request('POST', '/api/workers/enroll', options);
  }

  revokeWorkerToken(tokenId) {
    return this.request('POST', `/api/worker-tokens/${encodeURIComponent(tokenId)}/revoke`, {});
  }

  prepareWorkerTokenRotation(workerId, token, options = {}) {
    return this.request(
      'POST',
      `/api/workers/${encodeURIComponent(workerId)}/token/rotation/prepare`,
      {
        token,
        ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}),
      },
    );
  }

  confirmWorkerTokenRotation(workerId) {
    return this.request(
      'POST',
      `/api/workers/${encodeURIComponent(workerId)}/token/rotation/confirm`,
      {},
    );
  }

  getWorker(workerId) {
    return this.request('GET', `/api/workers/${encodeURIComponent(workerId)}`);
  }

  workerPreflight(workerId) {
    return this.request('GET', `/api/workers/${encodeURIComponent(workerId)}/preflight`);
  }

  listWorkerEvents(workerId, options = {}) {
    return this.request(
      'GET',
      `/api/workers/${encodeURIComponent(workerId)}/events${queryString({ tail: options.tail })}`,
    );
  }

  addWorkerEvent(workerId, event = {}) {
    return this.request('POST', `/api/workers/${encodeURIComponent(workerId)}/events`, event);
  }

  manageWorker(workerId, action, reason = '') {
    return this.request('POST', `/api/workers/${encodeURIComponent(workerId)}/manage`, {
      action,
      reason,
    });
  }

  forgetWorker(workerId, reason = '') {
    return this.request('POST', `/api/workers/${encodeURIComponent(workerId)}/forget`, {
      reason,
    });
  }

  acknowledgeCommand(workerId, commandId, status = 'completed', message = '', result = null) {
    return this.request(
      'POST',
      `/api/workers/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(commandId)}/ack`,
      { status, message, result },
    );
  }

  claimTask(workerId, options = {}) {
    const waitMs = Math.max(0, Math.floor(Number(options.waitMs || 0)));
    const path = `/api/workers/${encodeURIComponent(workerId)}/claim${queryString({ waitMs: waitMs || undefined })}`;
    return this.request('POST', path, {}, { signal: options.signal });
  }

  createTask(task) {
    return this.request('POST', '/api/tasks', task);
  }

  createBatch(batch) {
    return this.request('POST', '/api/batches', batch);
  }

  planBatch(options) {
    return this.request('POST', '/api/batches/plan', options);
  }

  planDispatch(options) {
    return this.request('POST', '/api/dispatch/plan', options);
  }

  planDistributedTask(options) {
    return this.request('POST', '/api/planner/plan', options);
  }

  runDistributedTaskPlan(options) {
    return this.request('POST', '/api/planner/run', options);
  }

  createSession(session) {
    return this.request('POST', '/api/sessions', session);
  }

  listSessions() {
    return this.request('GET', '/api/sessions');
  }

  previewEmptySessions(options = {}) {
    return this.request('GET', `/api/sessions/prune-empty${queryString({ sessionId: options.sessionId })}`);
  }

  pruneEmptySessions(options = {}) {
    return this.request('POST', '/api/sessions/prune-empty', options);
  }

  getSession(sessionId) {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  listSessionArtifacts(sessionId, options = {}) {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  getSessionArtifacts(sessionId, options = {}) {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/content${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  downloadSessionArtifactsZip(sessionId, options = {}) {
    return this.requestBinary(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/download${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  closeSession(sessionId) {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/close`, {});
  }

  listTasks() {
    return this.request('GET', '/api/tasks');
  }

  previewTaskPrune(options = {}) {
    return this.request('GET', `/api/tasks/prune${queryString({ keep: options.keep })}`);
  }

  pruneTaskHistory(options = {}) {
    return this.request('POST', '/api/tasks/prune', options);
  }

  previewSystemHistoryPrune() {
    return this.request('GET', '/api/system-history/prune');
  }

  pruneSystemHistory() {
    return this.request('POST', '/api/system-history/prune', {});
  }

  listBatches() {
    return this.request('GET', '/api/batches');
  }

  getBatch(batchId) {
    return this.request('GET', `/api/batches/${encodeURIComponent(batchId)}`);
  }

  listBatchArtifacts(batchId, options = {}) {
    return this.request(
      'GET',
      `/api/batches/${encodeURIComponent(batchId)}/artifacts${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  getBatchArtifacts(batchId, options = {}) {
    return this.request(
      'GET',
      `/api/batches/${encodeURIComponent(batchId)}/artifacts/content${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  downloadBatchArtifactsZip(batchId, options = {}) {
    return this.requestBinary(
      'GET',
      `/api/batches/${encodeURIComponent(batchId)}/artifacts/download${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  getBatchReport(batchId, options = {}) {
    return this.request(
      'GET',
      `/api/batches/${encodeURIComponent(batchId)}/report${queryString({
        stdoutChars: options.stdoutChars,
        stderrChars: options.stderrChars,
      })}`,
    );
  }

  listBatchEvents(batchId) {
    return this.request('GET', `/api/batches/${encodeURIComponent(batchId)}/events`);
  }

  streamBatchEvents(batchId, options = {}) {
    return this.streamSse(
      `/api/batches/${encodeURIComponent(batchId)}/events/stream${queryString({
        cursor: options.cursor,
      })}`,
      options,
    );
  }

  manageBatch(batchId, action, options = {}) {
    return this.request('POST', `/api/batches/${encodeURIComponent(batchId)}/manage`, {
      ...options,
      action,
    });
  }

  listOfflineRunningTasks(workerId = '') {
    const query = workerId ? `?workerId=${encodeURIComponent(workerId)}` : '';
    return this.request('GET', `/api/recovery/offline-tasks${query}`);
  }

  recoverOfflineTasks(options = {}) {
    return this.request('POST', '/api/recovery/offline-tasks', options);
  }

  getTask(taskId) {
    return this.request('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  explainSchedule(taskId) {
    return this.request('GET', `/api/tasks/${encodeURIComponent(taskId)}/schedule`);
  }

  listTaskEvents(taskId, options = {}) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/events${queryString({ tail: options.tail })}`,
    );
  }

  streamTaskEvents(taskId, options = {}) {
    return this.streamSse(
      `/api/tasks/${encodeURIComponent(taskId)}/events/stream${queryString({
        cursor: options.cursor,
      })}`,
      options,
    );
  }

  manageTask(taskId, action, options = {}) {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/manage`, {
      ...options,
      action,
    });
  }

  getTaskInputUpload(taskId, uploadId) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/input-uploads/${encodeURIComponent(uploadId)}`,
    );
  }

  uploadTaskInputChunk(taskId, uploadId, offset, bytes) {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/input-uploads/${encodeURIComponent(uploadId)}/chunks${queryString({ offset })}`;
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.requestRaw('PATCH', path, chunk, {
      'x-nado-chunk-sha256': crypto.createHash('sha256').update(chunk).digest('hex'),
    });
  }

  finalizeTaskInputUpload(taskId, uploadId) {
    return this.request(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/input-uploads/${encodeURIComponent(uploadId)}/finalize`,
      {},
    );
  }

  async streamTaskInput(taskId, inputId, attemptId, offset = 0, options = {}) {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/inputs/${encodeURIComponent(inputId)}/download`;
    let response;
    try {
      response = await fetch(`${this.controlUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/octet-stream',
          authorization: `Bearer ${this.token}`,
          range: `bytes=${Math.max(0, Number(offset || 0))}-`,
          'x-nado-attempt-id': attemptId,
          ...this.signingHeaders('GET', path, ''),
        },
        signal: options.signal,
      });
    } catch (cause) {
      const error = new Error(`GET ${path} failed: ${cause.message}`);
      error.method = 'GET';
      error.path = path;
      error.controlUrl = this.controlUrl;
      error.cause = cause;
      throw error;
    }
    if (!response.ok) {
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text ? { error: text } : null;
      }
      const error = new Error(`GET ${path} failed with ${response.status}${data?.error ? `: ${data.error}` : ''}`);
      error.status = response.status;
      error.response = data;
      throw error;
    }
    return {
      body: response.body,
      status: response.status,
      range: response.headers.get('content-range'),
      size: Number(response.headers.get('x-nado-input-size') || 0),
      sha256: response.headers.get('x-nado-input-sha256') || null,
      path: decodeURIComponent(response.headers.get('x-nado-input-path') || ''),
    };
  }

  listArtifacts(taskId) {
    return this.listTaskArtifacts(taskId);
  }

  listTaskArtifacts(taskId, options = {}) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  getArtifact(taskId, artifactId) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`,
    );
  }

  downloadArtifact(taskId, artifactId) {
    return this.requestBinary(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    );
  }

  getTaskArtifacts(taskId, options = {}) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/content${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  downloadTaskArtifactsZip(taskId, options = {}) {
    return this.requestBinary(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts/download${queryString({
        includeSkipped: options.includeSkipped ? 'true' : undefined,
      })}`,
    );
  }

  addTaskEvent(taskId, event) {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/events`, event);
  }

  recordShortDisconnectObservation(taskId, observation) {
    return this.request(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/acceptance-observations/short-disconnect`,
      observation,
    );
  }

  createArtifactUpload(taskId, artifact, attemptId) {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/artifact-uploads`, {
      path: artifact.path,
      size: artifact.size,
      sha256: artifact.sha256,
      attemptId,
    });
  }

  listArtifactUploads(taskId) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifact-uploads`,
    );
  }

  getArtifactUpload(taskId, uploadId, attemptId) {
    return this.request(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifact-uploads/${encodeURIComponent(uploadId)}${queryString({ attemptId })}`,
    );
  }

  uploadArtifactChunk(taskId, uploadId, attemptId, offset, bytes) {
    const path = `/api/tasks/${encodeURIComponent(taskId)}/artifact-uploads/${encodeURIComponent(uploadId)}/chunks${queryString({ offset })}`;
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.requestRaw('PATCH', path, chunk, {
      'x-nado-attempt-id': attemptId,
      'x-nado-chunk-sha256': crypto.createHash('sha256').update(chunk).digest('hex'),
    });
  }

  finalizeArtifactUpload(taskId, uploadId, attemptId) {
    return this.request(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/artifact-uploads/${encodeURIComponent(uploadId)}/finalize`,
      { attemptId },
    );
  }

  completeTask(taskId, result) {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/result`, result);
  }
}
