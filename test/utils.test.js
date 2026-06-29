import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';
import { controlUrlFromHostPort, originFromHostHeader, urlHost } from '../src/utils.js';

test('formats IPv6 hosts as valid URL authorities', () => {
  assert.equal(urlHost('::1'), '[::1]');
  assert.equal(urlHost('2001:db8::10'), '[2001:db8::10]');
  assert.equal(urlHost('127.0.0.1'), '127.0.0.1');
  assert.equal(controlUrlFromHostPort('::1', 8765), 'http://[::1]:8765');
  assert.equal(controlUrlFromHostPort('::', 8765), 'http://[::1]:8765');
  assert.equal(controlUrlFromHostPort('0.0.0.0', 8765), 'http://127.0.0.1:8765');
});

test('preserves bracketed IPv6 Host headers when building control origins', () => {
  assert.equal(originFromHostHeader('[::1]:8765'), 'http://[::1]:8765');
  assert.equal(originFromHostHeader('127.0.0.1:8765'), 'http://127.0.0.1:8765');
});

test('control and client communicate over IPv6 loopback when available', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nado-ipv6-'));
  const token = 'ipv6-token';
  let server;
  try {
    const started = await startControlServer({
      host: '::1',
      port: 0,
      token,
      dataDir: path.join(root, 'control'),
    });
    server = started.server;
    const controlUrl = `http://[::1]:${started.port}`;
    const client = new NadoClient({ controlUrl, token });
    await client.registerWorker({ id: 'ipv6-worker', capabilities: ['code'], maxConcurrency: 1 });
    const { workers } = await client.listWorkers();
    assert.equal(workers.some((worker) => worker.id === 'ipv6-worker'), true);
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) {
      t.skip(`IPv6 loopback unavailable: ${error.code}`);
      return;
    }
    throw error;
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
