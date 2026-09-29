import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExportRecords } from '../src/ledgerClient.js';

function scripted(steps) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const s = steps.shift();
    if (!s) throw new Error('unexpected extra request');
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status ?? 200, headers: s.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}
function harness(steps) {
  const fetch = scripted(steps);
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  return { fetch, sleeps, opts: { baseUrl: 'https://api.test', token: 'tok_abc', fetch, sleep } };
}
const page = (ids, next) => ({ body: { data: ids.map((id) => ({ id, amount: 1 })), next_cursor: next } });
const header = (init, name) => {
  const h = init.headers;
  if (h instanceof Headers) return h.get(name);
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};

test('[core] retries a transient 503 and then returns the records', async () => {
  const { opts, sleeps, fetch } = harness([{ status: 503 }, page(['r1'], null)]);
  const out = await fetchExportRecords('exp_1', opts);
  assert.deepEqual(out.map((r) => r.id), ['r1']);
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [200]);
});

test('[no-repeat] empty pages do not end pagination and records repeated across pages are de-duplicated by id', async () => {
  const { opts, fetch } = harness([page(['a', 'b'], 'c1'), page([], 'c2'), page(['b', 'c'], null)]);
  const out = await fetchExportRecords('exp_1', opts);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(fetch.calls.length, 3);
});

test('[constraint] sends X-Ledgerline-Version 2025-03-15, bearer token, limit=200 and the cursor verbatim', async () => {
  const { opts, fetch } = harness([page(['a'], 'opaque/+=cur'), page([], null)]);
  await fetchExportRecords('exp_1', opts);
  const first = fetch.calls[0];
  assert.equal(header(first.init, 'X-Ledgerline-Version'), '2025-03-15');
  assert.equal(header(first.init, 'Authorization'), 'Bearer tok_abc');
  assert.equal(new URL(first.url).searchParams.get('limit'), '200');
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('cursor'), 'opaque/+=cur');
});

test('[constraint] 429 waits exactly Retry-After seconds and repeats the same cursor', async () => {
  const { opts, fetch, sleeps } = harness([
    page(['a'], 'c1'),
    { status: 429, headers: { 'Retry-After': '2' } },
    { status: 429, headers: { 'Retry-After': '1' } },
    page(['b'], null),
  ]);
  const out = await fetchExportRecords('exp_1', opts);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(sleeps, [2000, 1000]);
  assert.equal(new URL(fetch.calls[3].url).searchParams.get('cursor'), 'c1');
});

test('[constraint] 429 gives up after 5 retries with LedgerRateLimitError', async () => {
  const steps = Array.from({ length: 6 }, () => ({ status: 429, headers: { 'Retry-After': '1' } }));
  const { opts, fetch, sleeps } = harness(steps);
  await assert.rejects(fetchExportRecords('exp_1', opts), (err) => err.name === 'LedgerRateLimitError');
  assert.equal(fetch.calls.length, 6);
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000, 1000]);
});

test('[constraint] 5xx backs off 200/400/800 ms and surfaces LedgerHttpError after 3 retries', async () => {
  const steps = Array.from({ length: 4 }, () => ({ status: 502 }));
  const { opts, fetch, sleeps } = harness(steps);
  await assert.rejects(fetchExportRecords('exp_1', opts), (err) => err.name === 'LedgerHttpError' && err.status === 502);
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(sleeps, [200, 400, 800]);
});

test('[constraint] 401 and 404 are not retried and map to LedgerAuthError / LedgerNotFoundError with requestId', async () => {
  const a = harness([{ status: 401, headers: { 'X-Request-Id': 'req_1' } }]);
  await assert.rejects(fetchExportRecords('exp_1', a.opts), (err) => err.name === 'LedgerAuthError' && err.requestId === 'req_1');
  assert.equal(a.fetch.calls.length, 1);
  assert.deepEqual(a.sleeps, []);
  const b = harness([{ status: 404, headers: { 'X-Request-Id': 'req_2' } }]);
  await assert.rejects(fetchExportRecords('exp_nope', b.opts), (err) => err.name === 'LedgerNotFoundError' && err.status === 404 && err.requestId === 'req_2');
  assert.equal(b.fetch.calls.length, 1);
});
