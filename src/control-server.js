import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createStore } from './store.js';
import { dashboardHtml } from './dashboard.js';
import { batchEventRows } from './batch-events.js';
import { buildAgentContext } from './context.js';
import { runDoctor } from './doctor.js';
import { runVerify } from './verify.js';
import { NadoClient } from './http-client.js';
import { buildMcpClientConfig, formatMcpCommand } from './mcp-config.js';
import { buildWorkerBootstrapBundle, buildWorkerBundle } from './worker-bundle.js';
import { buildBatchPlan } from './batch-plan.js';
import { buildDispatchPlan } from './dispatch-plan.js';
import { controlUrlFromHostPort, ensureDir, normalizeBaseUrl, originFromHostHeader, safeName } from './utils.js';
import { buildZipArchive, safeZipPath } from './zip.js';
import { buildGatewayCapabilities } from './capabilities.js';
import { buildNetworkInfo } from './network-info.js';
import { buildDemoRouteChecks, demoRouteChecksOk } from './demo-health.js';

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const expectedBodyHash = request.headers['x-nado-body-sha256'];
  if (expectedBodyHash) {
    const actualBodyHash = crypto.createHash('sha256').update(text).digest('hex');
    if (actualBodyHash !== expectedBodyHash) {
      const error = new Error('Signed worker request body hash mismatch');
      error.status = 401;
      throw error;
    }
  }
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
}

function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function artifactFileName(artifact) {
  return String(artifact.path || artifact.id || 'artifact.bin')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || 'artifact.bin';
}

function contentDispositionFileName(fileName) {
  return String(fileName || 'artifact.bin')
    .replace(/[\r\n"]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_');
}

function sendArtifactBytes(response, artifact, bytes) {
  const fileName = artifactFileName(artifact);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${contentDispositionFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'x-nado-artifact-id': artifact.id,
    'x-nado-artifact-path': encodeURIComponent(artifact.path || fileName),
    'x-nado-artifact-sha256': artifact.sha256 || '',
    'x-nado-artifact-size': String(artifact.size || bytes.length),
  });
  response.end(bytes);
}

function sendZipBytes(response, fileName, bytes) {
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${contentDispositionFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  response.end(bytes);
}

function sendWorkerBundleBytes(response, fileName, bytes, issuedWorkerToken = null) {
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': bytes.length,
    'content-disposition': `attachment; filename="${contentDispositionFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    ...(issuedWorkerToken ? {
      'x-nado-worker-token-id': issuedWorkerToken.id,
      'x-nado-worker-token-worker-id': issuedWorkerToken.workerId,
      'x-nado-worker-token-preview': issuedWorkerToken.tokenPreview,
    } : {}),
  });
  response.end(bytes);
}

async function buildBatchArtifactZip(store, batchId, options = {}) {
  const listed = store.listBatchArtifacts(batchId, options);
  const files = [];
  for (const child of listed.tasks || []) {
    const prefix = child.batchKey || child.taskId;
    for (const artifact of child.artifacts || []) {
      if (artifact.skipped) {
        continue;
      }
      const fetched = await store.readArtifactBytes(child.taskId, artifact.id);
      files.push({
        name: safeZipPath(prefix, fetched.artifact.path || fetched.artifact.id),
        bytes: fetched.bytes,
      });
    }
  }
  return {
    batch: listed.batch,
    totalArtifacts: files.length,
    bytes: buildZipArchive(files),
  };
}

async function buildSessionArtifactZip(store, sessionId, options = {}) {
  const listed = store.listSessionArtifacts(sessionId, options);
  const files = [];
  for (const artifact of listed.artifacts || []) {
    if (artifact.skipped) {
      continue;
    }
    const fetched = await store.readArtifactBytes(listed.sourceTaskId, artifact.id);
    files.push({
      name: safeZipPath(fetched.artifact.path || fetched.artifact.id),
      bytes: fetched.bytes,
    });
  }
  return {
    session: listed.session,
    sourceTaskId: listed.sourceTaskId,
    totalArtifacts: files.length,
    bytes: buildZipArchive(files),
  };
}

async function buildTaskArtifactZip(store, taskId, options = {}) {
  const includeSkipped = Boolean(options.includeSkipped);
  const artifacts = store.listArtifacts(taskId)
    .filter((artifact) => includeSkipped || !artifact.skipped);
  const files = [];
  for (const artifact of artifacts) {
    if (artifact.skipped) {
      continue;
    }
    const fetched = await store.readArtifactBytes(taskId, artifact.id);
    files.push({
      name: safeZipPath(fetched.artifact.path || fetched.artifact.id),
      bytes: fetched.bytes,
    });
  }
  return {
    task: store.getTask(taskId),
    totalArtifacts: files.length,
    bytes: buildZipArchive(files),
  };
}

function terminalTaskStatus(status) {
  return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function terminalBatchStatus(status) {
  return ['succeeded', 'completed_with_errors', 'cancelled'].includes(status);
}

function writeSse(response, { event = 'message', id, data }) {
  if (id !== undefined) {
    response.write(`id: ${id}\n`);
  }
  response.write(`event: ${event}\n`);
  const body = JSON.stringify(data ?? {});
  for (const line of body.split(/\r?\n/)) {
    response.write(`data: ${line}\n`);
  }
  response.write('\n');
}

function streamEventRows(request, response, options) {
  const intervalMs = Math.max(100, Number(options.intervalMs || 250));
  let closed = false;
  let sent = 0;
  let lastEventId = Number(options.lastEventId ?? -1);
  let replayCursorApplied = false;
  const seenKeys = new Set();

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(': connected\n\n');

  let timer;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (timer) {
      clearInterval(timer);
    }
    response.end();
  };

  const poll = () => {
    if (closed || response.destroyed) {
      close();
      return;
    }
    try {
      const snapshot = options.snapshot();
      const rows = snapshot.events || [];
      for (const [index, row] of rows.entries()) {
        const key = options.key(row, index);
        if (seenKeys.has(key) || (!replayCursorApplied && index <= lastEventId)) {
          seenKeys.add(key);
          continue;
        }
        seenKeys.add(key);
        lastEventId = index;
        writeSse(response, {
          event: 'event',
          id: index,
          data: {
            ...row,
            streamIndex: index,
            status: snapshot.status,
          },
        });
        sent += 1;
      }
      replayCursorApplied = true;
      if (options.terminal(snapshot.status)) {
        writeSse(response, {
          event: 'done',
          id: rows.length,
          data: {
            id: snapshot.id,
            status: snapshot.status,
            events: rows.length,
            sent,
          },
        });
        close();
      }
    } catch (error) {
      writeSse(response, {
        event: 'error',
        data: { error: error.message },
      });
      close();
    }
  };

  request.on('close', close);
  timer = setInterval(poll, intervalMs);
  poll();
}

function forbidden(message = 'Forbidden') {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function unauthorized(message = 'Unauthorized') {
  const error = new Error(message);
  error.status = 401;
  return error;
}

function parseBearer(request) {
  const header = request.headers.authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

function adminTokens(token) {
  return [
    token,
    process.env.NADO_ADMIN_TOKENS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function assertAuthed(request, token, store) {
  const tokens = adminTokens(token);
  if (!tokens.length) {
    return { type: 'admin' };
  }
  const bearer = parseBearer(request);
  if (bearer && tokens.some((candidate) => constantTimeEqual(bearer, candidate))) {
    return { type: 'admin' };
  }
  const workerPrincipal = store.authenticateWorkerToken(bearer);
  if (workerPrincipal) {
    return workerPrincipal;
  }
  const enrollmentPrincipal = store.authenticateWorkerEnrollmentToken(bearer);
  if (enrollmentPrincipal) {
    return enrollmentPrincipal;
  }
  {
    const error = new Error('Unauthorized');
    error.status = 401;
    throw error;
  }
}

function assertAdmin(principal) {
  if (principal.type !== 'admin') {
    throw forbidden('Worker tokens cannot call control-plane admin APIs');
  }
}

async function assertWorkerSelf(principal, workerId, request = null, store = null) {
  if (principal.type === 'admin') {
    return;
  }
  if (principal.type === 'worker' && principal.workerId === workerId) {
    if (request && store) {
      await assertSignedWorkerRequest(request, store, principal, workerId);
    }
    return;
  }
  throw forbidden(`Worker token is not valid for worker: ${workerId}`);
}

function requestPathForSignature(request) {
  const url = new URL(request.url, 'http://nado.local');
  return `${url.pathname}${url.search}`;
}

async function assertSignedWorkerRequest(request, store, principal, workerId) {
  if (principal.type !== 'worker') {
    return;
  }
  const workerToken = store.getWorkerToken(principal.workerTokenId);
  if (!workerToken?.publicKey) {
    return;
  }
  const signedWorkerId = request.headers['x-nado-worker-id'];
  const alg = request.headers['x-nado-signature-alg'];
  const bodyHash = request.headers['x-nado-body-sha256'];
  const timestamp = request.headers['x-nado-timestamp'];
  const nonce = request.headers['x-nado-nonce'];
  const signature = request.headers['x-nado-signature'];
  if (!signedWorkerId || !alg || !bodyHash || !timestamp || !nonce || !signature) {
    throw unauthorized('Signed worker request headers are required');
  }
  if (signedWorkerId !== workerId || signedWorkerId !== principal.workerId) {
    throw unauthorized('Signed worker id does not match token binding');
  }
  if (String(alg).toLowerCase() !== 'ed25519') {
    throw unauthorized('Unsupported worker signature algorithm');
  }
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
    throw unauthorized('Signed worker request timestamp is outside the allowed window');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(bodyHash))) {
    throw unauthorized('Signed worker request body hash is invalid');
  }
  const canonical = [
    request.method.toUpperCase(),
    requestPathForSignature(request),
    bodyHash,
    String(timestamp),
    String(nonce),
    workerId,
  ].join('\n');
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(canonical),
      crypto.createPublicKey(workerToken.publicKey),
      Buffer.from(String(signature), 'base64'),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw unauthorized('Worker request signature verification failed');
  }
  const freshNonce = await store.rememberWorkerRequestNonce(principal.workerTokenId, String(nonce), timestampMs);
  if (!freshNonce) {
    throw unauthorized('Signed worker request nonce has already been used');
  }
}

function assertEnrollment(principal) {
  if (principal.type !== 'worker_enrollment') {
    throw forbidden('Worker enrollment token is required');
  }
}

function autoWorkerId(requestedId = '') {
  const base = safeName(requestedId || `worker-${crypto.randomBytes(4).toString('hex')}`).replaceAll('/', '-');
  return base || `worker-${crypto.randomBytes(4).toString('hex')}`;
}

async function assertTaskWorker(store, principal, taskId, request = null) {
  if (principal.type === 'admin') {
    return;
  }
  const task = store.getTask(taskId);
  if (principal.type === 'worker' && task.assignedWorkerId === principal.workerId) {
    if (request) {
      await assertSignedWorkerRequest(request, store, principal, task.assignedWorkerId);
    }
    return;
  }
  throw forbidden(`Worker token cannot update task: ${taskId}`);
}

function parsePath(request) {
  const url = new URL(request.url, 'http://nado.local');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return { url, parts };
}

function trustProxyEnabled(options = {}) {
  return Boolean(options.trustProxy) || envBoolean('NADO_TRUST_PROXY');
}

function requestControlUrl(request, options = {}) {
  return buildNetworkInfo(request, {
    publicControlUrl: '',
    protocol: options.protocol || 'http',
    trustProxy: trustProxyEnabled(options),
  }).requestUrl || originFromHostHeader(request.headers.host || '127.0.0.1');
}

function configuredPublicControlUrl(options = {}) {
  return normalizeBaseUrl(options.publicControlUrl || process.env.NADO_PUBLIC_CONTROL_URL || '');
}

function externalControlUrl(request, options = {}) {
  return configuredPublicControlUrl(options) || requestControlUrl(request, options);
}

function networkInfoForRequest(request, options = {}, port = undefined) {
  return buildNetworkInfo(request, {
    host: options.host || null,
    port,
    publicControlUrl: configuredPublicControlUrl(options),
    interfaces: options.networkInterfaces,
    inContainer: options.inContainer,
    trustProxy: trustProxyEnabled(options),
  });
}

function workerBundleControlUrl(request, options = {}, body = {}, port = undefined) {
  if (body.controlUrl) {
    return body.controlUrl;
  }
  const network = networkInfoForRequest(request, options, port);
  return network.preferredRemoteControlUrl || externalControlUrl(request, options);
}

function internalControlUrl(request, options = {}) {
  if (options.internalControlUrl || process.env.NADO_INTERNAL_CONTROL_URL) {
    return options.internalControlUrl || process.env.NADO_INTERNAL_CONTROL_URL;
  }
  const host = options.host || request.socket?.localAddress || '127.0.0.1';
  const port = request.socket?.localPort || 8765;
  return controlUrlFromHostPort(host, port);
}

function queryList(url, name) {
  return url.searchParams.getAll(name)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function queryLabels(url) {
  const labels = {};
  for (const value of queryList(url, 'requiredLabel')) {
    const [key, ...rest] = value.split('=');
    if (key) {
      labels[key] = rest.join('=') || 'true';
    }
  }
  return labels;
}

function queryBoolean(url, name) {
  const value = url.searchParams.get(name);
  return value === '1' || value === 'true' || value === 'yes';
}

function envBoolean(name) {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

function dashboardBootstrapToken(options = {}) {
  if (!options.token) {
    return '';
  }
  return options.dashboardAutoToken || envBoolean('NADO_DASHBOARD_AUTO_TOKEN')
    ? options.token
    : '';
}

function defaultEnrollmentExpiresAt(value) {
  return value || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function doctorOptionsFromQuery(url) {
  return {
    selfTest: queryBoolean(url, 'selfTest'),
    agentSelfTest: queryBoolean(url, 'agentSelfTest'),
    allWorkers: queryBoolean(url, 'allWorkers'),
    workerId: url.searchParams.get('workerId') || undefined,
    requiredCapabilities: queryList(url, 'capability'),
    requiredTools: queryList(url, 'tool'),
    requiredLabels: queryLabels(url),
    timeoutMs: url.searchParams.get('timeoutMs') ? Number(url.searchParams.get('timeoutMs')) : undefined,
  };
}

export async function createControlServer(options) {
  const dataDir = options.dataDir || path.resolve('.nado');
  await ensureDir(dataDir);

  const store = options.store || createStore({
    dataDir,
    backend: options.storeBackend,
    file: options.storeFile,
  });
  await store.load();

  const server = http.createServer(async (request, response) => {
    try {
      const { url, parts } = parsePath(request);

      if (request.method === 'GET' && parts.join('/') === 'health') {
        sendJson(response, 200, { ok: true, service: 'nado-control' });
        return;
      }

      if (request.method === 'GET' && (!parts.length || parts.join('/') === 'dashboard')) {
        sendHtml(response, 200, dashboardHtml({
          bootstrapToken: dashboardBootstrapToken(options),
        }));
        return;
      }

      if (parts[0] !== 'api') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }

      const principal = assertAuthed(request, options.token, store);

      if (request.method === 'GET' && parts.join('/') === 'api/status') {
        assertAdmin(principal);
        sendJson(response, 200, store.getStatusSnapshot());
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/capabilities') {
        assertAdmin(principal);
        sendJson(response, 200, buildGatewayCapabilities({
          controlUrl: externalControlUrl(request, options),
          workers: store.listWorkers(),
          sessions: store.listSessions(),
        }));
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/network') {
        assertAdmin(principal);
        sendJson(response, 200, networkInfoForRequest(request, options, server.address()?.port));
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/context') {
        assertAdmin(principal);
        const context = buildAgentContext({
          controlUrl: externalControlUrl(request, options),
          workers: store.listWorkers(),
          sessions: store.listSessions(),
        });
        if (url.searchParams.get('format') === 'json') {
          sendJson(response, 200, { context });
          return;
        }
        sendText(response, 200, context, 'text/markdown; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/mcp-config') {
        assertAdmin(principal);
        const name = url.searchParams.get('name') || 'nado';
        const config = buildMcpClientConfig({
          controlUrl: externalControlUrl(request, options),
          token: parseBearer(request) || options.token || '',
          name,
        });
        if (url.searchParams.get('format') === 'command') {
          sendText(response, 200, formatMcpCommand(config, name), 'text/plain; charset=utf-8');
          return;
        }
        sendJson(response, 200, config);
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/doctor') {
        assertAdmin(principal);
        const client = new NadoClient({ controlUrl: internalControlUrl(request, options), token: parseBearer(request) || options.token || '' });
        sendJson(response, 200, await runDoctor(client, doctorOptionsFromQuery(url)));
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/doctor') {
        assertAdmin(principal);
        const body = await readBody(request);
        const client = new NadoClient({ controlUrl: internalControlUrl(request, options), token: parseBearer(request) || options.token || '' });
        sendJson(response, 200, await runDoctor(client, body));
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/verify') {
        assertAdmin(principal);
        const body = await readBody(request);
        const client = new NadoClient({ controlUrl: internalControlUrl(request, options), token: parseBearer(request) || options.token || '' });
        sendJson(response, 200, await runVerify(client, body));
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/demo/health') {
        assertAdmin(principal);
        const body = await readBody(request);
        const client = new NadoClient({ controlUrl: internalControlUrl(request, options), token: parseBearer(request) || options.token || '' });
        const controlUrl = externalControlUrl(request, options);
        const result = {
          ok: true,
          controlUrl,
          dashboardUrl: `${controlUrl}/dashboard`,
          generatedAt: new Date().toISOString(),
          status: store.getStatusSnapshot(),
          network: networkInfoForRequest(request, options, server.address()?.port),
          routeChecks: [],
          verify: null,
          prune: null,
          problems: [],
        };
        try {
          result.routeChecks = await buildDemoRouteChecks({
            workers: store.listWorkers(),
            planDispatch: async (spec) => buildDispatchPlan(spec, {
              workers: store.listWorkers(),
              tasks: store.listTasks(),
              sessions: store.listSessions(),
            }),
          });
          if (!demoRouteChecksOk(result.routeChecks)) {
            result.problems.push('routeChecks: one or more advertised capabilities did not route correctly');
          }
        } catch (error) {
          result.problems.push(`routeChecks: ${error.message}`);
        }
        if (!body.skipVerify) {
          result.verify = await runVerify(client, {
            allWorkers: true,
            timeoutMs: Number(body.timeoutMs || 60_000),
          });
          if (!result.verify.ok) {
            result.problems.push(...result.verify.problems.map((problem) => `verify: ${problem}`));
          }
        }
        if (!body.noPrune) {
          try {
            result.prune = await store.pruneSystemHistory();
          } catch (error) {
            result.problems.push(`prune: ${error.message}`);
          }
        }
        result.status = store.getStatusSnapshot();
        result.ok = result.problems.length === 0 && Number(result.status?.workers?.active || 0) > 0;
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/worker-tokens') {
        assertAdmin(principal);
        const workerId = url.searchParams.get('workerId') || undefined;
        sendJson(response, 200, { workerTokens: store.listWorkerTokens({ workerId }) });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/worker-tokens') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.createWorkerToken(body);
        sendJson(response, 201, result);
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/worker-enrollment-tokens') {
        assertAdmin(principal);
        sendJson(response, 200, { enrollmentTokens: store.listWorkerEnrollmentTokens() });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/worker-enrollment-tokens') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.createWorkerEnrollmentToken(body);
        sendJson(response, 201, result);
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/worker-enrollment-tokens/prune') {
        assertAdmin(principal);
        sendJson(response, 200, store.previewWorkerEnrollmentTokenPrune());
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/worker-enrollment-tokens/prune') {
        assertAdmin(principal);
        sendJson(response, 200, await store.pruneWorkerEnrollmentTokens());
        return;
      }

      if (request.method === 'POST' && parts[1] === 'worker-enrollment-tokens' && parts[3] === 'revoke') {
        assertAdmin(principal);
        const enrollmentToken = await store.revokeWorkerEnrollmentToken(parts[2]);
        sendJson(response, 200, { enrollmentToken });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/workers/enroll') {
        assertEnrollment(principal);
        const body = await readBody(request);
        if (!body.publicKey) {
          sendJson(response, 400, { error: 'Worker enrollment requires publicKey' });
          return;
        }
        const workerId = autoWorkerId(body.id);
        const result = await store.createWorkerToken({
          workerId,
          label: body.label || principal.label || 'self-service enrollment',
          publicKey: body.publicKey,
          enrollmentTokenId: principal.enrollmentTokenId,
        });
        const enrollmentToken = await store.recordWorkerEnrollmentUse(principal.enrollmentTokenId);
        sendJson(response, 201, {
          workerId,
          token: result.token,
          workerToken: result.workerToken,
          enrollmentToken,
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/workers/bundle') {
        assertAdmin(principal);
        const body = await readBody(request);
        if (!body.id) {
          sendJson(response, 400, { error: 'Worker bundle requires id' });
          return;
        }
        let token = body.workerToken || parseBearer(request) || options.token || '';
        let issued = null;
        if (body.issueToken) {
          const result = await store.createWorkerToken({
            workerId: body.id,
            label: body.tokenLabel || '',
            expiresAt: body.expiresAt || undefined,
          });
          token = result.token;
          issued = result.workerToken;
        }
        const bundle = await buildWorkerBundle({
          token,
          controlUrl: workerBundleControlUrl(request, options, body, server.address()?.port),
          id: body.id,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
          labels: Array.isArray(body.labels) ? body.labels : [],
          agentPreset: body.agentPreset || null,
          agentCommand: body.agentCommand || null,
          maxConcurrency: body.maxConcurrency || null,
          cleanupWorkspaces: Boolean(body.cleanupWorkspaces),
          pollMs: body.pollMs || null,
          dataDir: body.dataDir || '.nado',
          issuedWorkerToken: issued,
        });
        sendWorkerBundleBytes(response, `${bundle.bundleRoot}.zip`, bundle.bytes, issued);
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/workers/bootstrap-bundle') {
        assertAdmin(principal);
        const body = await readBody(request);
        let enrollmentToken = body.enrollmentToken || '';
        let issued = null;
        if (body.issueEnrollmentToken || !enrollmentToken) {
          const result = await store.createWorkerEnrollmentToken({
            label: body.tokenLabel || body.label || 'self-service bootstrap',
            expiresAt: defaultEnrollmentExpiresAt(body.expiresAt),
            maxUses: body.maxUses || 1,
          });
          enrollmentToken = result.token;
          issued = result.enrollmentToken;
        }
        const bundle = await buildWorkerBootstrapBundle({
          enrollmentToken,
          controlUrl: workerBundleControlUrl(request, options, body, server.address()?.port),
          name: body.name || 'bootstrap',
          capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
          labels: Array.isArray(body.labels) ? body.labels : [],
          agentPreset: body.agentPreset || null,
          agentCommand: body.agentCommand || null,
          maxConcurrency: body.maxConcurrency || null,
          cleanupWorkspaces: Boolean(body.cleanupWorkspaces),
          pollMs: body.pollMs || null,
          dataDir: body.dataDir || '.nado',
          issuedEnrollmentToken: issued,
        });
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': bundle.bytes.length,
          'content-disposition': `attachment; filename="${contentDispositionFileName(`${bundle.bundleRoot}.zip`)}"; filename*=UTF-8''${encodeURIComponent(`${bundle.bundleRoot}.zip`)}`,
          ...(issued ? {
            'x-nado-worker-enrollment-token-id': issued.id,
            'x-nado-worker-enrollment-token-preview': issued.tokenPreview,
          } : {}),
        });
        response.end(bundle.bytes);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'worker-tokens' && parts[3] === 'revoke') {
        assertAdmin(principal);
        const workerToken = await store.revokeWorkerToken(parts[2]);
        sendJson(response, 200, { workerToken });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/workers/register') {
        const body = await readBody(request);
        if (!body.id) {
          sendJson(response, 400, { error: 'Worker id is required' });
          return;
        }
        await assertWorkerSelf(principal, body.id, request, store);
        const worker = await store.upsertWorker(body);
        sendJson(response, 200, { worker });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/workers') {
        assertAdmin(principal);
        sendJson(response, 200, { workers: store.listWorkers() });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'heartbeat') {
        const body = await readBody(request);
        await assertWorkerSelf(principal, parts[2], request, store);
        const heartbeat = await store.heartbeat(parts[2], body);
        sendJson(response, 200, heartbeat);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'workers' && parts[3] === 'preflight') {
        await assertWorkerSelf(principal, parts[2], request, store);
        sendJson(response, 200, {
          ok: true,
          workerId: parts[2],
          auth: principal.type,
          service: 'nado-control',
          checkedAt: new Date().toISOString(),
        });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'workers' && parts[3] === 'events' && parts.length === 4) {
        await assertWorkerSelf(principal, parts[2], request, store);
        const tail = url.searchParams.has('tail') ? Math.max(0, Number(url.searchParams.get('tail') || 0)) : null;
        sendJson(response, 200, store.listWorkerEvents(parts[2], { tail }));
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'events' && parts.length === 4) {
        const body = await readBody(request);
        await assertWorkerSelf(principal, parts[2], request, store);
        const event = await store.addWorkerEvent(parts[2], body);
        sendJson(response, 201, { event });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'workers' && parts.length === 3) {
        await assertWorkerSelf(principal, parts[2], request, store);
        const worker = store.getWorker(parts[2]);
        sendJson(response, 200, { worker });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'manage') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.manageWorker(parts[2], body.action, body.reason || '');
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'forget') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.forgetWorker(parts[2], { reason: body.reason || '' });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'commands' && parts[5] === 'ack') {
        const body = await readBody(request);
        await assertWorkerSelf(principal, parts[2], request, store);
        const command = await store.acknowledgeCommand(
          parts[2],
          parts[4],
          body.status || 'acknowledged',
          body.message || '',
        );
        sendJson(response, 200, { command });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'claim') {
        await assertWorkerSelf(principal, parts[2], request, store);
        const task = await store.claimTask(parts[2]);
        sendJson(response, 200, { task });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/tasks') {
        assertAdmin(principal);
        const body = await readBody(request);
        if (!body.command && !body.prompt) {
          sendJson(response, 400, { error: 'Task requires command or prompt' });
          return;
        }
        const task = await store.createTask(body);
        sendJson(response, 201, { task });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/batches') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.createBatch(body);
        sendJson(response, 201, result);
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/batches/plan') {
        assertAdmin(principal);
        const body = await readBody(request);
        sendJson(response, 200, { batch: buildBatchPlan(body) });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/dispatch/plan') {
        assertAdmin(principal);
        const body = await readBody(request);
        sendJson(response, 200, {
          plan: buildDispatchPlan(body, {
            workers: store.listWorkers(),
            tasks: store.listTasks(),
            sessions: store.listSessions(),
          }),
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/sessions') {
        assertAdmin(principal);
        const body = await readBody(request);
        const session = await store.createSession(body);
        sendJson(response, 201, { session });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/sessions') {
        assertAdmin(principal);
        sendJson(response, 200, { sessions: store.listSessions() });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/sessions/prune-empty') {
        assertAdmin(principal);
        const sessionId = url.searchParams.get('sessionId') || undefined;
        const sessions = store.listEmptySessions({ sessionId });
        sendJson(response, 200, { prunableCount: sessions.length, sessions });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/sessions/prune-empty') {
        assertAdmin(principal);
        const body = await readBody(request);
        sendJson(response, 200, await store.pruneEmptySessions({ sessionId: body.sessionId || undefined }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'sessions' && parts.length === 3) {
        assertAdmin(principal);
        const session = store.getSession(parts[2]);
        sendJson(response, 200, { session });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'sessions' && parts[3] === 'artifacts' && parts.length === 4) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, store.listSessionArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'sessions' && parts[3] === 'artifacts' && parts[4] === 'content' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, await store.readSessionArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'sessions' && parts[3] === 'artifacts' && parts[4] === 'download' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        const zip = await buildSessionArtifactZip(store, parts[2], { includeSkipped });
        sendZipBytes(response, `${zip.session.id}-artifacts.zip`, zip.bytes);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'sessions' && parts[3] === 'close') {
        assertAdmin(principal);
        const session = await store.closeSession(parts[2]);
        sendJson(response, 200, { session });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/tasks') {
        assertAdmin(principal);
        sendJson(response, 200, { tasks: store.listTasks() });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/tasks/prune') {
        assertAdmin(principal);
        const keep = url.searchParams.has('keep') ? Number(url.searchParams.get('keep')) : undefined;
        const preview = store.listPrunableTasks({ keep });
        sendJson(response, 200, {
          keep: preview.keep,
          totalStandaloneTerminal: preview.totalStandaloneTerminal,
          prunableCount: preview.tasks.length,
          tasks: preview.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            completedAt: task.completedAt || null,
          })),
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/tasks/prune') {
        assertAdmin(principal);
        const body = await readBody(request);
        sendJson(response, 200, await store.pruneTaskHistory(body));
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/system-history/prune') {
        assertAdmin(principal);
        const preview = store.listPrunableSystemHistory();
        sendJson(response, 200, {
          prunableTaskCount: preview.tasks.length,
          prunableBatchCount: preview.batches.length,
          tasks: preview.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            completedAt: task.completedAt || null,
          })),
          batches: preview.batches.map((batch) => ({
            id: batch.id,
            title: batch.title,
            status: batch.status,
            totalTasks: batch.totalTasks || 0,
          })),
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/system-history/prune') {
        assertAdmin(principal);
        sendJson(response, 200, await store.pruneSystemHistory());
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/batches') {
        assertAdmin(principal);
        sendJson(response, 200, { batches: store.listBatches() });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'artifacts' && parts.length === 4) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, store.listBatchArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'artifacts' && parts[4] === 'content' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, await store.readBatchArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'artifacts' && parts[4] === 'download' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        const zip = await buildBatchArtifactZip(store, parts[2], { includeSkipped });
        sendZipBytes(response, `${zip.batch.id}-artifacts.zip`, zip.bytes);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'report' && parts.length === 4) {
        assertAdmin(principal);
        sendJson(response, 200, store.getBatchReport(parts[2], {
          stdoutChars: url.searchParams.has('stdoutChars') ? Number(url.searchParams.get('stdoutChars')) : undefined,
          stderrChars: url.searchParams.has('stderrChars') ? Number(url.searchParams.get('stderrChars')) : undefined,
        }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'events' && parts.length === 4) {
        assertAdmin(principal);
        const { batch, tasks } = store.getBatch(parts[2]);
        sendJson(response, 200, { batch, events: batchEventRows(batch, tasks) });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts[3] === 'events' && parts[4] === 'stream' && parts.length === 5) {
        assertAdmin(principal);
        const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined;
        const lastEventId = cursor ?? Number(request.headers['last-event-id'] ?? -1);
        streamEventRows(request, response, {
          lastEventId: Number.isFinite(lastEventId) ? lastEventId : -1,
          snapshot: () => {
            const { batch, tasks } = store.getBatch(parts[2]);
            return {
              id: batch.id,
              status: batch.status,
              events: batchEventRows(batch, tasks),
            };
          },
          key: (row) => [
            row.source,
            row.taskId || row.task || '-',
            row.order ?? '-',
            row.type,
            row.at,
          ].join(':'),
          terminal: terminalBatchStatus,
        });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'batches' && parts.length === 3) {
        assertAdmin(principal);
        sendJson(response, 200, store.getBatch(parts[2]));
        return;
      }

      if (request.method === 'POST' && parts[1] === 'batches' && parts[3] === 'manage') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.manageBatch(parts[2], body.action, body);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/recovery/offline-tasks') {
        assertAdmin(principal);
        const workerId = url.searchParams.get('workerId') || undefined;
        sendJson(response, 200, { candidates: store.listOfflineRunningTasks({ workerId }) });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/recovery/offline-tasks') {
        assertAdmin(principal);
        const body = await readBody(request);
        const result = await store.recoverOfflineTasks(body);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts.length === 3) {
        assertAdmin(principal);
        const task = store.getTask(parts[2]);
        sendJson(response, 200, { task });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'schedule' && parts.length === 4) {
        assertAdmin(principal);
        const task = store.getTask(parts[2]);
        sendJson(response, 200, { taskId: task.id, scheduler: task.scheduler || null });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'events' && parts.length === 4) {
        assertAdmin(principal);
        const task = store.getTask(parts[2]);
        const events = Array.isArray(task.events) ? task.events : [];
        const tail = url.searchParams.has('tail') ? Math.max(0, Number(url.searchParams.get('tail') || 0)) : null;
        sendJson(response, 200, {
          taskId: task.id,
          status: task.status,
          events: tail === null ? events : events.slice(-tail),
        });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'events' && parts[4] === 'stream' && parts.length === 5) {
        assertAdmin(principal);
        const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : undefined;
        const lastEventId = cursor ?? Number(request.headers['last-event-id'] ?? -1);
        streamEventRows(request, response, {
          lastEventId: Number.isFinite(lastEventId) ? lastEventId : -1,
          snapshot: () => {
            const task = store.getTask(parts[2]);
            return {
              id: task.id,
              status: task.status,
              events: Array.isArray(task.events) ? task.events : [],
            };
          },
          key: (row, index) => `${index}:${row.type}:${row.at || ''}`,
          terminal: terminalTaskStatus,
        });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts.length === 4) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, store.listTaskArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts[4] === 'content' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        sendJson(response, 200, await store.readTaskArtifacts(parts[2], { includeSkipped }));
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts[4] === 'download' && parts.length === 5) {
        assertAdmin(principal);
        const includeSkipped = url.searchParams.get('includeSkipped') === 'true';
        const zip = await buildTaskArtifactZip(store, parts[2], { includeSkipped });
        sendZipBytes(response, `${zip.task.id}-artifacts.zip`, zip.bytes);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts[5] === 'download' && parts.length === 6) {
        assertAdmin(principal);
        const { artifact, bytes } = await store.readArtifactBytes(parts[2], parts[4]);
        sendArtifactBytes(response, artifact, bytes);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts.length === 5) {
        assertAdmin(principal);
        const artifact = await store.readArtifact(parts[2], parts[4]);
        sendJson(response, 200, artifact);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'events') {
        const body = await readBody(request);
        await assertTaskWorker(store, principal, parts[2], request);
        const event = await store.addTaskEvent(parts[2], body);
        sendJson(response, 201, { event });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'result') {
        const body = await readBody(request);
        await assertTaskWorker(store, principal, parts[2], request);
        const task = await store.completeTask(parts[2], body);
        sendJson(response, 200, { task });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'manage') {
        assertAdmin(principal);
        const body = await readBody(request);
        const task = await store.manageTask(parts[2], body.action, body);
        sendJson(response, 200, { task });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, error.status || 500, {
        error: error.message || 'Internal error',
        ...(error.nextActions ? { nextActions: error.nextActions } : {}),
        ...(error.dispatchPlan ? { dispatchPlan: error.dispatchPlan } : {}),
      });
    }
  });

  return { server, store };
}

export async function startControlServer(options) {
  const { server, store } = await createControlServer(options);
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? 8765 : Number(options.port);

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return { server, store, host, port: address.port };
}
