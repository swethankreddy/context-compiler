import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExportRecords, LedgerError } from '../src/ledgerClient.js';

function fakeFetch(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = pages.shift();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}

const opts = (fetch) => ({ baseUrl: 'https://api.test', token: 'tok', fetch, sleep: async () => {} });

test('follows next_cursor until null', async () => {
  const fetch = fakeFetch([
    { body: { data: [{ id: 'r1' }], next_cursor: 'c1' } },
    { body: { data: [{ id: 'r2' }], next_cursor: null } },
  ]);
  const out = await fetchExportRecords('exp_1', opts(fetch));
  assert.deepEqual(out.map((r) => r.id), ['r1', 'r2']);
  assert.match(fetch.calls[1].url, /cursor=c1/);
});

test('sends bearer token and limit=200', async () => {
  const fetch = fakeFetch([{ body: { data: [], next_cursor: null } }]);
  await fetchExportRecords('exp_1', opts(fetch));
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.match(fetch.calls[0].url, /limit=200/);
});

test('keeps following the cursor after an empty page', async () => {
  const fetch = fakeFetch([
    { body: { data: [{ id: 'r1' }], next_cursor: 'c1' } },
    { body: { data: [], next_cursor: 'c2' } },
    { body: { data: [{ id: 'r2' }], next_cursor: null } },
  ]);
  const out = await fetchExportRecords('exp_1', opts(fetch));
  assert.deepEqual(out.map((r) => r.id), ['r1', 'r2']);
});

test('non-2xx surfaces a LedgerError with status', async () => {
  const fetch = fakeFetch([{ status: 404, body: { error: 'not_found' } }]);
  await assert.rejects(fetchExportRecords('exp_x', opts(fetch)), (err) => err instanceof LedgerError && err.status === 404);
});
