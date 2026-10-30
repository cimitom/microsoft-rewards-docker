import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import networkClient, { isTransientNetworkError } from '../src/network.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

test('识别 SOCKS 与网络中断类瞬时错误', () => {
  assert.equal(isTransientNetworkError(new Error('Socks5 proxy rejected connection - NetworkUnreachable')), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('HTTP 500'), { response: { status: 500 } })), false);
});

test('只读 GET 遇到瞬时网络错误时自动重试一次', async () => {
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    if (hits === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  networkClient.setActiveProxySelection({ mode: 'direct' });
  try {
    const result = await networkClient.request({
      url,
      method: 'GET',
      timeout: 2000,
      transientRetries: 1,
      transientRetryDelaysMs: [10]
    });
    assert.equal(result, 'ok');
    assert.equal(hits, 2);
  } finally {
    await closeServer(server);
  }
});

test('POST 不自动重试，避免重复提交有副作用的请求', async () => {
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    req.socket.destroy();
  });
  networkClient.setActiveProxySelection({ mode: 'direct' });
  try {
    await assert.rejects(
      networkClient.request({
        url,
        method: 'POST',
        data: '{}',
        timeout: 2000,
        transientRetries: 1,
        transientRetryDelaysMs: [10]
      }),
      /ECONNRESET|socket hang up/i
    );
    assert.equal(hits, 1);
  } finally {
    await closeServer(server);
  }
});
