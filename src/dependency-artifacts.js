import { artifactAllowed, normalizeArtifactPolicy } from './artifact-policy.js';

function normalizeString(value, fallback) {
  const text = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return text || fallback;
}

export function normalizeDependencyArtifacts(value) {
  if (value === true) {
    return {
      enabled: true,
      prefix: '.nado/dependencies',
      include: [],
      exclude: [],
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled === false) {
    return {
      enabled: false,
      prefix: '.nado/dependencies',
      include: [],
      exclude: [],
    };
  }
  const policy = normalizeArtifactPolicy(value);
  return {
    enabled: true,
    prefix: normalizeString(value.prefix, '.nado/dependencies'),
    include: policy.include,
    exclude: policy.exclude,
  };
}

export function mergeDependencyArtifacts(defaults, spec) {
  const childProvided = spec !== undefined;
  return normalizeDependencyArtifacts(childProvided ? spec : defaults);
}

export function dependencyArtifactAllowed(relativePath, policy) {
  const normalized = normalizeDependencyArtifacts(policy);
  if (!normalized.enabled) {
    return false;
  }
  return artifactAllowed(relativePath, normalized);
}
