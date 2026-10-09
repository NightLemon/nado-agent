import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_INLINE_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_INLINE_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILES = 500;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function shouldSkip(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  return parts.some((part) => part === '.git' || part === 'node_modules' || part === '.nado');
}

async function walk(dir, root, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath).replaceAll('\\', '/');
    if (shouldSkip(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(fullPath, root, files);
    } else if (entry.isFile()) {
      const stat = await fs.stat(fullPath);
      files.push({ fullPath, relativePath, size: stat.size });
    }
  }
}

async function addFile(files, fullPath, relativePath) {
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${fullPath}`);
  }
  files.push({
    fullPath,
    relativePath: relativePath.replaceAll('\\', '/'),
    size: stat.size,
  });
}

function resolveInputPath(value, baseDir) {
  return path.resolve(baseDir || '.', value);
}

export async function collectLocalInputFiles(input, options = {}) {
  const maxFileBytes = positiveNumber(
    options.maxInputFileBytes ?? process.env.NADO_INPUT_MAX_FILE_BYTES,
    DEFAULT_MAX_FILE_BYTES,
  );
  const maxTotalBytes = positiveNumber(
    options.maxInputTotalBytes ?? process.env.NADO_INPUT_MAX_TOTAL_BYTES,
    DEFAULT_MAX_TOTAL_BYTES,
  );
  const inlineFileBytes = positiveNumber(
    options.inlineInputFileBytes ?? process.env.NADO_INPUT_INLINE_MAX_BYTES,
    DEFAULT_INLINE_FILE_BYTES,
  );
  const inlineTotalBytes = positiveNumber(
    options.inlineInputTotalBytes ?? process.env.NADO_INPUT_INLINE_TOTAL_BYTES,
    DEFAULT_INLINE_TOTAL_BYTES,
  );
  const maxFiles = positiveNumber(options.maxInputFiles, DEFAULT_MAX_FILES);
  const baseDir = options.baseDir || '.';
  const candidates = [];

  for (const file of input.files || []) {
    const fullPath = resolveInputPath(file, baseDir);
    await addFile(candidates, fullPath, path.basename(file));
  }

  for (const dir of input.dirs || []) {
    const root = resolveInputPath(dir, baseDir);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      throw new Error(`Input path is not a directory: ${dir}`);
    }
    await walk(root, root, candidates);
  }

  const output = [];
  let totalBytes = 0;
  let inlineBytes = 0;
  for (const candidate of candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (output.length >= maxFiles) {
      throw new Error(`Too many input files; limit is ${maxFiles}`);
    }
    if (shouldSkip(candidate.relativePath)) {
      continue;
    }
    if (candidate.size > maxFileBytes) {
      throw new Error(`Input file too large: ${candidate.relativePath}`);
    }
    if (totalBytes + candidate.size > maxTotalBytes) {
      throw new Error(`Input files exceed total size limit of ${maxTotalBytes} bytes`);
    }
    totalBytes += candidate.size;
    const inline = candidate.size <= inlineFileBytes
      && inlineBytes + candidate.size <= inlineTotalBytes;
    if (inline) {
      const bytes = await fs.readFile(candidate.fullPath);
      inlineBytes += candidate.size;
      output.push({
        path: candidate.relativePath,
        size: candidate.size,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        contentBase64: bytes.toString('base64'),
      });
      continue;
    }
    output.push({
      path: candidate.relativePath,
      size: candidate.size,
      sha256: await sha256File(candidate.fullPath),
      localPath: candidate.fullPath,
      transfer: 'chunked',
    });
  }

  return output;
}
