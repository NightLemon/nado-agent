import path from 'node:path';

function normalizeList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim().replaceAll('\\', '/').replace(/^\.\/+/, ''))
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values));
}

export function normalizeArtifactPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { include: [], exclude: [] };
  }
  return {
    include: unique(normalizeList(value.include || value.includes || value.paths)),
    exclude: unique(normalizeList(value.exclude || value.excludes)),
  };
}

export function mergeArtifactPolicy(defaults = {}, spec = {}) {
  const base = normalizeArtifactPolicy(defaults);
  const override = normalizeArtifactPolicy(spec);
  return {
    include: unique([...base.include, ...override.include]),
    exclude: unique([...base.exclude, ...override.exclude]),
  };
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      const after = pattern[index + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || '')
    .replaceAll(path.sep, '/')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '');
}

function matchesPattern(relativePath, pattern) {
  const file = normalizeRelativePath(relativePath);
  const normalized = normalizeRelativePath(pattern);
  if (!normalized) {
    return false;
  }
  if (!/[?*]/.test(normalized)) {
    const directory = normalized.replace(/\/+$/, '');
    return file === directory || file.startsWith(`${directory}/`);
  }
  return globToRegex(normalized).test(file);
}

export function artifactAllowed(relativePath, policy = {}) {
  const normalized = normalizeArtifactPolicy(policy);
  const included = !normalized.include.length
    || normalized.include.some((pattern) => matchesPattern(relativePath, pattern));
  if (!included) {
    return false;
  }
  return !normalized.exclude.some((pattern) => matchesPattern(relativePath, pattern));
}
