/**
 * Runnable Express example for http-cache-lite.
 *
 * Demonstrates: cache miss/hit, ETag + 304, SWR, tag invalidation, stats.
 *
 * Run:  npm run example
 * Then: curl http://localhost:3000/users (twice → MISS then HIT)
 */
import express from 'express';
import { HttpCache, cacheMiddleware } from 'http-cache-lite';
import type { CachedResponse } from 'http-cache-lite';

const app = express();
const port = 3000;

const cache = new HttpCache<string, CachedResponse>({
  ttl: 30_000,
  staleWhileRevalidate: 60_000,
  maxSize: 500,
});

interface User {
  id: number;
  name: string;
}

const users: User[] = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
];

const cached = cacheMiddleware({
  cache,
  ttl: 30_000,
  staleWhileRevalidate: 60_000,
  tags: ['users'],
  cacheControl: true,
});

app.get('/users', cached, (_req, res) => {
  res.json(users);
});

app.get('/users/:id', cached, (req, res) => {
  const user = users.find((u) => u.id === Number(req.params.id));
  if (!user) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(user);
});

// Mutations invalidate the tag so subsequent GETs are fresh.
app.post('/users', express.json(), (req, res) => {
  const body: unknown = req.body;
  let name = 'unnamed';
  if (
    typeof body === 'object' &&
    body !== null &&
    'name' in body &&
    typeof body.name === 'string'
  ) {
    name = body.name;
  }
  const user: User = { id: users.length + 1, name };
  users.push(user);
  void cache.invalidateByTag('users').then((count) => {
    console.log(`invalidated ${String(count)} entr(ies) tagged "users"`);
  });
  res.status(201).json(user);
});

app.get('/stats', (_req, res) => {
  void cache.size().then((size) => {
    res.json({ size, ...cache.stats() });
  });
});

app.listen(port, () => {
  console.log(`example app listening on http://localhost:${String(port)}`);
  console.log('try: curl -i http://localhost:3000/users');
});
