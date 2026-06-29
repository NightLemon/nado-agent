import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function safeName(value) {
  return String(value || 'unnamed').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EEXIST')) {
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
      return;
    }
    throw error;
  }
}

export function parseCsvValues(values) {
  return values
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isSubset(required, available) {
  const have = new Set(available || []);
  return (required || []).every((item) => have.has(item));
}

export function hasLabels(required, available) {
  const wanted = required || {};
  const have = available || {};
  return Object.entries(wanted).every(([key, value]) => String(have[key] ?? '') === String(value));
}

export function truncateText(text, maxChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function urlHost(host) {
  const value = String(host || '127.0.0.1').trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value;
  }
  return value.includes(':') ? `[${value}]` : value;
}

export function localConnectHost(host) {
  const value = String(host || '127.0.0.1').trim();
  if (value === '0.0.0.0') {
    return '127.0.0.1';
  }
  if (value === '::') {
    return '::1';
  }
  return value;
}

export function controlUrlFromHostPort(host, port, protocol = 'http') {
  return `${protocol}://${urlHost(localConnectHost(host))}:${port}`;
}

export function originFromHostHeader(host, protocol = 'http') {
  const value = String(host || '127.0.0.1').trim();
  if (value.startsWith('[')) {
    return `${protocol}://${value}`;
  }
  const colonCount = (value.match(/:/g) || []).length;
  return colonCount > 1 ? `${protocol}://${urlHost(value)}` : `${protocol}://${value}`;
}

export function requireValue(value, message) {
  if (value === undefined || value === null || value === '') {
    throw new Error(message);
  }
  return value;
}
