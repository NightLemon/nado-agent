import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactAllowed, normalizeArtifactPolicy } from './artifact-policy.js';

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;

function shouldSkip(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts[0] === '.nado' && parts[1] === 'dependencies') {
    return true;
  }
  return parts.some((part) => part === '.git' || part === 'node_modules');
}

function hiddenRuntimeArtifact(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const parts = normalized.split('/');
  return normalized === 'prompt.md'
    || parts[0] === '.nado'
    || (parts[0] === '.nado-session' && parts[1] === 'prompts');
}

async function walk(dir, root, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (shouldSkip(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(fullPath, root, files);
    } else if (entry.isFile()) {
      files.push({ fullPath, relativePath: relativePath.replaceAll('\\', '/') });
    }
  }
}

export async function collectArtifacts(workspace, options = {}) {
  const maxFileBytes = Number(options.maxArtifactFileBytes || DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Number(options.maxArtifactTotalBytes || DEFAULT_MAX_TOTAL_BYTES);
  const maxFiles = Number(options.maxArtifactFiles || DEFAULT_MAX_FILES);
  const artifactPolicy = normalizeArtifactPolicy(options.artifactPolicy);
  const files = [];
  await walk(workspace, workspace, files);

  const artifacts = [];
  let totalBytes = 0;
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const explicitlyIncluded = artifactPolicy.include.length
      && artifactAllowed(file.relativePath, { include: artifactPolicy.include, exclude: [] });
    if (hiddenRuntimeArtifact(file.relativePath) && !explicitlyIncluded) {
      continue;
    }
    if (!artifactAllowed(file.relativePath, artifactPolicy)) {
      continue;
    }
    if (artifacts.length >= maxFiles) {
      break;
    }
    const stat = await fs.stat(file.fullPath);
    if (stat.size > maxFileBytes || totalBytes + stat.size > maxTotalBytes) {
      artifacts.push({
        path: file.relativePath,
        size: stat.size,
        skipped: true,
        reason: stat.size > maxFileBytes ? 'file_too_large' : 'total_limit_reached',
      });
      continue;
    }
    const bytes = await fs.readFile(file.fullPath);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    totalBytes += stat.size;
    artifacts.push({
      path: file.relativePath,
      size: stat.size,
      sha256,
      contentBase64: bytes.toString('base64'),
    });
  }
  return artifacts;
}
