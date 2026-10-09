import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { NadoClient } from '../src/http-client.js';

test('HTTP client honors Retry-After for safe reads without replaying writes', async () => {
  let getCalls = 0;
  let postCalls = 0;
  const getNonces = [];
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      getCalls += 1;
      getNonces.push(request.headers['x-nado-nonce']);
      if (getCalls === 1) {
        response.statusCode = 429;
        response.setHeader('retry-after', '0.01');
        response.end(JSON.stringify({ error: 'slow down' }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    postCalls += 1;
    response.statusCode = 429;
    response.setHeader('retry-after', '0.01');
    response.end(JSON.stringify({ error: 'write limited' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const client = new NadoClient({
    controlUrl: `http://127.0.0.1:${address.port}`,
    token: 'retry-test-token',
    workerId: 'retry-test-worker',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });

  try {
    assert.deepEqual(await client.request('GET', '/safe'), { ok: true });
    assert.equal(getCalls, 2);
    assert.equal(new Set(getNonces).size, 2);
    await assert.rejects(() => client.request('POST', '/write', {}), /failed with 429/);
    assert.equal(postCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
