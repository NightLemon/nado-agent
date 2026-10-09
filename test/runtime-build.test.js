import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getRuntimeBuildInfo,
  runtimeBuildCompatibility,
} from '../src/runtime-build.js';

test('runtime build fingerprint is deterministic, line-ending neutral, and changes with source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-runtime-build-'));
  try {
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"fingerprint-test"}\n');
    await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const value = 1;\n');
    const first = await getRuntimeBuildInfo({ rootDir: root, env: {} });
    const repeated = await getRuntimeBuildInfo({ rootDir: root, env: {} });
    assert.equal(first.sourceFingerprint, repeated.sourceFingerprint);
    assert.match(first.sourceFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(first.buildId, /^source-[a-f0-9]{16}$/);

    await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const value = 1;\r\n');
    const crlf = await getRuntimeBuildInfo({ rootDir: root, env: {} });
    assert.equal(crlf.sourceFingerprint, first.sourceFingerprint);

    await fs.writeFile(path.join(root, 'src', 'a.js'), 'export const value = 2;\n');
    const changed = await getRuntimeBuildInfo({ rootDir: root, env: { NADO_BUILD_ID: 'release-42' } });
    assert.notEqual(changed.sourceFingerprint, first.sourceFingerprint);
    assert.equal(changed.buildId, 'release-42');
    assert.equal(changed.buildIdSource, 'environment');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('runtime build compatibility distinguishes source drift protocol mismatch and legacy evidence', () => {
  const control = {
    version: '0.1.0',
    protocolVersion: 1,
    buildId: 'control',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
  };
  assert.equal(runtimeBuildCompatibility(control, { ...control, buildId: 'worker' }).status, 'compatible');
  assert.equal(runtimeBuildCompatibility(control, {
    ...control,
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
  }).status, 'build_mismatch');
  assert.equal(runtimeBuildCompatibility(control, { ...control, protocolVersion: 2 }).status, 'protocol_mismatch');
  assert.equal(runtimeBuildCompatibility(control, null).status, 'unknown');
});
