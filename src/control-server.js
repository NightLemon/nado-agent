import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
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
import { buildDistributedTaskPlan } from './task-planner.js';
import { buildDispatchPlan } from './dispatch-plan.js';
import { controlUrlFromHostPort, ensureDir, normalizeBaseUrl, originFromHostHeader, safeName } from './utils.js';
import { buildZipArchive, safeZipPath } from './zip.js';
import { buildGatewayCapabilities } from './capabilities.js';
import { getRuntimeBuildInfo } from './runtime-build.js';
import { buildNetworkInfo } from './network-info.js';
import { buildDemoRouteChecks, demoRouteChecksOk } from './demo-health.js';
import { startOfflineRecoverySupervisor } from './recovery-supervisor.js';
import {
  acceptanceEvidenceTemplate,
  buildCrossSiteAcceptanceReport,
  recordAcceptanceEvidence,
} from './cross-site-acceptance.js';
import { buildAcceptanceRunbook } from './acceptance-runbook.js';
import {
  NETWORK_PROBE_MAX_BYTES,
  normalizeNetworkProbeBytes,
} from './network-probe.js';
import { FixedWindowRateLimiter, rateLimitError } from './rate-limit.js';
import { readControlRestoreReceipt } from './store-backup.js';
import {
  controlClockSnapshot,
  SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS,
} from './clock-skew.js';
import { createAuditNdjsonSink } from './audit-sink.js';
import { acquireControlDataLease } from './control-data-lease.js';

async function readRawBody(request, maxBytes = Number.POSITIVE_INFINITY) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error(`Request body exceeds ${maxBytes} bytes`);
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  const expectedBodyHash = request.headers['x-nado-body-sha256'];
  if (expectedBodyHash) {
    const actualBodyHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actualBodyHash !== expectedBodyHash) {
      const error = new Error('Signed worker request body hash mismatch');
      error.status = 401;
      throw error;
    }
  }
  return bytes;
}

async function readBody(request) {
  const text = (await readRawBody(request, request.nadoJsonBodyMaxBytes)).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response, status, html, options = {}) {
  if (options.cspNonce) {
    response.setHeader('content-security-policy', [
      "default-src 'self'",
      `script-src 'nonce-${options.cspNonce}'`,
      `style-src 'nonce-${options.cspNonce}'`,
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '));
  }
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

function sendNetworkProbe(response, bytes) {
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-nado-probe-bytes': String(bytes.length),
    'x-nado-probe-sha256': sha256,
  });
  response.end(bytes);
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

async function sendArtifactFile(response, artifact) {
  const fileName = artifactFileName(artifact);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': artifact.size,
    'content-disposition': `attachment; filename="${contentDispositionFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'x-nado-artifact-id': artifact.id,
    'x-nado-artifact-path': encodeURIComponent(artifact.path || fileName),
    'x-nado-artifact-sha256': artifact.sha256 || '',
    'x-nado-artifact-size': String(artifact.size || 0),
  });
  await pipeline(createReadStream(artifact.storagePath), response);
}

function taskInputRange(request, input) {
  const range = String(request.headers.range || '');
  const match = range.match(/^bytes=(\d+)-$/i);
  if (range && !match) {
    const error = new Error('Only open-ended byte ranges are supported');
    error.status = 416;
    throw error;
  }
  const size = Number(input.size || 0);
  const start = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || (size > 0 && start >= size) || (size === 0 && start > 0)) {
    const error = new Error(`Input range is outside the file: ${start}/${size}`);
    error.status = 416;
    throw error;
  }
  return { size, start, partial: Boolean(match) };
}

async function sendTaskInputFile(request, response, input, storagePath, resolvedRange = null) {
  const { size, start, partial } = resolvedRange || taskInputRange(request, input);
  const length = Math.max(0, size - start);
  response.writeHead(partial ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': length,
    'accept-ranges': 'bytes',
    ...(partial ? { 'content-range': `bytes ${start}-${Math.max(start, size - 1)}/${size}` } : {}),
    'x-nado-input-id': input.inputUploadId || input.sourceArtifactId || '',
    'x-nado-input-path': encodeURIComponent(input.path || 'input.bin'),
    'x-nado-input-sha256': input.sha256 || '',
    'x-nado-input-size': String(size),
  });
  if (!length) {
    response.end();
    return;
  }
  await pipeline(createReadStream(storagePath, { start }), response);
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

function remoteAddress(request, options = {}) {
  if (trustedProxyRequest(request, options)) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return request.socket.remoteAddress || 'unknown';
}

function auditActor(principal, request) {
  if (principal?.type === 'worker') {
    return { actorType: 'worker', actorId: principal.workerTokenId || principal.workerId };
  }
  if (principal?.type === 'worker_enrollment') {
    return { actorType: 'worker_enrollment', actorId: principal.enrollmentTokenId };
  }
  if (principal?.type === 'admin') {
    const bearer = parseBearer(request);
    const fingerprint = bearer ? crypto.createHash('sha256').update(bearer).digest('hex').slice(0, 12) : 'open-control';
    return { actorType: 'admin', actorId: `admin:${fingerprint}` };
  }
  return { actorType: 'anonymous', actorId: null };
}

function redactAuditError(value = '') {
  return String(value || '')
    .replace(/nado_(?:wt|we)_[a-f0-9]+/gi, '[redacted-token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

function shouldAuditRequest(request, principal, statusCode) {
  const pathname = new URL(request.url, 'http://nado.local').pathname;
  if (!pathname.startsWith('/api/')) {
    return false;
  }
  if (statusCode >= 400) {
    return true;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    return false;
  }
  if (principal?.type === 'admin') {
    return true;
  }
  return pathname === '/api/workers/enroll'
    || pathname === '/api/workers/register'
    || pathname.includes('/token/rotation/');
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

function workerAuthenticationEvidence(principal, store) {
  const observedAt = new Date().toISOString();
  if (principal?.type !== 'worker') {
    return {
      type: 'admin',
      scoped: false,
      signed: false,
      workerTokenId: null,
      signatureAlgorithm: null,
      observedAt,
    };
  }
  const token = store.getWorkerToken(principal.workerTokenId);
  const signed = Boolean(token?.publicKey);
  return {
    type: 'worker_token',
    scoped: true,
    signed,
    workerTokenId: principal.workerTokenId || null,
    signatureAlgorithm: signed ? 'ed25519' : null,
    enrollmentTokenId: token?.enrollmentTokenId || null,
    signatureSignedAt: Number.isFinite(principal.signatureTimestampMs)
      ? new Date(principal.signatureTimestampMs).toISOString()
      : null,
    signatureClockSkewMs: Number.isFinite(principal.signatureClockSkewMs)
      ? principal.signatureClockSkewMs
      : null,
    signatureMaxClockSkewMs: SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS,
    observedAt,
  };
}

function workerConnectionEvidence(request, options = {}) {
  const proxyAuthenticated = trustedProxyRequest(request, options);
  const forwardedFor = proxyAuthenticated
    ? String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : '';
  const forwardedProtocolValue = proxyAuthenticated
    ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    : '';
  const forwardedProtocol = forwardedProtocolValue === 'http' || forwardedProtocolValue === 'https'
    ? forwardedProtocolValue
    : '';
  const protocol = forwardedProtocol || (request.socket.encrypted ? 'https' : options.protocol || 'http');
  return {
    remoteAddress: remoteAddress(request, options),
    addressSource: forwardedFor ? 'x-forwarded-for' : 'socket',
    protocol: String(protocol).replace(/:$/, ''),
    trustedProxy: proxyAuthenticated,
    proxyAuthenticated,
    observedAt: new Date().toISOString(),
  };
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

async function assertRotatingWorkerSelf(principal, workerId, request, store) {
  if (principal.type !== 'worker') {
    throw forbidden('A signed Worker identity is required for Worker token rotation');
  }
  if (principal.workerId !== workerId) {
    throw forbidden(`Worker token is not valid for worker: ${workerId}`);
  }
  const workerToken = store.getWorkerToken(principal.workerTokenId);
  if (!workerToken?.publicKey) {
    const error = new Error('Worker token rotation requires an enrolled signed Worker identity');
    error.status = 409;
    throw error;
  }
  await assertSignedWorkerRequest(request, store, principal, workerId);
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
  const controlTimeMs = Date.now();
  const clockSkewMs = controlTimeMs - timestampMs;
  if (!Number.isFinite(timestampMs) || Math.abs(clockSkewMs) > SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS) {
    const error = unauthorized('Signed worker request timestamp is outside the allowed window');
    error.details = {
      code: 'worker_clock_skew',
      controlTime: new Date(controlTimeMs).toISOString(),
      controlTimeMs,
      signedTimestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
      clockSkewMs: Number.isFinite(clockSkewMs) ? clockSkewMs : null,
      maxClockSkewMs: SIGNED_WORKER_REQUEST_MAX_CLOCK_SKEW_MS,
    };
    throw error;
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
  principal.signatureTimestampMs = timestampMs;
  principal.signatureClockSkewMs = clockSkewMs;
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

function trustProxySecret(options = {}) {
  return String(options.trustProxySecret || process.env.NADO_TRUST_PROXY_SECRET || '');
}

function trustedProxyRequest(request, options = {}) {
  if (!trustProxyEnabled(options)) {
    return false;
  }
  const expected = trustProxySecret(options);
  const supplied = request.headers['x-nado-proxy-secret'];
  return Boolean(expected && supplied && constantTimeEqual(supplied, expected));
}

function proxyTrustSummary(request, options = {}) {
  const enabled = trustProxyEnabled(options);
  const secretConfigured = Boolean(trustProxySecret(options));
  return {
    enabled,
    secretConfigured,
    authenticated: enabled && secretConfigured && trustedProxyRequest(request, options),
    authenticationHeader: 'X-Nado-Proxy-Secret',
  };
}

function requestControlUrl(request, options = {}) {
  return buildNetworkInfo(request, {
    publicControlUrl: '',
    protocol: options.protocol || 'http',
    trustProxy: trustedProxyRequest(request, options),
    trustProxyConfigured: trustProxyEnabled(options),
    proxyAuthenticationConfigured: Boolean(trustProxySecret(options)),
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
    trustProxy: trustedProxyRequest(request, options),
    trustProxyConfigured: trustProxyEnabled(options),
    proxyAuthenticationConfigured: Boolean(trustProxySecret(options)),
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
  if (trustProxyEnabled(options) && !trustProxySecret(options)) {
    throw new Error('Trusted proxy mode requires NADO_TRUST_PROXY_SECRET or --trust-proxy-secret');
  }
  const dataDir = options.dataDir || path.resolve('.nado');
  await ensureDir(dataDir);
  const build = options.buildInfo || await getRuntimeBuildInfo();
  const controlRuntime = Object.freeze({
    instanceId: options.controlInstanceId || `control_${crypto.randomUUID()}`,
    startedAt: new Date().toISOString(),
    build,
  });

  const store = options.store || createStore({
    dataDir,
    backend: options.storeBackend,
    file: options.storeFile,
  });
  store.setWriteFence?.(options.dataDirLease);
  await store.load();
  store.restoreReceipt = await readControlRestoreReceipt(dataDir);
  if (store.restoreReceipt && store.restoreReceipt.backend !== store.backend) {
    throw new Error(
      `Control restore receipt backend ${store.restoreReceipt.backend} does not match active store ${store.backend}`,
    );
  }
  const reliability = store.configureReliability?.({
    taskLeaseMs: options.taskLeaseMs,
  }) || {
    taskLeaseMs: Number(options.taskLeaseMs || 60_000),
    deliverySemantics: 'at-least-once',
  };

  const recoverySupervisor = startOfflineRecoverySupervisor({
    store,
    offlineAfterMs: options.autoRecoverOfflineMs,
    scanIntervalMs: options.recoveryScanIntervalMs,
    taskLeaseMs: reliability.taskLeaseMs,
    onError: options.onRecoveryError,
  });
  const jsonBodyMaxBytes = Math.max(1024, Number(
    options.jsonBodyMaxBytes ?? process.env.NADO_JSON_BODY_MAX_BYTES ?? 64 * 1024 * 1024,
  ));
  const requestRateLimiter = new FixedWindowRateLimiter({
    windowMs: options.rateLimitWindowMs ?? process.env.NADO_RATE_LIMIT_WINDOW_MS ?? 60_000,
  });
  const requestRateLimits = {
    ip: Math.max(0, Number(options.rateLimitIp ?? process.env.NADO_RATE_LIMIT_IP ?? 1_800)),
    admin: Math.max(0, Number(options.rateLimitAdmin ?? process.env.NADO_RATE_LIMIT_ADMIN ?? 600)),
    worker: Math.max(0, Number(options.rateLimitWorker ?? process.env.NADO_RATE_LIMIT_WORKER ?? 1_800)),
    worker_enrollment: Math.max(0, Number(options.rateLimitEnrollment ?? process.env.NADO_RATE_LIMIT_ENROLLMENT ?? 60)),
  };
  const enforceRateLimit = (response, key, limit) => {
    const result = requestRateLimiter.consume(key, limit);
    if (result.limit) {
      response.setHeader('x-ratelimit-limit', String(result.limit));
      response.setHeader('x-ratelimit-remaining', String(result.remaining));
      response.setHeader('x-ratelimit-reset', result.resetAt);
    }
    if (!result.allowed) {
      throw rateLimitError(result);
    }
  };
  const networkProbeLastUsed = new Map();
  const networkProbeMinIntervalMs = Math.max(0, Number(
    options.networkProbeMinIntervalMs ?? process.env.NADO_NETWORK_PROBE_MIN_INTERVAL_MS ?? 30_000,
  ));
  const claimNetworkProbe = (workerId, direction) => {
    if (!networkProbeMinIntervalMs) {
      return;
    }
    const key = `${workerId}:${direction}`;
    const now = Date.now();
    const previous = networkProbeLastUsed.get(key) || 0;
    if (now - previous < networkProbeMinIntervalMs) {
      const error = new Error(`Network probe rate limit: retry in ${networkProbeMinIntervalMs - (now - previous)}ms`);
      error.status = 429;
      throw error;
    }
    networkProbeLastUsed.set(key, now);
  };
  const pendingAuditWrites = new Set();
  const auditSink = createAuditNdjsonSink({
    file: options.auditNdjsonFile ?? process.env.NADO_AUDIT_NDJSON_FILE,
    maxPendingWrites: options.auditNdjsonMaxPending ?? process.env.NADO_AUDIT_NDJSON_MAX_PENDING,
  });

  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = String(request.headers['x-request-id'] || crypto.randomBytes(8).toString('hex')).slice(0, 80);
    let principal = null;
    let requestError = null;
    request.nadoJsonBodyMaxBytes = jsonBodyMaxBytes;
    response.setHeader('x-nado-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('cache-control', 'no-store');
    response.once('finish', () => {
      if (!shouldAuditRequest(request, principal, response.statusCode)) {
        return;
      }
      const actor = auditActor(principal, request);
      const auditWrite = store.addAuditEvent({
        requestId,
        ...actor,
        method: request.method,
        path: new URL(request.url, 'http://nado.local').pathname,
        statusCode: response.statusCode,
        outcome: response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'denied' : 'success',
        remoteAddress: remoteAddress(request, options),
        userAgent: request.headers['user-agent'] || null,
        durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        error: redactAuditError(requestError?.message),
      }).then(async (event) => {
        await auditSink.write(event);
        return event;
      }).catch(() => {});
      pendingAuditWrites.add(auditWrite);
      void auditWrite.finally(() => pendingAuditWrites.delete(auditWrite));
    });
    try {
      const { url, parts } = parsePath(request);

      if (request.method === 'GET' && parts.join('/') === 'health') {
        sendJson(response, 200, {
          ok: true,
          service: 'nado-control',
          runtime: controlRuntime,
          clock: controlClockSnapshot(),
        });
        return;
      }

      if (request.method === 'GET' && (!parts.length || parts.join('/') === 'dashboard')) {
        const cspNonce = crypto.randomBytes(18).toString('base64url');
        sendHtml(response, 200, dashboardHtml({
          bootstrapToken: dashboardBootstrapToken(options),
          cspNonce,
        }), { cspNonce });
        return;
      }

      if (parts[0] !== 'api') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }

      enforceRateLimit(response, `ip:${remoteAddress(request, options)}`, requestRateLimits.ip);
      principal = assertAuthed(request, options.token, store);
      const actor = auditActor(principal, request);
      enforceRateLimit(response, `actor:${actor.actorType}:${actor.actorId || remoteAddress(request, options)}`, requestRateLimits[actor.actorType] ?? requestRateLimits.ip);

      if (request.method === 'GET' && parts.join('/') === 'api/audit') {
        assertAdmin(principal);
        sendJson(response, 200, {
          auditEvents: store.listAuditEvents({
            tail: url.searchParams.get('tail') ?? 100,
            actorType: url.searchParams.get('actorType') || undefined,
            outcome: url.searchParams.get('outcome') || undefined,
            statusCode: url.searchParams.get('statusCode') || undefined,
          }),
        });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/audit/export') {
        assertAdmin(principal);
        const events = store.listAuditEvents({ tail: url.searchParams.get('tail') ?? 1_000 });
        sendText(response, 200, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'application/x-ndjson; charset=utf-8');
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/status') {
        assertAdmin(principal);
        const snapshot = store.getStatusSnapshot();
        snapshot.storage.dataLease = options.dataDirLease?.summary() || {
          enabled: false,
          status: 'unavailable',
          writeFencing: false,
        };
        sendJson(response, 200, {
          ...snapshot,
          runtime: controlRuntime,
          security: {
            auditSink: auditSink.summary(),
          },
          reliability: {
            automaticOfflineRecovery: recoverySupervisor.summary(),
          },
        });
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/capabilities') {
        assertAdmin(principal);
        sendJson(response, 200, buildGatewayCapabilities({
          controlUrl: externalControlUrl(request, options),
          workers: store.listWorkers(),
          sessions: store.listSessions(),
          recovery: recoverySupervisor.summary(),
          proxyTrust: proxyTrustSummary(request, options),
          runtime: controlRuntime,
          auditSink: auditSink.summary(),
          dataLease: options.dataDirLease?.summary(),
        }));
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/acceptance/template') {
        assertAdmin(principal);
        sendJson(response, 200, acceptanceEvidenceTemplate());
        return;
      }

      if (request.method === 'GET' && parts.join('/') === 'api/acceptance/runbook') {
        assertAdmin(principal);
        const workerId = String(url.searchParams.get('workerId') || '').trim();
        if (!workerId) {
          const error = new Error('Acceptance runbook requires workerId');
          error.status = 400;
          throw error;
        }
        try {
          sendJson(response, 200, buildAcceptanceRunbook({
            controlUrl: externalControlUrl(request, options),
            workerId,
            deploymentMode: url.searchParams.get('deploymentMode') || undefined,
            overlayInterface: url.searchParams.get('overlayInterface') || undefined,
            requireGpu: url.searchParams.get('requireGpu') === 'true',
            requireAgent: url.searchParams.get('requireAgent') !== 'false',
          }));
        } catch (error) {
          error.status = 400;
          throw error;
        }
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/acceptance/evidence/record') {
        assertAdmin(principal);
        const body = await readBody(request);
        const document = body.document === undefined
          ? acceptanceEvidenceTemplate()
          : body.document;
        let evidence;
        try {
          evidence = recordAcceptanceEvidence(document, body.record || {});
        } catch (error) {
          error.status = 400;
          throw error;
        }
        sendJson(response, 200, evidence);
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/acceptance/report') {
        assertAdmin(principal);
        const body = await readBody(request);
        const workerId = String(body.workerId || '').trim();
        if (!workerId) {
          const error = new Error('Acceptance report requires workerId');
          error.status = 400;
          throw error;
        }
        const workers = store.listWorkers();
        const network = networkInfoForRequest(request, options, server.address()?.port);
        const status = {
          ...store.getStatusSnapshot(),
          runtime: controlRuntime,
          reliability: {
            automaticOfflineRecovery: recoverySupervisor.summary(),
          },
        };
        const capabilities = buildGatewayCapabilities({
          controlUrl: externalControlUrl(request, options),
          workers,
          sessions: store.listSessions(),
          recovery: recoverySupervisor.summary(),
          proxyTrust: proxyTrustSummary(request, options),
          runtime: controlRuntime,
        });
        let verifyResult = null;
        if (body.runVerify) {
          const client = new NadoClient({
            controlUrl: internalControlUrl(request, options),
            token: parseBearer(request) || options.token || '',
          });
          verifyResult = await runVerify(client, {
            workerId,
            allWorkers: false,
            requiredCapabilities: body.requireGpu ? ['gpu'] : [],
            timeoutMs: Number(body.timeoutMs || 60_000),
          });
        }
        let acceptanceReport;
        try {
          acceptanceReport = buildCrossSiteAcceptanceReport({
            workerId,
            requireGpu: Boolean(body.requireGpu),
            requireAgent: body.requireAgent !== false,
            requireDeploymentEvidence: Boolean(body.requireDeploymentEvidence),
            deploymentEvidence: body.deploymentEvidence || null,
            manualEvidence: body.manualEvidence || {},
            network,
            status,
            capabilities,
            workers,
            tasks: store.listTasks(),
            sessions: store.listSessions(),
            verifyResult,
          });
        } catch (error) {
          error.status = 400;
          throw error;
        }
        sendJson(response, 200, acceptanceReport);
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
        await store.expirePendingWorkerTokenRotations();
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
          strictLocalReadiness: Boolean(body.strictLocalReadiness),
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

      if (
        request.method === 'POST'
        && parts[1] === 'workers'
        && parts[3] === 'token'
        && parts[4] === 'rotation'
        && parts[5] === 'prepare'
        && parts.length === 6
      ) {
        const body = await readBody(request);
        await assertRotatingWorkerSelf(principal, parts[2], request, store);
        const result = await store.prepareWorkerTokenRotation(
          parts[2],
          principal.workerTokenId,
          body,
        );
        sendJson(response, result.idempotent ? 200 : 201, result);
        return;
      }

      if (
        request.method === 'POST'
        && parts[1] === 'workers'
        && parts[3] === 'token'
        && parts[4] === 'rotation'
        && parts[5] === 'confirm'
        && parts.length === 6
      ) {
        await readBody(request);
        await assertRotatingWorkerSelf(principal, parts[2], request, store);
        const result = await store.confirmWorkerTokenRotation(parts[2], principal.workerTokenId);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/workers/register') {
        const body = await readBody(request);
        if (!body.id) {
          sendJson(response, 400, { error: 'Worker id is required' });
          return;
        }
        await assertWorkerSelf(principal, body.id, request, store);
        const worker = await store.upsertWorker(
          body,
          workerAuthenticationEvidence(principal, store),
          workerConnectionEvidence(request, options),
        );
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
        const heartbeat = await store.heartbeat(
          parts[2],
          body,
          workerAuthenticationEvidence(principal, store),
          workerConnectionEvidence(request, options),
        );
        sendJson(response, 200, heartbeat);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'workers' && parts[3] === 'network-probe' && parts[4] === 'download' && parts.length === 5) {
        await assertWorkerSelf(principal, parts[2], request, store);
        const bytes = normalizeNetworkProbeBytes(url.searchParams.get('bytes'));
        claimNetworkProbe(parts[2], 'download');
        sendNetworkProbe(response, crypto.randomBytes(bytes));
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'network-probe' && parts[4] === 'upload' && parts.length === 5) {
        const bytes = await readRawBody(request, NETWORK_PROBE_MAX_BYTES);
        await assertWorkerSelf(principal, parts[2], request, store);
        normalizeNetworkProbeBytes(bytes.length);
        claimNetworkProbe(parts[2], 'upload');
        sendJson(response, 200, {
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          receivedAt: new Date().toISOString(),
        });
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
          body.result || null,
        );
        sendJson(response, 200, { command });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'workers' && parts[3] === 'claim') {
        await assertWorkerSelf(principal, parts[2], request, store);
        const waitMs = Math.max(0, Math.min(30_000, Number(url.searchParams.get('waitMs') || 0)));
        const startedAt = Date.now();
        const claimAbort = new AbortController();
        const abortClaim = () => claimAbort.abort();
        request.once('aborted', abortClaim);
        response.once('close', abortClaim);
        let task;
        try {
          task = waitMs
            ? await store.waitForTaskClaim(parts[2], waitMs, {
              signal: claimAbort.signal,
              snapshotResult: true,
            })
            : await store.claimTask(parts[2], { snapshotResult: true });
        } finally {
          request.off('aborted', abortClaim);
          response.off('close', abortClaim);
        }
        if (request.destroyed || response.destroyed) {
          return;
        }
        sendJson(response, 200, {
          task,
          claim: {
            longPoll: Boolean(waitMs),
            waitMs,
            waitedMs: Date.now() - startedAt,
          },
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/tasks') {
        assertAdmin(principal);
        const body = await readBody(request);
        if (!body.command && !body.prompt) {
          sendJson(response, 400, { error: 'Task requires command or prompt' });
          return;
        }
        const task = await store.createTask({
          ...body,
          controlInstanceId: controlRuntime.instanceId,
        });
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

      if (request.method === 'POST' && parts.join('/') === 'api/planner/plan') {
        assertAdmin(principal);
        const body = await readBody(request);
        const planned = buildDistributedTaskPlan(body, {
          workers: store.listWorkers(),
          tasks: store.listTasks(),
          sessions: store.listSessions(),
        });
        const dispatchPlan = buildDispatchPlan(planned.batch, {
          workers: store.listWorkers(),
          tasks: store.listTasks(),
          sessions: store.listSessions(),
        });
        sendJson(response, 200, {
          ...planned,
          dispatchPlan,
        });
        return;
      }

      if (request.method === 'POST' && parts.join('/') === 'api/planner/run') {
        assertAdmin(principal);
        const body = await readBody(request);
        const planned = buildDistributedTaskPlan(body, {
          workers: store.listWorkers(),
          tasks: store.listTasks(),
          sessions: store.listSessions(),
        });
        const batchSpec = {
          ...planned.batch,
          requireRoutable: Boolean(body.requireRoutable),
        };
        const created = await store.createBatch(batchSpec);
        sendJson(response, 201, {
          ...planned,
          ...created,
          routing: created.tasks.map((task) => ({
            taskId: task.id,
            key: task.batchKey,
            workerId: task.scheduler?.workerId || task.requestedWorkerId || null,
            reason: task.scheduler?.reason || null,
            candidates: task.scheduler?.candidates || [],
          })),
        });
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
        sendJson(response, 200, { tasks: store.listTaskViews() });
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
        sendJson(response, 200, { candidates: store.listRecoverableRunningTasks({ workerId }) });
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
        const task = store.decorateTask(parts[2]);
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
        const artifact = store.getArtifact(parts[2], parts[4]);
        if (artifact.skipped || !artifact.storagePath) {
          const error = new Error(`Artifact is not available for download: ${artifact.path}`);
          error.status = 404;
          throw error;
        }
        await sendArtifactFile(response, artifact);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifacts' && parts.length === 5) {
        assertAdmin(principal);
        const artifact = await store.readArtifact(parts[2], parts[4]);
        sendJson(response, 200, artifact);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'input-uploads' && parts.length === 5) {
        assertAdmin(principal);
        sendJson(response, 200, { upload: store.getTaskInputUpload(parts[2], parts[4]) });
        return;
      }

      if (request.method === 'PATCH' && parts[1] === 'tasks' && parts[3] === 'input-uploads' && parts[5] === 'chunks' && parts.length === 6) {
        assertAdmin(principal);
        const upload = await store.appendTaskInputUpload(parts[2], parts[4], {
          offset: url.searchParams.get('offset'),
          chunkSha256: request.headers['x-nado-chunk-sha256'],
          stream: request,
        });
        sendJson(response, 200, { upload });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'input-uploads' && parts[5] === 'finalize' && parts.length === 6) {
        assertAdmin(principal);
        await readBody(request);
        const result = await store.finalizeTaskInputUpload(parts[2], parts[4]);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'inputs' && parts[5] === 'download' && parts.length === 6) {
        await assertTaskWorker(store, principal, parts[2], request);
        const task = store.getTask(parts[2]);
        const attemptId = request.headers['x-nado-attempt-id'];
        const fetched = store.getTaskInputDownload(parts[2], parts[4], {
          attemptId,
          workerId: principal.type === 'worker' ? principal.workerId : task.assignedWorkerId,
        });
        const resolvedRange = taskInputRange(request, fetched.input);
        await store.addTaskEvent(parts[2], {
          type: 'input_download_range',
          message: `Worker ${task.assignedWorkerId} requested input ${fetched.input.path} from byte ${resolvedRange.start}`,
          workerId: task.assignedWorkerId,
          attemptId,
          data: {
            inputId: parts[4],
            path: fetched.input.path,
            attemptId,
            offset: resolvedRange.start,
            size: fetched.input.size,
            resumed: resolvedRange.start > 0,
          },
        });
        await sendTaskInputFile(request, response, fetched.input, fetched.storagePath, resolvedRange);
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'events') {
        const body = await readBody(request);
        await assertTaskWorker(store, principal, parts[2], request);
        const event = await store.addTaskEvent(parts[2], body);
        sendJson(response, 201, { event });
        return;
      }

      if (
        request.method === 'POST'
        && parts[1] === 'tasks'
        && parts[3] === 'acceptance-observations'
        && parts[4] === 'short-disconnect'
        && parts.length === 5
      ) {
        assertAdmin(principal);
        const body = await readBody(request);
        const task = store.getTask(parts[2]);
        const workerId = String(body.workerId || '').trim();
        const attemptId = String(body.attemptId || '').trim();
        const phase = String(body.phase || '').trim();
        const minDisconnectMs = Math.max(2_000, Math.min(60_000, Number(body.minDisconnectMs || 0)));
        if (
          task.title !== 'nado cross-site short disconnect exercise'
          || task.status !== 'running'
          || task.assignedWorkerId !== workerId
          || task.currentAttemptId !== attemptId
          || !task.lease
        ) {
          const error = new Error('Short-disconnect observation does not match a live acceptance task attempt');
          error.status = 409;
          throw error;
        }
        const worker = store.getWorker(workerId);
        let event;
        if (phase === 'gap') {
          if (
            Number(worker.ageMs || 0) < minDisconnectMs
            || Date.parse(task.lease.expiresAt || '') <= Date.now()
          ) {
            const error = new Error('Short-disconnect gap has not reached the threshold or its lease already expired');
            error.status = 409;
            throw error;
          }
          event = await store.addTaskEvent(task.id, {
            type: 'short_disconnect_gap_observed',
            message: `Control observed Worker ${workerId} heartbeat age ${Math.round(worker.ageMs)}ms before lease expiry`,
            workerId,
            attemptId,
            data: {
              minDisconnectMs,
              workerAgeMs: worker.ageMs,
              workerLastSeenAt: worker.lastSeenAt || null,
              leaseRenewedAt: task.lease.renewedAt || null,
              leaseExpiresAt: task.lease.expiresAt || null,
            },
          });
        } else if (phase === 'recovered') {
          const gapEvent = [...(task.events || [])].reverse().find((item) => (
            item.type === 'short_disconnect_gap_observed'
            && item.workerId === workerId
            && item.attemptId === attemptId
          ));
          if (
            !gapEvent
            || !worker.active
            || Number(worker.ageMs || 0) >= 3_000
            || Date.parse(task.lease.renewedAt || '') <= Date.parse(gapEvent.data?.leaseRenewedAt || '')
            || Date.parse(task.lease.expiresAt || '') <= Date.now()
          ) {
            const error = new Error('Short-disconnect recovery lacks a prior gap or same-attempt lease renewal');
            error.status = 409;
            throw error;
          }
          event = await store.addTaskEvent(task.id, {
            type: 'short_disconnect_recovered',
            message: `Control observed Worker ${workerId} renew the same attempt after the heartbeat gap`,
            workerId,
            attemptId,
            data: {
              gapObservedAt: gapEvent.at,
              workerAgeMs: worker.ageMs,
              workerLastSeenAt: worker.lastSeenAt || null,
              leaseRenewedAt: task.lease.renewedAt || null,
              leaseExpiresAt: task.lease.expiresAt || null,
            },
          });
        } else {
          const error = new Error('Short-disconnect observation phase must be gap or recovered');
          error.status = 400;
          throw error;
        }
        sendJson(response, 201, { event, task: store.getTask(task.id), worker: store.getWorker(workerId) });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'artifact-uploads' && parts.length === 4) {
        const body = await readBody(request);
        await assertTaskWorker(store, principal, parts[2], request);
        const task = store.getTask(parts[2]);
        const upload = await store.createArtifactUpload(parts[2], {
          ...body,
          workerId: principal.type === 'worker' ? principal.workerId : task.assignedWorkerId,
        });
        sendJson(response, 201, { upload });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifact-uploads' && parts.length === 4) {
        assertAdmin(principal);
        sendJson(response, 200, { uploads: store.listArtifactUploads(parts[2]) });
        return;
      }

      if (request.method === 'GET' && parts[1] === 'tasks' && parts[3] === 'artifact-uploads' && parts.length === 5) {
        await assertTaskWorker(store, principal, parts[2], request);
        const task = store.getTask(parts[2]);
        const upload = store.getArtifactUpload(parts[2], parts[4], {
          attemptId: url.searchParams.get('attemptId') || undefined,
          workerId: principal.type === 'worker' ? principal.workerId : task.assignedWorkerId,
        });
        sendJson(response, 200, { upload });
        return;
      }

      if (request.method === 'PATCH' && parts[1] === 'tasks' && parts[3] === 'artifact-uploads' && parts[5] === 'chunks' && parts.length === 6) {
        await assertTaskWorker(store, principal, parts[2], request);
        const task = store.getTask(parts[2]);
        const upload = await store.appendArtifactUpload(parts[2], parts[4], {
          attemptId: request.headers['x-nado-attempt-id'],
          workerId: principal.type === 'worker' ? principal.workerId : task.assignedWorkerId,
          offset: url.searchParams.get('offset'),
          chunkSha256: request.headers['x-nado-chunk-sha256'],
          bodySha256: request.headers['x-nado-body-sha256'],
          stream: request,
        });
        sendJson(response, 200, { upload });
        return;
      }

      if (request.method === 'POST' && parts[1] === 'tasks' && parts[3] === 'artifact-uploads' && parts[5] === 'finalize' && parts.length === 6) {
        const body = await readBody(request);
        await assertTaskWorker(store, principal, parts[2], request);
        const task = store.getTask(parts[2]);
        const upload = await store.finalizeArtifactUpload(parts[2], parts[4], {
          attemptId: body.attemptId,
          workerId: principal.type === 'worker' ? principal.workerId : task.assignedWorkerId,
        });
        sendJson(response, 200, { upload });
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
      requestError = error;
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error.retryAfterMs) {
        response.setHeader('retry-after', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      }
      sendJson(response, error.status || 500, {
        error: error.message || 'Internal error',
        ...(error.nextActions ? { nextActions: error.nextActions } : {}),
        ...(error.dispatchPlan ? { dispatchPlan: error.dispatchPlan } : {}),
        ...(error.expectedOffset !== undefined ? { expectedOffset: error.expectedOffset } : {}),
        ...(error.details ? { details: error.details } : {}),
      });
    }
  });

  server.on('close', () => {
    recoverySupervisor.stop();
    store.closeClaimWaiters?.();
  });
  options.dataDirLease?.setOnLost(() => {
    if (server.listening) {
      server.close();
      return;
    }
    recoverySupervisor.stop();
    store.closeClaimWaiters?.();
  });
  const closeHttpServer = server.close.bind(server);
  server.close = (callback) => closeHttpServer((error) => {
    void (async () => {
      await Promise.allSettled([...pendingAuditWrites]);
      await auditSink.close().catch(() => {});
      let closeError = error;
      try {
        await options.dataDirLease?.release();
      } catch (leaseError) {
        closeError ||= leaseError;
      }
      callback?.(closeError);
    })();
  });
  return {
    server,
    store,
    recoverySupervisor,
    controlRuntime,
    auditSink,
    dataDirLease: options.dataDirLease || null,
  };
}

export async function startControlServer(options) {
  const dataDir = options.dataDir || path.resolve('.nado');
  const controlInstanceId = options.controlInstanceId || `control_${crypto.randomUUID()}`;
  const dataDirLease = options.dataDirLease || await acquireControlDataLease(dataDir, {
    controlInstanceId,
    timeoutMs: options.controlDataLeaseTimeoutMs,
    heartbeatMs: options.controlDataLeaseHeartbeatMs,
  });
  let created;
  try {
    created = await createControlServer({
      ...options,
      dataDir,
      controlInstanceId,
      dataDirLease,
    });
  } catch (error) {
    await dataDirLease.release().catch(() => {});
    throw error;
  }
  const {
    server,
    store,
    recoverySupervisor,
    controlRuntime,
    auditSink,
  } = created;
  const host = options.host || '127.0.0.1';
  const port = options.port === undefined ? 8765 : Number(options.port);

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (error) {
    recoverySupervisor.stop();
    store.closeClaimWaiters?.();
    await auditSink.close().catch(() => {});
    await dataDirLease.release().catch(() => {});
    throw error;
  }
  const address = server.address();
  return {
    server,
    store,
    recoverySupervisor,
    controlRuntime,
    auditSink,
    dataDirLease,
    host,
    port: address.port,
  };
}
