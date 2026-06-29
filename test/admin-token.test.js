import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startControlServer } from '../src/control-server.js';
import { NadoClient } from '../src/http-client.js';

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('control server accepts multiple admin tokens for rotation', async () => {
  const previous = process.env.NADO_ADMIN_TOKENS;
  process.env.NADO_ADMIN_TOKENS = 'new-admin-token';
  const running = await startControlServer({
    host: '127.0.0.1',
    port: 0,
    token: 'old-admin-token',
    dataDir: await fs.mkdtemp(path.join(os.tmpdir(), 'nado-admin-token-')),
  });
  try {
    const controlUrl = `http://127.0.0.1:${running.port}`;
    assert.equal((await new NadoClient({ controlUrl, token: 'old-admin-token' }).status()).workers.total, 0);
    assert.equal((await new NadoClient({ controlUrl, token: 'new-admin-token' }).status()).workers.total, 0);
    await assert.rejects(
      () => new NadoClient({ controlUrl, token: 'wrong-token' }).status(),
      /401: Unauthorized/,
    );
  } finally {
    await close(running.server);
    if (previous === undefined) {
      delete process.env.NADO_ADMIN_TOKENS;
    } else {
      process.env.NADO_ADMIN_TOKENS = previous;
    }
  }
});
