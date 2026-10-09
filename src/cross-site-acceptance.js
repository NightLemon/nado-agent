import { WORKER_CLOCK_WARNING_MS } from './clock-skew.js';
import { runtimeBuildCompatibility } from './runtime-build.js';

const EVIDENCE_VERSION = 1;
const CHECK_STATUSES = new Set(['passed', 'failed', 'pending']);
const EXERCISE_EVIDENCE_SOURCES = new Set(['automated_exercise', 'supervised_exercise']);

const BASE_MANUAL_SCENARIOS = [
  ['physicalSeparation', 'VM control and Worker are on different physical hosts and networks'],
  ['outboundOnlyOnboarding', 'Home Worker enrolled without router port forwarding or inbound firewall rules'],
  ['shortDisconnect', 'A short WAN interruption recovered before lease expiry on the same attempt'],
  ['longDisconnectRecovery', 'A long WAN interruption expired the lease, retried once, and rejected stale output'],
  ['remoteCancellation', 'VM cancellation stopped the process on the home Worker and reached a terminal state'],
  ['credentialRevocation', 'Worker credential rotation confirms the replacement and the revoked predecessor can no longer heartbeat, claim, or report'],
  ['vmRestartRecovery', 'Control restart preserved SQLite history and the home Worker reconnected'],
  ['workerRestartRecovery', 'Home Worker service stopped, became control-observed offline, and reconnected under the same signed identity as a new runtime'],
  ['largeArtifactResume', 'Interrupted large artifact upload resumed and matched the source SHA-256'],
  ['largeInputResume', 'Interrupted large input upload/download resumed and matched the source SHA-256'],
  ['backupRestore', 'A verified backup restored on a fresh control volume and completed a new task'],
];

const EXTRA_MANUAL_SCENARIOS = [
  ['agentCollaboration', 'A real terminal Agent completed useful work and returned evidence'],
  ['encryptedPrivateOverlay', 'Tailscale/WireGuard transport and ACLs were inspected'],
];

function manualScenarioDefinitions() {
  return new Map([...BASE_MANUAL_SCENARIOS, ...EXTRA_MANUAL_SCENARIOS]);
}

function check(key, status, summary, evidence = {}, options = {}) {
  return {
    key,
    status,
    required: options.required !== false,
    summary,
    evidence,
    nextAction: options.nextAction || null,
  };
}

function nonLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !(
      host === 'localhost'
      || host === '::1'
      || host === '0.0.0.0'
      || host === '::'
      || host.startsWith('127.')
    );
  } catch {
    return false;
  }
}

function nonLoopbackAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  if (!address || address === 'unknown' || address === 'localhost') {
    return false;
  }
  address = address.replace(/^\[|\]$/g, '').split('%')[0];
  if (address.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  return !(address === '::1' || address === '::' || address === '0.0.0.0' || address.startsWith('127.'));
}

const DEPLOYMENT_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEPLOYMENT_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function validateDeploymentEvidence(receipt, expectedControlUrl, options = {}) {
  const mode = receipt?.mode || null;
  const requiredKeys = mode === 'public_https'
    ? [
      'controlContainerHardening', 'httpsUrl', 'publicHealth', 'certificate', 'publicNetwork', 'proxyAuthenticated',
      'forwardedHttps', 'advertisedPublicUrl', 'backendSeparated', 'backendPrivateAddress',
      'backendHealth', 'backendNetwork', 'backendNotProxyAuthenticated', 'backendProxyBoundaryConfigured',
    ]
    : mode === 'private_overlay'
      ? [
        'controlContainerHardening', 'overlayAddress', 'overlayInterface', 'overlayEncryptedTransport', 'overlayPublishedBinding',
        'publicHealth', 'publicNetwork', 'overlayDirectRequest', 'advertisedPublicUrl',
      ]
      : [];
  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  const byKey = new Map(checks.map((item) => [item?.key, item]));
  const missingOrFailed = requiredKeys.filter((key) => byKey.get(key)?.status !== 'passed');
  const expected = String(expectedControlUrl || '').replace(/\/+$/, '');
  const observed = String(receipt?.publicControlUrl || '').replace(/\/+$/, '');
  const generatedAtMs = Date.parse(receipt?.generatedAt || '');
  const generatedAtValid = Number.isFinite(generatedAtMs);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : DEPLOYMENT_EVIDENCE_MAX_AGE_MS;
  const maxFutureSkewMs = Number.isFinite(Number(options.maxFutureSkewMs))
    ? Math.max(0, Number(options.maxFutureSkewMs))
    : DEPLOYMENT_EVIDENCE_MAX_FUTURE_SKEW_MS;
  const ageMs = generatedAtValid ? nowMs - generatedAtMs : null;
  const generatedAtFresh = generatedAtValid
    && ageMs <= maxAgeMs
    && ageMs >= -maxFutureSkewMs;
  const passed = Boolean(
    receipt
    && Number(receipt.reportVersion) === 2
    && receipt.ok === true
    && requiredKeys.length
    && generatedAtFresh
    && expected
    && observed === expected
    && missingOrFailed.length === 0
    && !checks.some((item) => item?.status === 'failed')
  );
  return {
    passed,
    evidence: {
      reportVersion: receipt?.reportVersion ?? null,
      mode,
      generatedAt: receipt?.generatedAt || null,
      generatedAtValid,
      generatedAtFresh,
      ageMs,
      maxAgeMs,
      maxFutureSkewMs,
      expectedControlUrl: expected || null,
      observedControlUrl: observed || null,
      receiptOk: receipt?.ok === true,
      requiredChecks: requiredKeys,
      missingOrFailed,
    },
  };
}

function evidenceScenarios(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Acceptance evidence must be a JSON object');
  }
  if (value.version !== undefined && Number(value.version) !== EVIDENCE_VERSION) {
    throw new Error(`Unsupported acceptance evidence version: ${value.version}`);
  }
  const scenarios = value.scenarios || {};
  if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) {
    throw new Error('Acceptance evidence scenarios must be an object');
  }
  return scenarios;
}

function normalizeManualRecord(key, definition, raw) {
  if (!raw) {
    return check(key, 'pending', definition, {}, {
      nextAction: `Execute the ${key} scenario on the real VM/home-host pair and record evidence`,
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || !CHECK_STATUSES.has(raw.status)) {
    throw new Error(`Acceptance evidence scenario ${key} must have status passed, failed, or pending`);
  }
  const note = String(raw.evidence || raw.note || '').trim();
  if ((raw.status === 'passed' || raw.status === 'failed') && !note) {
    throw new Error(`Acceptance evidence scenario ${key} requires a non-empty evidence note`);
  }
  const references = Array.isArray(raw.references)
    ? raw.references.map((item) => String(item).slice(0, 500)).slice(0, 30)
    : [];
  const unresolvedPlaceholder = /\bREPLACE_ME\b|<[^>]+>/i;
  if ((raw.status === 'passed' || raw.status === 'failed')
      && (unresolvedPlaceholder.test(note) || references.some((item) => unresolvedPlaceholder.test(item)))) {
    throw new Error(`Acceptance evidence scenario ${key} contains an unresolved placeholder`);
  }
  const source = EXERCISE_EVIDENCE_SOURCES.has(raw.source) ? raw.source : 'operator';
  const details = raw.details && typeof raw.details === 'object' && !Array.isArray(raw.details)
    ? JSON.parse(JSON.stringify(raw.details))
    : null;
  return check(key, raw.status, definition, {
    source,
    note,
    references,
    observedAt: raw.observedAt || null,
    ...(details ? { details } : {}),
  }, {
    nextAction: raw.status === 'pending'
      ? `Complete the ${key} scenario and attach task/event/log references`
      : null,
  });
}

function credentialRevocationReceipt(worker, manualCheck) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const verification = details.verification || {};
  const mode = details.mode || null;
  const workerId = details.workerId || null;
  const replacementTokenId = details.replacementTokenId || null;
  const predecessorTokenId = details.predecessorTokenId || null;
  const commandId = details.commandId || null;
  const currentTokenId = worker?.identity?.workerTokenId || null;
  const command = commandId
    ? (worker?.commands || []).find((item) => item.id === commandId) || null
    : null;
  const commandResult = command?.result || {};
  const baseVerified = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'automated_exercise'
    && worker
    && workerId === worker.id
    && replacementTokenId
    && predecessorTokenId
    && replacementTokenId !== predecessorTokenId
    && currentTokenId === replacementTokenId
    && verification.passed === true
    && verification.newTokenAccepted === true
    && verification.previousTokenRejected === true
    && Number(verification.previousTokenStatus) === 401
    && Number.isFinite(Date.parse(verification.checkedAt || evidence.observedAt || ''))
  );
  const durableCommandVerified = mode === 'control_triggered_rotation'
    && command?.action === 'rotate_token'
    && command?.status === 'completed'
    && commandResult.workerTokenId === replacementTokenId
    && commandResult.previousTokenId === predecessorTokenId
    && commandResult.verification?.passed === true
    && commandResult.verification?.newTokenAccepted === true
    && commandResult.verification?.previousTokenRejected === true
    && Number(commandResult.verification?.previousTokenStatus) === 401;
  const directVerified = mode === 'direct_verified_rotation' && !commandId;
  return {
    passed: Boolean(baseVerified && (durableCommandVerified || directVerified)),
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      mode,
      workerId,
      currentTokenId,
      replacementTokenId,
      predecessorTokenId,
      commandId,
      commandStatus: command?.status || null,
      newTokenAccepted: Boolean(verification.newTokenAccepted),
      predecessorTokenRejected: Boolean(verification.previousTokenRejected),
      predecessorStatus: verification.previousTokenStatus ?? null,
      checkedAt: verification.checkedAt || evidence.observedAt || null,
    },
  };
}

function remoteCancellationReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const cancelledEvent = task?.events?.find((item) => item.type === 'cancelled') || null;
  const commandEvent = details.commandEvent || {};
  const releasedEvent = details.processReleasedEvent || {};
  const durableCommandEvent = task?.events?.find((item) => (
    item.type === 'worker_cancel_applied'
    && item.workerId === details.workerId
  )) || null;
  const durableReleasedEvent = task?.events?.find((item) => (
    item.type === 'worker_process_released'
    && item.workerId === details.workerId
    && item.attemptId === details.attemptId
  )) || null;
  const workerBound = Boolean(
    task?.requestedWorkerId === worker?.id
    || task?.assignedWorkerId === worker?.id
    || attempt?.workerId === worker?.id
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'automated_exercise'
    && details.version === 1
    && details.exercise === 'remoteCancellation'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && task
    && task.title === 'nado cross-site remote cancellation exercise'
    && task.type === 'shell'
    && task.status === 'cancelled'
    && Number(task.maxAttempts) === 1
    && workerBound
    && attempt
    && cancelledEvent
    && details.taskStatus === 'cancelled'
    && commandEvent.type === 'command_applied'
    && commandEvent.action === 'cancel_current'
    && commandEvent.taskId === task.id
    && releasedEvent.type === 'task_released'
    && releasedEvent.taskId === task.id
    && releasedEvent.attemptId === attempt.id
    && durableCommandEvent
    && durableReleasedEvent
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      attemptId: details.attemptId || null,
      durableTaskFound: Boolean(task),
      durableTaskStatus: task?.status || null,
      durableCancelledEvent: Boolean(cancelledEvent),
      workerBound,
      commandAction: commandEvent.action || null,
      processReleased: releasedEvent.type === 'task_released',
      durableCommandApplied: Boolean(durableCommandEvent),
      durableProcessReleased: Boolean(durableReleasedEvent),
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function matchingArtifact(task, receipt) {
  if (!task || !receipt || !/^[a-f0-9]{64}$/i.test(String(receipt.sha256 || ''))) {
    return null;
  }
  return (task.artifacts || []).find((item) => (
    item.id === receipt.id
    && item.path === receipt.path
    && item.sha256 === receipt.sha256
    && Number(item.size) === Number(receipt.size)
    && Number(receipt.size) > 0
  )) || null;
}

function agentCollaborationReceipt(worker, manualCheck, tasks = [], sessions = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const session = sessions.find((item) => item.id === details.sessionId) || null;
  const receiptTaskIds = Array.isArray(details.taskIds) ? details.taskIds : [];
  const receiptTasks = Array.isArray(details.tasks) ? details.tasks : [];
  const receiptArtifacts = Array.isArray(details.artifacts) ? details.artifacts : [];
  const durableTasks = receiptTaskIds.map((id) => tasks.find((item) => item.id === id) || null);
  const expectedTitles = [
    'Nado Agent collaboration plan',
    'Nado Agent collaboration review and handoff',
  ];
  const expectedPaths = ['agent-plan.md', 'agent-final.md', '.nado-session/transcript.md'];
  const taskStateMatches = durableTasks.length === 2 && durableTasks.every((task, index) => {
    const receiptTask = receiptTasks.find((item) => item.id === task?.id);
    const attempt = task?.attempts?.find((item) => item.id === receiptTask?.attemptId) || null;
    return Boolean(
      task
      && task.title === expectedTitles[index]
      && task.type === 'agent'
      && task.sessionId === details.sessionId
      && task.status === 'succeeded'
      && task.assignedWorkerId === worker?.id
      && Number(task.maxAttempts) === 1
      && receiptTask?.status === 'succeeded'
      && receiptTask.assignedWorkerId === worker?.id
      && attempt
      && attempt.status === 'succeeded'
      && attempt.workerId === worker?.id
    );
  });
  const artifactStateMatches = receiptArtifacts.length === 3
    && expectedPaths.every((artifactPath) => {
      const receipt = receiptArtifacts.find((item) => item.path === artifactPath);
      const task = durableTasks.find((item) => item?.id === receipt?.taskId);
      return Boolean(matchingArtifact(task, receipt));
    });
  const sessionStateMatches = Boolean(
    session
    && session.status === 'closed'
    && session.assignedWorkerId === worker?.id
    && session.requestedWorkerId === worker?.id
    && Array.isArray(session.requiredCapabilities)
    && session.requiredCapabilities.includes('agent')
    && receiptTaskIds.length === 2
    && session.taskIds?.length === 2
    && session.taskIds.every((id, index) => id === receiptTaskIds[index])
    && session.events?.some((item) => item.type === 'closed')
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'automated_exercise'
    && details.version === 1
    && details.exercise === 'agentCollaboration'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && details.sessionStatus === 'closed'
    && /^[a-f0-9]{64}$/i.test(String(details.markerSha256 || ''))
    && sessionStateMatches
    && taskStateMatches
    && artifactStateMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      sessionId: details.sessionId || null,
      durableSessionFound: Boolean(session),
      durableSessionClosed: session?.status === 'closed',
      sessionStateMatches,
      taskIds: receiptTaskIds,
      durableTaskCount: durableTasks.filter(Boolean).length,
      taskStateMatches,
      artifactCount: receiptArtifacts.length,
      artifactStateMatches,
      markerDigestPresent: /^[a-f0-9]{64}$/i.test(String(details.markerSha256 || '')),
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function shortDisconnectReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const gapEvent = task?.events?.find((item) => (
    item.type === 'short_disconnect_gap_observed'
    && item.workerId === details.workerId
    && item.attemptId === details.attemptId
  )) || null;
  const recoveryEvent = task?.events?.find((item) => (
    item.type === 'short_disconnect_recovered'
    && item.workerId === details.workerId
    && item.attemptId === details.attemptId
  )) || null;
  const gapMatches = Boolean(
    gapEvent
    && gapEvent.at === details.observedGap?.observedAt
    && Number(gapEvent.data?.minDisconnectMs) === Number(details.minDisconnectMs)
    && Number(gapEvent.data?.workerAgeMs) === Number(details.observedGap?.ageMs)
    && gapEvent.data?.workerLastSeenAt === details.observedGap?.lastSeenAt
    && gapEvent.data?.leaseRenewedAt === details.observedGap?.leaseRenewedAt
    && gapEvent.data?.leaseExpiresAt === details.observedGap?.leaseExpiresAt
    && Number(gapEvent.data?.workerAgeMs) >= Number(details.minDisconnectMs)
    && Date.parse(gapEvent.data?.leaseExpiresAt || '') > Date.parse(gapEvent.at || '')
  );
  const recoveryMatches = Boolean(
    recoveryEvent
    && recoveryEvent.at === details.recovery?.recoveredAt
    && recoveryEvent.data?.gapObservedAt === gapEvent?.at
    && recoveryEvent.data?.workerLastSeenAt === details.recovery?.workerLastSeenAt
    && Number(recoveryEvent.data?.workerAgeMs) === Number(details.recovery?.workerAgeMs)
    && recoveryEvent.data?.leaseRenewedAt === details.recovery?.leaseRenewedAt
    && recoveryEvent.data?.leaseExpiresAt === details.recovery?.leaseExpiresAt
    && Number(recoveryEvent.data?.workerAgeMs) < 3_000
    && Date.parse(recoveryEvent.data?.leaseRenewedAt || '') > Date.parse(gapEvent?.data?.leaseRenewedAt || '')
    && Date.parse(recoveryEvent.data?.leaseExpiresAt || '') > Date.parse(recoveryEvent.at || '')
  );
  const artifactMatches = Boolean(
    details.artifact?.path === 'short-disconnect.txt'
    && matchingArtifact(task, details.artifact)
  );
  const taskMatches = Boolean(
    task
    && task.title === 'nado cross-site short disconnect exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker?.id
    && task.assignedWorkerId === worker?.id
    && Number(task.maxAttempts) === 1
    && task.attempts?.length === 1
    && attempt?.status === 'succeeded'
    && attempt.workerId === worker?.id
    && Number(details.attemptCount) === 1
    && details.taskStatus === 'succeeded'
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'shortDisconnect'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && Number(details.minDisconnectMs) >= 2_000
    && taskMatches
    && gapMatches
    && recoveryMatches
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      attemptId: details.attemptId || null,
      durableTaskFound: Boolean(task),
      taskMatches,
      gapMatched: gapMatches,
      recoveryMatched: recoveryMatches,
      observedAgeMs: gapEvent?.data?.workerAgeMs ?? null,
      gapLeaseRenewedAt: gapEvent?.data?.leaseRenewedAt || null,
      recoveryLeaseRenewedAt: recoveryEvent?.data?.leaseRenewedAt || null,
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function longDisconnectRecoveryReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const receiptAttempts = Array.isArray(details.attempts) ? details.attempts : [];
  const attempts = task?.attempts || [];
  const firstAttempt = attempts[0] || null;
  const secondAttempt = attempts[1] || null;
  const recoveryEvent = task?.events?.find((item) => (
    item.type === 'lease_recovered'
    && item.data?.previousWorkerId === details.workerId
  )) || null;
  const rejectionTypes = new Set(['expired_lease_result_ignored', 'stale_result_ignored', 'late_result_ignored']);
  const rejectionEvent = task?.events?.find((item) => (
    rejectionTypes.has(item.type)
    && item.data?.resultAttemptId === firstAttempt?.id
  )) || null;
  const firstExecution = task?.events?.find((item) => (
    item.type === 'stdout'
    && item.message?.includes('nado-long-disconnect-attempt-1-ready')
  )) || null;
  const receiptFirst = receiptAttempts.find((item) => item.id === firstAttempt?.id) || null;
  const receiptSecond = receiptAttempts.find((item) => item.id === secondAttempt?.id) || null;
  const attemptsMatch = Boolean(
    attempts.length === 2
    && receiptAttempts.length === 2
    && firstAttempt?.status === 'lease_expired'
    && firstAttempt.workerId === details.workerId
    && Number(firstAttempt.seq) === 1
    && receiptFirst?.status === firstAttempt.status
    && receiptFirst.workerId === firstAttempt.workerId
    && Number(receiptFirst.seq) === Number(firstAttempt.seq)
    && secondAttempt?.id
    && secondAttempt.id !== firstAttempt.id
    && secondAttempt.status === 'succeeded'
    && secondAttempt.workerId === details.finalWorkerId
    && Number(secondAttempt.seq) === 2
    && receiptSecond?.status === secondAttempt.status
    && receiptSecond.workerId === secondAttempt.workerId
    && Number(receiptSecond.seq) === Number(secondAttempt.seq)
  );
  const recoveryMatches = Boolean(
    recoveryEvent
    && details.recoveryEvent?.type === recoveryEvent.type
    && details.recoveryEvent?.at === recoveryEvent.at
    && details.recoveryEvent?.previousWorkerId === details.workerId
    && details.recoveryEvent?.recoveryReason === recoveryEvent.data?.recoveryReason
  );
  const rejectionMatches = Boolean(
    rejectionEvent
    && details.staleResultRejection?.type === rejectionEvent.type
    && details.staleResultRejection?.at === rejectionEvent.at
    && details.staleResultRejection?.resultAttemptId === firstAttempt?.id
    && details.staleResultRejection?.currentAttemptId === rejectionEvent.data?.currentAttemptId
  );
  const artifactMatches = Boolean(
    details.artifact?.path === 'long-disconnect.json'
    && matchingArtifact(task, details.artifact)
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'longDisconnectRecovery'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && details.finalWorkerId === worker.id
    && details.originalWorkerReconnected === true
    && details.deliverySemantics === 'at-least-once'
    && task
    && task.title === 'nado cross-site long disconnect recovery exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker.id
    && task.assignedWorkerId === worker.id
    && Number(task.maxAttempts) === 2
    && Number(task.retryBackoffMs) === 0
    && Number(task.maxRetryBackoffMs) === 0
    && Number(details.leaseDurationMs) > 0
    && Number(details.recoveryScanIntervalMs) > 0
    && attemptsMatch
    && recoveryMatches
    && rejectionMatches
    && firstExecution
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      durableTaskFound: Boolean(task),
      durableTaskStatus: task?.status || null,
      attemptsMatch,
      firstAttemptStatus: firstAttempt?.status || null,
      secondAttemptStatus: secondAttempt?.status || null,
      leaseRecoveryMatched: recoveryMatches,
      staleResultRejectionMatched: rejectionMatches,
      firstExecutionObserved: Boolean(firstExecution),
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function vmRestartRecoveryReceipt(worker, manualCheck, tasks = [], status = {}) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const originalRuntime = details.controlRestart?.original || {};
  const restartedRuntime = details.controlRestart?.restarted || {};
  const currentRuntime = status.runtime || {};
  const unavailable = Array.isArray(details.controlRestart?.unavailableObservations)
    ? details.controlRestart.unavailableObservations
    : [];
  const runtimeMatches = Boolean(
    originalRuntime.instanceId
    && restartedRuntime.instanceId
    && originalRuntime.instanceId !== restartedRuntime.instanceId
    && task?.createdControlInstanceId === originalRuntime.instanceId
    && currentRuntime.instanceId === restartedRuntime.instanceId
    && Number.isFinite(Date.parse(originalRuntime.startedAt || ''))
    && Number.isFinite(Date.parse(restartedRuntime.startedAt || ''))
    && Date.parse(restartedRuntime.startedAt) > Date.parse(originalRuntime.startedAt)
    && details.controlRestart?.outageObserved === true
    && unavailable.length > 0
    && unavailable.every((item) => Number.isFinite(Date.parse(item.at || '')))
  );
  const workerReconnected = Boolean(
    details.workerRecovery?.gatewayState
    && Number.isFinite(Date.parse(details.workerRecovery?.recoveredAt || ''))
    && Number.isFinite(Date.parse(details.workerRecovery?.lastSeenAt || ''))
    && Date.parse(details.workerRecovery.lastSeenAt) >= Date.parse(restartedRuntime.startedAt || '')
    && Number.isFinite(Date.parse(worker?.lastSeenAt || ''))
    && Date.parse(worker.lastSeenAt) >= Date.parse(restartedRuntime.startedAt || '')
  );
  const artifactMatches = Boolean(
    details.artifact?.path === 'vm-restart-recovery.json'
    && Number(details.artifact.executionCount) === 1
    && Number(details.artifact.completionCount) === 1
    && matchingArtifact(task, details.artifact)
  );
  const taskMatches = Boolean(
    task
    && task.title === 'nado cross-site VM restart recovery exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker?.id
    && task.assignedWorkerId === worker?.id
    && Number(task.maxAttempts) === 1
    && task.attempts?.length === 1
    && attempt
    && attempt.status === 'succeeded'
    && attempt.workerId === worker?.id
    && Number(attempt.seq) === 1
    && details.taskStatus === 'succeeded'
    && Number(details.attemptCount) === 1
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'vmRestartRecovery'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && status.storage?.backend === 'sqlite'
    && details.storage?.backend === 'sqlite'
    && runtimeMatches
    && workerReconnected
    && taskMatches
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      originalInstanceId: originalRuntime.instanceId || null,
      restartedInstanceId: restartedRuntime.instanceId || null,
      currentInstanceId: currentRuntime.instanceId || null,
      taskCreatedInstanceId: task?.createdControlInstanceId || null,
      outageObservationCount: unavailable.length,
      runtimeMatches,
      durableTaskFound: Boolean(task),
      taskMatches,
      workerReconnected,
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function workerRestartRecoveryReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const originalRuntime = details.runtimeRestart?.original || {};
  const restartedRuntime = details.runtimeRestart?.restarted || {};
  const offline = details.offlineObservation || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const tokenId = details.tokenContinuity?.workerTokenId || null;
  const runtimeEvent = (worker?.events || []).find((event) => (
    event.type === 'runtime_started'
    && event.data?.controlObserved === true
    && event.data?.runtimeId === restartedRuntime.id
    && event.data?.previousRuntimeId === originalRuntime.id
    && event.data?.workerTokenId === tokenId
  )) || null;
  const offlineObserved = Boolean(
    offline.runtimeId === originalRuntime.id
    && Number(offline.ageMs) > 0
    && Number.isFinite(Date.parse(offline.observedAt || ''))
    && Number.isFinite(Date.parse(offline.lastSeenAt || ''))
    && Date.parse(offline.observedAt) > Date.parse(offline.lastSeenAt)
  );
  const runtimeMatches = Boolean(
    originalRuntime.id
    && restartedRuntime.id
    && originalRuntime.id !== restartedRuntime.id
    && worker?.runtime?.id === restartedRuntime.id
    && worker.runtime.startedAt === restartedRuntime.startedAt
    && Number.isFinite(Date.parse(originalRuntime.startedAt || ''))
    && Number.isFinite(Date.parse(restartedRuntime.startedAt || ''))
    && Date.parse(restartedRuntime.startedAt) > Date.parse(originalRuntime.startedAt)
    && runtimeEvent
    && runtimeEvent.at === details.runtimeRestart?.eventAt
    && runtimeEvent.data?.runtimeStartedAt === restartedRuntime.startedAt
    && Date.parse(runtimeEvent.at) >= Date.parse(offline.observedAt || '')
  );
  const tokenMatches = Boolean(
    tokenId
    && details.tokenContinuity?.unchanged === true
    && worker?.identity?.type === 'worker_token'
    && worker.identity.signed === true
    && worker.identity.workerTokenId === tokenId
  );
  const workerReconnected = Boolean(
    details.workerRecovery?.gatewayState
    && details.workerRecovery.gatewayState !== 'offline'
    && Number.isFinite(Date.parse(details.workerRecovery?.reconnectedAt || ''))
    && Number.isFinite(Date.parse(details.workerRecovery?.lastSeenAt || ''))
    && Date.parse(details.workerRecovery.lastSeenAt) >= Date.parse(runtimeEvent?.at || '')
    && Number.isFinite(Date.parse(worker?.lastSeenAt || ''))
    && Date.parse(worker.lastSeenAt) >= Date.parse(runtimeEvent?.at || '')
  );
  const taskMatches = Boolean(
    task
    && task.title === 'nado cross-site Worker restart recovery exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker?.id
    && task.assignedWorkerId === worker?.id
    && Number(task.maxAttempts) === 1
    && task.attempts?.length === 1
    && attempt
    && attempt.status === 'succeeded'
    && attempt.workerId === worker?.id
    && Number(attempt.seq) === 1
    && Number.isFinite(Date.parse(task.createdAt || ''))
    && Date.parse(task.createdAt) >= Date.parse(runtimeEvent?.at || '')
    && details.taskStatus === 'succeeded'
  );
  const artifactMatches = Boolean(
    details.artifact?.path === 'worker-restart-recovery.json'
    && details.artifact.runtimeId === restartedRuntime.id
    && details.artifact.runtimeStartedAt === restartedRuntime.startedAt
    && matchingArtifact(task, details.artifact)
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'workerRestartRecovery'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && offlineObserved
    && runtimeMatches
    && tokenMatches
    && workerReconnected
    && taskMatches
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      originalRuntimeId: originalRuntime.id || null,
      restartedRuntimeId: restartedRuntime.id || null,
      currentRuntimeId: worker?.runtime?.id || null,
      workerTokenId: tokenId,
      offlineObserved,
      offlineAgeMs: offline.ageMs ?? null,
      controlRuntimeEventMatched: Boolean(runtimeEvent),
      runtimeMatches,
      tokenMatches,
      workerReconnected,
      taskMatches,
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function largeArtifactResumeReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const upload = details.upload || {};
  const progressEvents = (task?.events || []).filter((item) => (
    item.type === 'artifact_upload_progress'
    && item.attemptId === details.attemptId
    && item.data?.uploadId === upload.id
  ));
  const firstEvent = progressEvents.find((item) => Number(item.data?.committedBytes) === Number(upload.firstObservedOffset)) || null;
  const stalledEvent = progressEvents.find((item) => Number(item.data?.committedBytes) === Number(upload.stalledOffset)) || null;
  const finalizedEvent = (task?.events || []).find((item) => (
    item.type === 'artifact_upload_finalized'
    && item.attemptId === details.attemptId
    && item.data?.uploadId === upload.id
    && Number(item.data?.committedBytes) === Number(upload.size)
    && item.data?.sha256 === upload.sha256
  )) || null;
  const durableGapMs = stalledEvent && finalizedEvent
    ? Date.parse(finalizedEvent.at) - Date.parse(stalledEvent.at)
    : 0;
  const artifact = task?.artifacts?.find((item) => item.id === details.artifact?.id) || null;
  const uploadStateMatches = Boolean(
    upload.id
    && upload.path === 'large-artifact-resume.bin'
    && /^[a-f0-9]{64}$/i.test(String(upload.sha256 || ''))
    && Number(upload.size) >= 128 * 1024
    && Number(upload.firstObservedOffset) > 0
    && Number(upload.firstObservedOffset) < Number(upload.size)
    && Number(upload.stalledOffset) >= Number(upload.firstObservedOffset)
    && Number(upload.stalledOffset) < Number(upload.size)
    && Number(upload.finalizedOffset) === Number(upload.size)
    && Number(upload.stalledForMs) >= 2_000
    && firstEvent
    && stalledEvent
    && finalizedEvent
    && durableGapMs >= Number(upload.stalledForMs)
  );
  const artifactMatches = Boolean(
    artifact
    && artifact.uploadId === upload.id
    && details.artifact?.uploadId === upload.id
    && details.artifact?.path === upload.path
    && details.artifact?.size === upload.size
    && details.artifact?.sha256 === upload.sha256
    && matchingArtifact(task, details.artifact)
  );
  const taskMatches = Boolean(
    task
    && task.title === 'nado cross-site large artifact resume exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker?.id
    && task.assignedWorkerId === worker?.id
    && Number(task.maxAttempts) === 1
    && task.attempts?.length === 1
    && attempt?.status === 'succeeded'
    && attempt.workerId === worker?.id
    && Number(details.attemptCount) === 1
  );
  const recoveryAfterGap = Boolean(
    Number.isFinite(Date.parse(details.disconnect?.observedAt || ''))
    && Number.isFinite(Date.parse(details.recovery?.recoveredAt || ''))
    && Date.parse(details.recovery.recoveredAt) >= Date.parse(details.disconnect.observedAt)
    && Number(details.disconnect?.workerAgeMs) >= 2_000
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'largeArtifactResume'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && taskMatches
    && uploadStateMatches
    && recoveryAfterGap
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      attemptId: details.attemptId || null,
      uploadId: upload.id || null,
      durableTaskFound: Boolean(task),
      taskMatches,
      progressEventCount: progressEvents.length,
      durableGapMs,
      uploadStateMatches,
      recoveryAfterGap,
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function largeInputResumeReceipt(worker, manualCheck, tasks = []) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const task = tasks.find((item) => item.id === details.taskId) || null;
  const attempt = task?.attempts?.find((item) => item.id === details.attemptId) || null;
  const input = details.input || {};
  const descriptor = task?.inputFiles?.find((item) => item.inputUploadId === input.id) || null;
  const rangeEvents = (task?.events || []).filter((item) => (
    item.type === 'input_download_range'
    && item.data?.inputId === input.id
    && item.data?.attemptId === details.attemptId
  ));
  const initialEvent = rangeEvents.find((item) => Number(item.data?.offset) === 0 && item.data?.resumed === false) || null;
  const resumedEvent = rangeEvents.find((item) => (
    Number(item.data?.offset) === Number(input.resumedOffset)
    && item.data?.resumed === true
    && item.at === details.recovery?.rangeEventAt
  )) || null;
  const durableGapMs = initialEvent && resumedEvent ? Date.parse(resumedEvent.at) - Date.parse(initialEvent.at) : 0;
  const inputStateMatches = Boolean(
    descriptor
    && input.path === 'large-input-resume.bin'
    && descriptor.path === input.path
    && Number(descriptor.size) === Number(input.size)
    && descriptor.sha256 === input.sha256
    && descriptor.ready === true
    && /^[a-f0-9]{64}$/i.test(String(input.sha256 || ''))
    && Number(input.size) >= 128 * 1024
    && Number(input.initialOffset) === 0
    && Number(input.resumedOffset) > 0
    && Number(input.resumedOffset) < Number(input.size)
    && initialEvent
    && resumedEvent
    && durableGapMs >= 2_000
  );
  const artifactMatches = Boolean(
    details.artifact?.path === 'large-input-resume.json'
    && matchingArtifact(task, details.artifact)
  );
  const taskMatches = Boolean(
    task
    && task.title === 'nado cross-site large input resume exercise'
    && task.type === 'shell'
    && task.status === 'succeeded'
    && task.requestedWorkerId === worker?.id
    && task.assignedWorkerId === worker?.id
    && Number(task.maxAttempts) === 1
    && task.attempts?.length === 1
    && attempt?.status === 'succeeded'
    && attempt.workerId === worker?.id
    && Number(details.attemptCount) === 1
  );
  const recoveryAfterGap = Boolean(
    Number.isFinite(Date.parse(details.disconnect?.observedAt || ''))
    && Number.isFinite(Date.parse(details.recovery?.recoveredAt || ''))
    && Date.parse(details.recovery.recoveredAt) >= Date.parse(details.disconnect.observedAt)
    && Number(details.disconnect?.workerAgeMs) >= 2_000
    && resumedEvent
    && Date.parse(resumedEvent.at) >= Date.parse(details.disconnect.observedAt)
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'largeInputResume'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && taskMatches
    && inputStateMatches
    && recoveryAfterGap
    && artifactMatches
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      taskId: details.taskId || null,
      attemptId: details.attemptId || null,
      inputId: input.id || null,
      durableTaskFound: Boolean(task),
      taskMatches,
      rangeEventCount: rangeEvents.length,
      durableGapMs,
      inputStateMatches,
      recoveryAfterGap,
      artifactMatched: artifactMatches,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function backupRestoreReceipt(worker, manualCheck, tasks = [], status = {}) {
  const evidence = manualCheck?.evidence || {};
  const details = evidence.details || {};
  const markerTask = tasks.find((item) => item.id === details.markerTask?.id) || null;
  const postTask = tasks.find((item) => item.id === details.postRestoreTask?.id) || null;
  const markerAttempt = markerTask?.attempts?.find((item) => item.id === details.markerTask?.attemptId) || null;
  const postAttempt = postTask?.attempts?.find((item) => item.id === details.postRestoreTask?.attemptId) || null;
  const markerArtifact = markerTask?.artifacts?.find((item) => item.id === details.markerTask?.artifactId) || null;
  const postArtifact = postTask?.artifacts?.find((item) => item.id === details.postRestoreTask?.artifactId) || null;
  const originalRuntime = details.controlRestart?.original || {};
  const restartedRuntime = details.controlRestart?.restarted || {};
  const currentRuntime = status.runtime || {};
  const currentReceipt = status.storage?.restoreReceipt || null;
  const receipt = details.restoreReceipt || {};
  const receiptKeys = [
    'format', 'formatVersion', 'id', 'restoredAt', 'sourceCreatedAt', 'manifestSha256',
    'backend', 'stateVersion', 'sqliteSchemaVersion', 'fileCount', 'totalBytes',
  ];
  const receiptMatches = Boolean(
    currentReceipt
    && receiptKeys.every((key) => currentReceipt[key] === receipt[key])
    && /^restore_[0-9a-f-]{36}$/.test(String(receipt.id || ''))
    && /^[a-f0-9]{64}$/.test(String(receipt.manifestSha256 || ''))
    && receipt.backend === 'sqlite'
    && Number.isFinite(Date.parse(receipt.restoredAt || ''))
    && Number.isFinite(Date.parse(receipt.sourceCreatedAt || ''))
    && Date.parse(receipt.restoredAt) >= Date.parse(receipt.sourceCreatedAt)
    && Number.isSafeInteger(receipt.fileCount)
    && receipt.fileCount > 0
    && Number.isSafeInteger(receipt.totalBytes)
    && receipt.totalBytes > 0
  );
  const unavailable = Array.isArray(details.controlRestart?.unavailableObservations)
    ? details.controlRestart.unavailableObservations
    : [];
  const runtimeMatches = Boolean(
    originalRuntime.instanceId
    && restartedRuntime.instanceId
    && originalRuntime.instanceId !== restartedRuntime.instanceId
    && markerTask?.createdControlInstanceId === originalRuntime.instanceId
    && postTask?.createdControlInstanceId === restartedRuntime.instanceId
    && currentRuntime.instanceId === restartedRuntime.instanceId
    && details.controlRestart?.outageObserved === true
    && unavailable.length > 0
    && unavailable.every((item) => Number.isFinite(Date.parse(item.at || '')))
    && Number.isFinite(Date.parse(originalRuntime.startedAt || ''))
    && Number.isFinite(Date.parse(restartedRuntime.startedAt || ''))
    && Date.parse(restartedRuntime.startedAt) > Date.parse(originalRuntime.startedAt)
    && Date.parse(restartedRuntime.startedAt) >= Date.parse(receipt.restoredAt || '')
  );
  const taskMatches = Boolean(
    markerTask
    && markerTask.title === 'nado backup restore pre-backup marker'
    && markerTask.type === 'shell'
    && markerTask.status === 'succeeded'
    && markerTask.requestedWorkerId === worker?.id
    && markerTask.assignedWorkerId === worker?.id
    && markerTask.attempts?.length === 1
    && markerAttempt?.status === 'succeeded'
    && markerAttempt.workerId === worker?.id
    && postTask
    && postTask.title === 'nado backup restore post-restore write probe'
    && postTask.type === 'shell'
    && postTask.status === 'succeeded'
    && postTask.requestedWorkerId === worker?.id
    && postTask.assignedWorkerId === worker?.id
    && postTask.attempts?.length === 1
    && postAttempt?.status === 'succeeded'
    && postAttempt.workerId === worker?.id
  );
  const artifactsMatch = Boolean(
    markerArtifact
    && markerArtifact.path === 'backup-restore-marker.json'
    && markerArtifact.sha256 === details.markerTask?.artifactSha256
    && /^[a-f0-9]{64}$/i.test(String(markerArtifact.sha256 || ''))
    && Number(markerArtifact.size) > 0
    && postArtifact
    && postArtifact.path === 'backup-restore-post.json'
    && postArtifact.sha256 === details.postRestoreTask?.artifactSha256
    && /^[a-f0-9]{64}$/i.test(String(postArtifact.sha256 || ''))
    && Number(postArtifact.size) > 0
  );
  const workerReconnected = Boolean(
    Number.isFinite(Date.parse(details.workerRecovery?.recoveredAt || ''))
    && Number.isFinite(Date.parse(details.workerRecovery?.lastSeenAt || ''))
    && Date.parse(details.workerRecovery.lastSeenAt) >= Date.parse(restartedRuntime.startedAt || '')
    && Number.isFinite(Date.parse(worker?.lastSeenAt || ''))
    && Date.parse(worker.lastSeenAt) >= Date.parse(restartedRuntime.startedAt || '')
  );
  const passed = Boolean(
    manualCheck?.status === 'passed'
    && evidence.source === 'supervised_exercise'
    && details.version === 1
    && details.exercise === 'backupRestore'
    && details.ok === true
    && worker
    && details.workerId === worker.id
    && status.storage?.backend === 'sqlite'
    && receiptMatches
    && runtimeMatches
    && taskMatches
    && artifactsMatch
    && workerReconnected
    && Number.isFinite(Date.parse(details.startedAt || ''))
    && Number.isFinite(Date.parse(details.completedAt || evidence.observedAt || ''))
  );
  return {
    passed,
    status: manualCheck?.status || 'pending',
    evidence: {
      source: evidence.source || null,
      workerId: details.workerId || null,
      restoreReceiptId: receipt.id || null,
      currentRestoreReceiptId: currentReceipt?.id || null,
      manifestSha256: receipt.manifestSha256 || null,
      originalInstanceId: originalRuntime.instanceId || null,
      restartedInstanceId: restartedRuntime.instanceId || null,
      currentInstanceId: currentRuntime.instanceId || null,
      markerTaskId: details.markerTask?.id || null,
      postRestoreTaskId: details.postRestoreTask?.id || null,
      receiptMatches,
      runtimeMatches,
      taskMatches,
      artifactsMatch,
      workerReconnected,
      completedAt: details.completedAt || evidence.observedAt || null,
    },
  };
}

function automaticChecks({ network, status, capabilities, worker, requirements, verifyResult, manualByKey, tasks, sessions, deploymentEvidence }) {
  const checks = [];
  const remoteUrl = network.preferredRemoteControlUrl || network.publicControlUrl || null;
  const remoteReady = Boolean(network.remoteWorkerReady && remoteUrl && nonLoopbackUrl(remoteUrl));
  checks.push(check(
    'remoteControlUrl',
    remoteReady ? 'passed' : 'failed',
    'A non-loopback Control URL is available for remote Workers',
    { remoteUrl, networkNextAction: network.nextAction?.code || null },
    { nextAction: remoteReady ? null : 'Configure NADO_PUBLIC_CONTROL_URL or a usable overlay/LAN URL' },
  ));

  if (requirements.requireDeploymentEvidence) {
    const deploymentReceipt = validateDeploymentEvidence(deploymentEvidence, remoteUrl);
    checks.push(check(
      'deploymentBoundaryReceipt',
      deploymentReceipt.passed ? 'passed' : 'failed',
      'The strict report is bound to a successful deployment check for this Control URL',
      deploymentReceipt.evidence,
      { nextAction: deploymentReceipt.passed ? null : 'Run deployment check now for the current public/overlay URL and pass its fresh JSON with --deployment-evidence' },
    ));
  }

  if (requirements.requireAgent) {
    const collaborationReceipt = agentCollaborationReceipt(
      worker,
      manualByKey.get('agentCollaboration'),
      tasks,
      sessions,
    );
    checks.push(check(
      'agentCollaborationReceipt',
      collaborationReceipt.passed ? 'passed' : (collaborationReceipt.status === 'pending' ? 'pending' : 'failed'),
      'Agent collaboration evidence is generated by the exercise and bound to its closed Worker-affine session, two durable Agent attempts, and three returned artifacts',
      collaborationReceipt.evidence,
      {
        nextAction: collaborationReceipt.passed
          ? null
          : 'Run acceptance exercise agent-collaboration --worker <id> --evidence <file> on the selected verified terminal-Agent Worker, then regenerate the report',
      },
    ));
  }

  let protocol = null;
  try { protocol = new URL(remoteUrl).protocol; } catch {}
  const overlayEvidence = manualByKey.get('encryptedPrivateOverlay');
  const connection = worker?.connection || {};
  const proxyEvidenceAuthenticated = !connection.trustedProxy || connection.proxyAuthenticated === true;
  const observedProtocol = String(connection.protocol || '').toLowerCase().replace(/:$/, '');
  const observedHttps = observedProtocol === 'https' && proxyEvidenceAuthenticated;
  const overlayPassed = overlayEvidence?.status === 'passed';
  const transportPassed = observedHttps || overlayPassed;
  const transportStatus = transportPassed
    ? 'passed'
    : overlayEvidence?.status === 'failed'
      || (protocol === 'https:' && observedProtocol === 'http')
      || (connection.trustedProxy && !proxyEvidenceAuthenticated)
      ? 'failed'
      : 'pending';
  checks.push(check(
    'encryptedTransport',
    transportStatus,
    'The selected Worker actually uses HTTPS or an operator-verified encrypted private overlay',
    {
      advertisedProtocol: protocol,
      observedWorkerProtocol: observedProtocol || null,
      observedWorkerTrustedProxy: Boolean(connection.trustedProxy),
      observedWorkerProxyAuthenticated: Boolean(connection.proxyAuthenticated),
      proxyEvidenceAuthenticated,
      publicHttpsAdvertised: protocol === 'https:',
      observedHttps,
      privateOverlayEvidence: overlayEvidence?.evidence || null,
    },
    {
      nextAction: transportPassed
        ? null
        : protocol === 'https:' && observedProtocol === 'http'
          || (connection.trustedProxy && !proxyEvidenceAuthenticated)
          ? 'The selected Worker bypassed HTTPS or used unauthenticated proxy evidence; configure NADO_TRUST_PROXY_SECRET on Nado and X-Nado-Proxy-Secret on the TLS proxy, close direct control-port access, then reconnect it'
          : 'Terminate TLS or record encryptedPrivateOverlay evidence for Tailscale/WireGuard',
    },
  ));

  const workerOnline = Boolean(worker && worker.adminState === 'enabled' && worker.active && worker.gatewayState !== 'offline');
  checks.push(check(
    'targetWorkerOnline',
    workerOnline ? 'passed' : 'failed',
    'The selected home Worker is active and administratively enabled',
    worker ? {
      workerId: worker.id,
      gatewayState: worker.gatewayState,
      adminState: worker.adminState,
      ageMs: worker.ageMs,
    } : { workerId: requirements.workerId },
    { nextAction: workerOnline ? null : 'Start/reconnect the selected Worker and inspect preflight plus Worker events' },
  ));

  const buildCompatibility = runtimeBuildCompatibility(status.runtime?.build, worker?.runtime?.build);
  const buildStatus = buildCompatibility.status === 'compatible'
    ? 'passed'
    : buildCompatibility.status === 'unknown'
      ? 'pending'
      : 'failed';
  checks.push(check(
    'runtimeBuildCompatibility',
    buildStatus,
    'The selected Worker and Control run the same protocol-compatible build',
    {
      compatibility: buildCompatibility.status,
      reason: buildCompatibility.reason,
      control: status.runtime?.build || null,
      worker: worker?.runtime?.build || null,
    },
    {
      nextAction: buildStatus === 'passed'
        ? null
        : buildCompatibility.status === 'protocol_mismatch'
          ? 'Upgrade Control and the selected Worker to the same protocol release, restart both, and wait for a fresh heartbeat'
          : buildCompatibility.status === 'build_mismatch'
            ? 'Redeploy Control and the selected Worker from the same immutable build, restart both, and wait for a fresh heartbeat'
            : 'Upgrade/restart Control and the selected Worker so both publish comparable runtime build evidence',
    },
  ));

  const forwardedSource = connection.addressSource === 'x-forwarded-for';
  const authenticatedForwardedSource = !forwardedSource
    || (connection.trustedProxy === true && connection.proxyAuthenticated === true);
  const remoteWorkerSource = nonLoopbackAddress(connection.remoteAddress) && authenticatedForwardedSource;
  checks.push(check(
    'targetWorkerRemoteSource',
    remoteWorkerSource ? 'passed' : 'failed',
    'The control plane observes the selected Worker from a non-loopback source address',
    {
      remoteAddress: connection.remoteAddress || null,
      addressSource: connection.addressSource || null,
      protocol: connection.protocol || null,
      trustedProxy: Boolean(connection.trustedProxy),
      proxyAuthenticated: Boolean(connection.proxyAuthenticated),
      forwardedSourceAuthenticated: authenticatedForwardedSource,
      observedAt: connection.observedAt || null,
    },
    {
      nextAction: remoteWorkerSource
        ? null
        : 'Connect the home Worker through the VM public/overlay URL; behind a proxy, configure the shared proxy secret and preserve X-Forwarded-For',
    },
  ));

  const outboundModel = String(capabilities.networking?.workerConnectionModel || '').toLowerCase().includes('outbound');
  checks.push(check(
    'outboundWorkerModel',
    outboundModel ? 'passed' : 'failed',
    'Workers use outbound requests and require no inbound listener',
    { model: capabilities.networking?.workerConnectionModel || null },
  ));

  const targetIdentity = worker?.identity || {};
  const gatewaySupportsIdentity = Boolean(
    capabilities.features?.workerScopedTokens
    && capabilities.features?.signedWorkerRequests
    && capabilities.features?.signedWorkerRequestReplayProtection
    && capabilities.features?.workerTokenRotation
    && capabilities.features?.workerTokenRotationCrashRecovery
  );
  const targetIdentityVerified = Boolean(
    targetIdentity.type === 'worker_token'
    && targetIdentity.scoped
    && targetIdentity.signed
    && targetIdentity.signatureAlgorithm === 'ed25519'
    && targetIdentity.workerTokenId
  );
  const scopedIdentity = gatewaySupportsIdentity && targetIdentityVerified;
  checks.push(check(
    'workerIdentity',
    scopedIdentity ? 'passed' : 'failed',
    'The selected Worker is currently authenticated with a scoped, signed, revocable identity',
    {
      gateway: {
        scopedTokens: Boolean(capabilities.features?.workerScopedTokens),
        signedRequests: Boolean(capabilities.features?.signedWorkerRequests),
        replayProtection: Boolean(capabilities.features?.signedWorkerRequestReplayProtection),
        tokenRotation: Boolean(capabilities.features?.workerTokenRotation),
        tokenRotationCrashRecovery: Boolean(capabilities.features?.workerTokenRotationCrashRecovery),
      },
      targetWorker: {
        type: targetIdentity.type || null,
        scoped: Boolean(targetIdentity.scoped),
        signed: Boolean(targetIdentity.signed),
        workerTokenId: targetIdentity.workerTokenId || null,
        signatureAlgorithm: targetIdentity.signatureAlgorithm || null,
        observedAt: targetIdentity.observedAt || null,
      },
    },
    { nextAction: scopedIdentity ? null : 'Re-enroll the selected Worker with a self-service bootstrap bundle and wait for its signed heartbeat' },
  ));

  const signatureClockSkewMs = Number(targetIdentity.signatureClockSkewMs);
  const signatureClockObserved = Number.isFinite(signatureClockSkewMs);
  const signatureClockSafe = Boolean(
    targetIdentityVerified
    && signatureClockObserved
    && Math.abs(signatureClockSkewMs) <= WORKER_CLOCK_WARNING_MS
  );
  checks.push(check(
    'workerClockSynchronization',
    signatureClockSafe ? 'passed' : 'failed',
    'The latest signed Worker request is safely inside the replay-protection clock window',
    {
      workerId: worker?.id || null,
      signedAt: targetIdentity.signatureSignedAt || null,
      observedAt: targetIdentity.observedAt || null,
      controlMinusWorkerMs: signatureClockObserved ? signatureClockSkewMs : null,
      recommendedMaxAbsoluteSkewMs: WORKER_CLOCK_WARNING_MS,
      protocolMaxAbsoluteSkewMs: targetIdentity.signatureMaxClockSkewMs || null,
    },
    {
      nextAction: signatureClockSafe
        ? null
        : 'Synchronize VM and home Worker clocks with NTP/Windows Time, rerun worker preflight, and wait for a fresh signed heartbeat',
    },
  ));

  const revocationReceipt = credentialRevocationReceipt(worker, manualByKey.get('credentialRevocation'));
  checks.push(check(
    'credentialRevocationReceipt',
    revocationReceipt.passed ? 'passed' : (revocationReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Credential revocation evidence is bound to the selected Worker, its current replacement token, and a verified predecessor HTTP 401 result',
    revocationReceipt.evidence,
    {
      nextAction: revocationReceipt.passed
        ? null
        : 'Run worker manage --action rotate_token --wait --evidence <file> on the selected live Worker, then regenerate the acceptance report',
    },
  ));

  const cancellationReceipt = remoteCancellationReceipt(
    worker,
    manualByKey.get('remoteCancellation'),
    tasks,
  );
  checks.push(check(
    'remoteCancellationReceipt',
    cancellationReceipt.passed ? 'passed' : (cancellationReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Remote cancellation evidence is generated by the exercise and bound to its durable target-Worker task, attempt, cancellation, and process-release result',
    cancellationReceipt.evidence,
    {
      nextAction: cancellationReceipt.passed
        ? null
        : 'Run acceptance exercise remote-cancellation --worker <id> --evidence <file> against the selected live Worker, then regenerate the report',
    },
  ));

  const shortDisconnect = shortDisconnectReceipt(
    worker,
    manualByKey.get('shortDisconnect'),
    tasks,
  );
  checks.push(check(
    'shortDisconnectReceipt',
    shortDisconnect.passed ? 'passed' : (shortDisconnect.status === 'pending' ? 'pending' : 'failed'),
    'Short-disconnect evidence is bound to server-computed heartbeat age, a live pre-expiry lease, same-attempt renewal after reconnect, one execution, and the returned artifact',
    shortDisconnect.evidence,
    {
      nextAction: shortDisconnect.passed
        ? null
        : 'Run acceptance exercise short-disconnect --worker <id> --evidence <file>, disconnect past the configured threshold, and reconnect before lease expiry',
    },
  ));

  const longDisconnectReceipt = longDisconnectRecoveryReceipt(
    worker,
    manualByKey.get('longDisconnectRecovery'),
    tasks,
  );
  checks.push(check(
    'longDisconnectRecoveryReceipt',
    longDisconnectReceipt.passed ? 'passed' : (longDisconnectReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Long-disconnect recovery evidence is bound to the durable lease-expired attempt, recovery event, stale-result rejection, distinct successful retry, and verified artifact',
    longDisconnectReceipt.evidence,
    {
      nextAction: longDisconnectReceipt.passed
        ? null
        : 'Run acceptance exercise long-disconnect-recovery --worker <id> --evidence <file> and keep the selected Worker disconnected until lease recovery is reported',
    },
  ));

  const restartReceipt = vmRestartRecoveryReceipt(
    worker,
    manualByKey.get('vmRestartRecovery'),
    tasks,
    status,
  );
  checks.push(check(
    'vmRestartRecoveryReceipt',
    restartReceipt.passed ? 'passed' : (restartReceipt.status === 'pending' ? 'pending' : 'failed'),
    'VM restart evidence is bound to the task creation instance, a distinct current runtime after an observed outage, the original SQLite attempt, Worker reconnection, and verified artifact',
    restartReceipt.evidence,
    {
      nextAction: restartReceipt.passed
        ? null
        : 'Run acceptance exercise vm-restart-recovery --worker <id> --evidence <file>, restart only the VM control service, and preserve the SQLite data volume',
    },
  ));

  const workerRestartReceipt = workerRestartRecoveryReceipt(
    worker,
    manualByKey.get('workerRestartRecovery'),
    tasks,
  );
  checks.push(check(
    'workerRestartRecoveryReceipt',
    workerRestartReceipt.passed ? 'passed' : (workerRestartReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Home Worker restart evidence is bound to an observed offline interval, a control-only runtime transition, unchanged signed token identity, and a post-restart task artifact',
    workerRestartReceipt.evidence,
    {
      nextAction: workerRestartReceipt.passed
        ? null
        : 'Run acceptance exercise worker-restart-recovery --worker <id> --evidence <file>, stop until offline is reported, then restart the installed Worker service',
    },
  ));

  const artifactResumeReceipt = largeArtifactResumeReceipt(
    worker,
    manualByKey.get('largeArtifactResume'),
    tasks,
  );
  checks.push(check(
    'largeArtifactResumeReceipt',
    artifactResumeReceipt.passed ? 'passed' : (artifactResumeReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Large-artifact resume evidence is bound to durable chunk offsets, a real stalled interval, the same upload/attempt finalization, and the returned SHA-256',
    artifactResumeReceipt.evidence,
    {
      nextAction: artifactResumeReceipt.passed
        ? null
        : 'Run acceptance exercise large-artifact-resume --worker <id> --evidence <file> and interrupt the selected Worker after a committed partial offset',
    },
  ));

  const inputResumeReceipt = largeInputResumeReceipt(
    worker,
    manualByKey.get('largeInputResume'),
    tasks,
  );
  checks.push(check(
    'largeInputResumeReceipt',
    inputResumeReceipt.passed ? 'passed' : (inputResumeReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Large-input resume evidence is bound to the staged input digest, initial and positive Range events on one attempt, the disconnect interval, and the Worker hash artifact',
    inputResumeReceipt.evidence,
    {
      nextAction: inputResumeReceipt.passed
        ? null
        : 'Run acceptance exercise large-input-resume --worker <id> --evidence <file> and interrupt the selected Worker during its ranged input download',
    },
  ));

  const restoreReceipt = backupRestoreReceipt(
    worker,
    manualByKey.get('backupRestore'),
    tasks,
    status,
  );
  checks.push(check(
    'backupRestoreReceipt',
    restoreReceipt.passed ? 'passed' : (restoreReceipt.status === 'pending' ? 'pending' : 'failed'),
    'Backup/restore evidence is bound to the live restore receipt, old/new runtime-stamped tasks, preserved marker artifact, post-restore write artifact, and Worker reconnection',
    restoreReceipt.evidence,
    {
      nextAction: restoreReceipt.passed
        ? null
        : 'Run acceptance exercise backup-restore with a verified offline backup, a fresh restored data directory, and the selected Worker connected to the restarted control',
    },
  ));

  const sqlite = status.storage?.backend === 'sqlite';
  checks.push(check(
    'durableControlStore',
    sqlite ? 'passed' : 'failed',
    'The VM control plane uses the versioned SQLite backend',
    status.storage || {},
    { nextAction: sqlite ? null : 'Set NADO_STORE=sqlite and migrate/restore the control volume before production acceptance' },
  ));

  const statusLease = status.storage?.dataLease || {};
  const capabilityLease = capabilities.storage?.singleWriterLease || {};
  const singleWriterProtected = Boolean(
    statusLease.enabled
    && statusLease.status === 'owned'
    && statusLease.writeFencing
    && capabilityLease.enabled
    && capabilityLease.writeFencing,
  );
  checks.push(check(
    'controlDataSingleWriter',
    singleWriterProtected ? 'passed' : 'failed',
    'The VM data directory has one live Control owner and stale snapshots are write-fenced',
    {
      status: statusLease.status || 'unavailable',
      enabled: Boolean(statusLease.enabled),
      writeFencing: Boolean(statusLease.writeFencing),
      heartbeatMs: statusLease.heartbeatMs ?? null,
      timeoutMs: statusLease.timeoutMs ?? null,
    },
    {
      nextAction: singleWriterProtected
        ? null
        : 'Start Control through the normal CLI/service path and ensure only one instance owns the persistent data directory',
    },
  ));

  const reliability = capabilities.reliability || {};
  const reliable = Boolean(
    reliability.taskDelivery === 'at-least-once'
    && reliability.taskLeases
    && capabilities.features?.offlineRecovery
    && capabilities.features?.automaticOfflineRecovery
    && capabilities.features?.resumableArtifactUploads
    && capabilities.features?.resumableTaskInputUploads
    && reliability.idempotencyKeys,
  );
  checks.push(check(
    'reliabilityConfiguration',
    reliable ? 'passed' : 'failed',
    'Leases, bounded recovery, resumable transfers, and at-least-once semantics are active',
    {
      delivery: reliability.taskDelivery || null,
      leases: Boolean(reliability.taskLeases),
      offlineRecovery: Boolean(capabilities.features?.offlineRecovery),
      automaticOfflineRecovery: Boolean(capabilities.features?.automaticOfflineRecovery),
      resumableArtifacts: Boolean(capabilities.features?.resumableArtifactUploads),
      resumableInputs: Boolean(capabilities.features?.resumableTaskInputUploads),
    },
    { nextAction: reliable ? null : 'Enable NADO_AUTO_RECOVER_OFFLINE_MS and verify lease/transfer capability flags' },
  ));

  const cpu = Number(worker?.resources?.cpu?.logicalCores || 0);
  const cpuUtilizationValue = worker?.resources?.cpu?.utilizationPercent;
  const cpuUtilization = cpuUtilizationValue === null || cpuUtilizationValue === undefined
    ? Number.NaN
    : Number(cpuUtilizationValue);
  const memory = Number(worker?.resources?.memory?.totalBytes || 0);
  const memoryUsedPercentValue = worker?.resources?.memory?.usedPercent;
  const memoryUsedPercent = memoryUsedPercentValue === null || memoryUsedPercentValue === undefined
    ? Number.NaN
    : Number(memoryUsedPercentValue);
  const diskReady = Boolean(worker?.resources?.disk?.available);
  const hardwareReady = Boolean(
    cpu > 0
    && Number.isFinite(cpuUtilization)
    && cpuUtilization >= 0
    && cpuUtilization <= 100
    && memory > 0
    && Number.isFinite(memoryUsedPercent)
    && memoryUsedPercent >= 0
    && memoryUsedPercent <= 100
    && diskReady
  );
  checks.push(check(
    'workerResourceTelemetry',
    hardwareReady ? 'passed' : 'pending',
    'Worker reports CPU/RAM capacity and live utilization plus data-volume capacity',
    {
      cpuCores: cpu,
      cpuUtilizationPercent: Number.isFinite(cpuUtilization) ? cpuUtilization : null,
      memoryBytes: memory,
      memoryUsedPercent: Number.isFinite(memoryUsedPercent) ? memoryUsedPercent : null,
      disk: worker?.resources?.disk || null,
    },
    { nextAction: hardwareReady ? null : 'Wait for at least two heartbeats and inspect Worker inventory/metrics permissions' },
  ));

  const controlMetrics = worker?.resources?.network || {};
  const networkTelemetry = Boolean(
    Number.isFinite(Number(controlMetrics.roundTripMs))
    && controlMetrics.lastSuccessAt
    && controlMetrics.bandwidth?.available,
  );
  checks.push(check(
    'workerNetworkTelemetry',
    networkTelemetry ? 'passed' : 'pending',
    'Worker reports Control RTT and bounded upload/download estimates',
    controlMetrics,
    { nextAction: networkTelemetry ? null : 'Wait for the first heartbeat/bandwidth interval and inspect Worker events' },
  ));

  if (requirements.requireGpu) {
    const gpu = worker?.resources?.gpu || {};
    const gpuReady = Boolean(gpu.detected && gpu.count > 0 && gpu.memoryTotalBytes > 0);
    checks.push(check(
      'gpuRuntime',
      gpuReady ? 'passed' : 'failed',
      'A probed NVIDIA or AMD/ROCm GPU exposes structured VRAM telemetry',
      gpu,
      { nextAction: gpuReady ? null : 'Install/repair nvidia-smi, amd-smi, or rocm-smi and restart the Worker inventory probe' },
    ));
  } else {
    checks.push(check('gpuRuntime', 'passed', 'GPU evidence was not required for this acceptance run', {}, { required: false }));
  }

  if (requirements.requireAgent) {
    const agent = worker?.readiness?.agent || {};
    const agentReady = Boolean(agent.realTerminalAgent && agent.readyForAgentTasks && agent.selfTest?.status === 'succeeded');
    checks.push(check(
      'terminalAgentRuntime',
      agentReady ? 'passed' : 'failed',
      'A real terminal Agent runtime has a successful self-test',
      agent,
      { nextAction: agentReady ? null : 'Configure Codex/Claude on the Worker and run doctor --agent-self-test' },
    ));
  } else {
    checks.push(check('terminalAgentRuntime', 'passed', 'Terminal Agent evidence was not required for this acceptance run', {}, { required: false }));
  }

  const verifyPassed = Boolean(verifyResult?.ok);
  checks.push(check(
    'endToEndVerify',
    verifyResult ? (verifyPassed ? 'passed' : 'failed') : 'pending',
    'Gateway verify completes task, event, artifact, batch, and doctor probes on the target Worker',
    verifyResult ? {
      ok: verifyResult.ok,
      taskId: verifyResult.summary?.taskId || null,
      batchId: verifyResult.summary?.batchId || null,
      problems: verifyResult.problems || [],
    } : {},
    { nextAction: verifyResult ? null : 'Re-run acceptance with --run-verify' },
  ));
  return checks;
}

export function buildCrossSiteAcceptanceReport(options = {}) {
  const scenarios = evidenceScenarios(options.manualEvidence || {});
  const knownScenarioKeys = new Set(manualScenarioDefinitions().keys());
  for (const key of Object.keys(scenarios)) {
    if (!knownScenarioKeys.has(key)) {
      throw new Error(`Unknown acceptance evidence scenario: ${key}`);
    }
  }
  const manualChecks = BASE_MANUAL_SCENARIOS.map(([key, definition]) => normalizeManualRecord(key, definition, scenarios[key]));
  if (options.requireAgent !== false) {
    manualChecks.push(normalizeManualRecord(
      'agentCollaboration',
      'A real terminal Agent completed useful work on the home Worker and returned its transcript/artifact',
      scenarios.agentCollaboration,
    ));
  }
  const remoteUrl = options.network?.preferredRemoteControlUrl || options.network?.publicControlUrl || '';
  let protocol = null;
  try { protocol = new URL(remoteUrl).protocol; } catch {}
  if (protocol !== 'https:') {
    manualChecks.push(normalizeManualRecord(
      'encryptedPrivateOverlay',
      'The non-HTTPS Control URL is carried only over Tailscale/WireGuard with restrictive ACLs',
      scenarios.encryptedPrivateOverlay,
    ));
  }
  const manualByKey = new Map(manualChecks.map((item) => [item.key, item]));
  const requirements = {
    workerId: options.workerId,
    requireGpu: Boolean(options.requireGpu),
    requireAgent: options.requireAgent !== false,
    requireDeploymentEvidence: Boolean(options.requireDeploymentEvidence),
  };
  const worker = (options.workers || []).find((item) => item.id === options.workerId) || null;
  const automatedChecks = automaticChecks({
    network: options.network || {},
    status: options.status || {},
    capabilities: options.capabilities || {},
    worker,
    requirements,
    verifyResult: options.verifyResult || null,
    manualByKey,
    tasks: options.tasks || [],
    sessions: options.sessions || [],
    deploymentEvidence: options.deploymentEvidence || null,
  });
  const requiredChecks = [...automatedChecks, ...manualChecks].filter((item) => item.required);
  const failed = requiredChecks.filter((item) => item.status === 'failed');
  const pending = requiredChecks.filter((item) => item.status === 'pending');
  const overall = failed.length ? 'failed' : pending.length ? 'pending' : 'passed';
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    overall,
    requirements,
    control: {
      requestUrl: options.network?.requestUrl || null,
      remoteUrl: options.network?.preferredRemoteControlUrl || null,
      publicControlUrl: options.network?.publicControlUrl || null,
      storage: options.status?.storage || null,
    },
    worker: worker ? {
      id: worker.id,
      host: worker.host || worker.inventory?.host?.hostname || null,
      labels: worker.labels || {},
      gatewayState: worker.gatewayState,
      adminState: worker.adminState,
      capabilities: worker.capabilities || [],
      resources: worker.resources || {},
      readiness: worker.readiness || {},
      identity: worker.identity || null,
      connection: worker.connection || null,
      runtime: worker.runtime || null,
    } : null,
    automatedChecks,
    manualChecks,
    verify: options.verifyResult || null,
    summary: {
      required: requiredChecks.length,
      passed: requiredChecks.filter((item) => item.status === 'passed').length,
      failed: failed.length,
      pending: pending.length,
    },
    nextActions: [...failed, ...pending]
      .filter((item) => item.nextAction)
      .map((item) => ({ key: item.key, action: item.nextAction })),
  };
}

export function acceptanceEvidenceTemplate() {
  return {
    version: EVIDENCE_VERSION,
    generatedAt: new Date().toISOString(),
    scenarios: Object.fromEntries([
      ...manualScenarioDefinitions(),
    ].map(([key, description]) => [key, {
      status: 'pending',
      evidence: '',
      references: [],
      observedAt: null,
      description,
    }])),
  };
}

export function initializeAcceptanceEvidence(value = undefined) {
  const template = acceptanceEvidenceTemplate();
  if (value === undefined || value === null) {
    return template;
  }
  const scenarios = evidenceScenarios(value);
  const definitions = manualScenarioDefinitions();
  for (const key of Object.keys(scenarios)) {
    if (!definitions.has(key)) {
      throw new Error(`Unknown acceptance evidence scenario: ${key}`);
    }
  }
  for (const [key, definition] of definitions) {
    if (scenarios[key] !== undefined) {
      normalizeManualRecord(key, definition, scenarios[key]);
    }
  }
  return {
    ...template,
    ...value,
    version: EVIDENCE_VERSION,
    generatedAt: value.generatedAt || template.generatedAt,
    scenarios: {
      ...template.scenarios,
      ...scenarios,
    },
  };
}

export function recordAcceptanceEvidence(value = {}, record = {}) {
  const scenarios = evidenceScenarios(value);
  const definitions = manualScenarioDefinitions();
  for (const key of Object.keys(scenarios)) {
    if (!definitions.has(key)) {
      throw new Error(`Unknown acceptance evidence scenario: ${key}`);
    }
  }
  const scenario = String(record.scenario || '').trim();
  if (!definitions.has(scenario)) {
    throw new Error(`Unknown acceptance evidence scenario: ${scenario || '(empty)'}`);
  }
  const status = String(record.status || '').trim();
  const note = String(record.evidence || record.note || '').trim();
  if (!CHECK_STATUSES.has(status)) {
    throw new Error(`Acceptance evidence scenario ${scenario} must have status passed, failed, or pending`);
  }
  if ((status === 'passed' || status === 'failed') && !note) {
    throw new Error(`Acceptance evidence scenario ${scenario} requires a non-empty evidence note`);
  }
  const observedAt = record.observedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error(`Acceptance evidence scenario ${scenario} has an invalid observedAt timestamp`);
  }
  const references = Array.from(new Set(
    (Array.isArray(record.references) ? record.references : [])
      .map((item) => String(item).trim().slice(0, 500))
      .filter(Boolean),
  )).slice(0, 30);
  const source = EXERCISE_EVIDENCE_SOURCES.has(record.source) ? record.source : 'operator';
  const details = record.details && typeof record.details === 'object' && !Array.isArray(record.details)
    ? JSON.parse(JSON.stringify(record.details))
    : null;
  const next = JSON.parse(JSON.stringify(value || {}));
  next.version = EVIDENCE_VERSION;
  next.generatedAt ||= new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  next.scenarios ||= {};
  next.scenarios[scenario] = {
    ...(next.scenarios[scenario] || {}),
    status,
    evidence: note,
    references,
    observedAt,
    source,
    details: details || undefined,
    description: next.scenarios[scenario]?.description || definitions.get(scenario),
  };
  normalizeManualRecord(scenario, definitions.get(scenario), next.scenarios[scenario]);
  return next;
}
