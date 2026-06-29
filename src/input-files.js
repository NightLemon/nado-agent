import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILES = 500;

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
      files.push({ fullPath, relativePath });
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
  const maxFileBytes = Number(options.maxInputFileBytes || DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = Number(options.maxInputTotalBytes || DEFAULT_MAX_TOTAL_BYTES);
  const maxFiles = Number(options.maxInputFiles || DEFAULT_MAX_FILES);
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
    output.push({
      path: candidate.relativePath,
      size: candidate.size,
      contentBase64: (await fs.readFile(candidate.fullPath)).toString('base64'),
    });
  }

  return output;
}
