import { stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';

test('embedding proxy stores vectors and receipts through a local proxy', async () => {
  const provider = await stub(() => ({ data: [{ index: 0, embedding: [1, 0] }] }));
  const target = new URL(provider.url);
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const proxy = http.createServer();
  proxy.on('request', (req, res) => {
    const url = new URL(req.url!);
    assert.equal(url.host, target.host);
    connections++;
    const upstream = http.request(url, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('connect', (req, socket, head) => {
    assert.equal(req.url, target.host);
    connections++;
    const upstream = net.connect(Number(target.port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(socket as net.Socket);
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as net.AddressInfo).port;
  process.env.EMBEDDING_API_KEY = 'test-key';
  process.env.EMBEDDING_BASE_URL = provider.url;
  process.env.EMBEDDING_PROXY_URL = `http://127.0.0.1:${port}`;
  process.env.EMBEDDING_MODEL = 'proxy-test';
  try {
    const { ensureEmbeddings } = await import('@aihot/backend/providers/embeddings');
    const id = `embedding-proxy-${tag()}`;
    const vectors = await ensureEmbeddings('article', [{ id, text: 'local test' }]);
    assert.deepEqual(vectors.get(id), [1, 0]);
    assert.equal(provider.hits(), 1);
    assert.ok(connections > 0);
    const [receipt] = await sql`SELECT status FROM receipts WHERE subject = ${'article:' + id}`;
    assert.equal(receipt.status, 'received');
    assert.deepEqual((await ensureEmbeddings('article', [{ id, text: 'local test' }])).get(id), [1, 0]);
    assert.equal(provider.hits(), 1, 'stored vectors do not buy another request');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await provider.close();
    await closeDb();
  }
});
