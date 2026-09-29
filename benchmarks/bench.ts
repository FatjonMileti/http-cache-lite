/**
 * Minimal benchmark for the hot paths: get / set / delete / LRU eviction /
 * tag invalidation. Run with `npm run bench`.
 *
 * No assertions — prints ops/sec so regressions are visible.
 */
import { HttpCache } from '../src/cache.js';

async function measure(
  name: string,
  iterations: number,
  fn: (i: number) => unknown,
): Promise<void> {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn(i);
  }
  const elapsed = performance.now() - start;
  const ops = Math.round((iterations / elapsed) * 1000);
  console.log(
    `${name}: ${iterations} ops in ${elapsed.toFixed(1)}ms → ${ops.toLocaleString()} ops/sec`,
  );
}

async function main(): Promise<void> {
  const N = 50_000;

  const cache = new HttpCache<string, number>({ maxSize: N * 2 });
  await measure('set', N, (i) => cache.set(`k${String(i)}`, i));
  await measure('get (hit)', N, (i) => cache.get(`k${String(i)}`));
  await measure('getOrSet (hit)', N, (i) => cache.getOrSet(`k${String(i)}`, () => -1));

  const small = new HttpCache<string, number>({ maxSize: 1_000 });
  await measure('set with LRU eviction', N, (i) => small.set(`e${String(i)}`, i));

  const tagged = new HttpCache<string, number>({ maxSize: N * 2 });
  for (let i = 0; i < 10_000; i++) {
    await tagged.set(`t${String(i)}`, i, { tags: [`group:${String(i % 100)}`] });
  }
  const start = performance.now();
  for (let g = 0; g < 100; g++) {
    await tagged.invalidateByTag(`group:${String(g)}`);
  }
  const elapsed = performance.now() - start;
  console.log(`invalidateByTag x100 (10k entries): ${elapsed.toFixed(1)}ms`);

  const delCache = new HttpCache<string, number>({ maxSize: N * 2 });
  for (let i = 0; i < N; i++) {
    await delCache.set(`d${String(i)}`, i);
  }
  await measure('delete', N, (i) => delCache.delete(`d${String(i)}`));
}

void main();
