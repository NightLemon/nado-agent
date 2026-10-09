export const TASK_FAILURE_KINDS = Object.freeze([
  'configuration_error',
  'timeout',
  'cancelled',
  'process_error',
  'worker_error',
  'nonzero_exit',
]);

export const RETRYABLE_FAILURE_KINDS = Object.freeze([
  'timeout',
  'process_error',
  'worker_error',
  'nonzero_exit',
]);

const FAILURE_KIND_SET = new Set(TASK_FAILURE_KINDS);
const RETRYABLE_KIND_SET = new Set(RETRYABLE_FAILURE_KINDS);

function list(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function invalidPolicy(message, strict) {
  if (!strict) {
    return;
  }
  const error = new Error(message);
  error.status = 400;
  throw error;
}

export function normalizeTaskFailureKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return FAILURE_KIND_SET.has(kind) ? kind : null;
}

export function normalizeRetryPolicy(value, options = {}) {
  const strict = Boolean(options.strict);
  if (value === undefined || value === null || value === false) {
    return { failureKinds: [], exitCodes: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    invalidPolicy('retryPolicy must be an object', strict);
    return { failureKinds: [], exitCodes: [] };
  }

  const failureKinds = [];
  for (const raw of list(value.failureKinds || value.kinds || value.retryOn)) {
    const kind = raw.toLowerCase();
    if (!RETRYABLE_KIND_SET.has(kind)) {
      invalidPolicy(`Unsupported retry failure kind: ${raw}`, strict);
      continue;
    }
    failureKinds.push(kind);
  }

  const exitCodes = [];
  for (const raw of list(value.exitCodes || value.codes)) {
    const code = Number(raw);
    if (!Number.isSafeInteger(code) || code <= 0 || code > 2_147_483_647) {
      invalidPolicy(`Retry exit code must be a positive integer: ${raw}`, strict);
      continue;
    }
    exitCodes.push(code);
  }

  return {
    failureKinds: Array.from(new Set(failureKinds)),
    exitCodes: Array.from(new Set(exitCodes)),
  };
}

export function retryPolicyEnabled(value) {
  const policy = normalizeRetryPolicy(value);
  return Boolean(policy.failureKinds.length || policy.exitCodes.length);
}

export function retryPolicyMatch(value, result = {}) {
  const policy = normalizeRetryPolicy(value);
  const failureKind = normalizeTaskFailureKind(result.failureKind);
  const exitCode = Number(result.exitCode);
  const prohibitedFailureKind = failureKind === 'configuration_error' || failureKind === 'cancelled'
    ? failureKind
    : null;
  const matchedFailureKind = !prohibitedFailureKind && failureKind && policy.failureKinds.includes(failureKind)
    ? failureKind
    : null;
  const matchedExitCode = !prohibitedFailureKind && Number.isSafeInteger(exitCode) && policy.exitCodes.includes(exitCode)
    ? exitCode
    : null;
  return {
    matched: Boolean(matchedFailureKind || matchedExitCode !== null),
    failureKind,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    matchedFailureKind,
    matchedExitCode,
    prohibitedFailureKind,
  };
}
