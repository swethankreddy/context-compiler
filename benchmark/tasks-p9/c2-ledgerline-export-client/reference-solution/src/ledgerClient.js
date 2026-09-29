// Client for the Ledgerline partner API (exports).
import { buildUrl, readJson } from './http.js';

const PAGE_LIMIT = 200;
const API_VERSION = '2025-03-15';
const MAX_RATE_LIMIT_RETRIES = 5;
const MAX_SERVER_RETRIES = 3;
const BACKOFF_BASE_MS = 200;
const TRANSIENT = new Set([500, 502, 503, 504]);

export class LedgerHttpError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.name = 'LedgerHttpError';
    this.status = status;
    if (requestId) this.requestId = requestId;
  }
}
export class LedgerAuthError extends LedgerHttpError {
  constructor(...args) { super(...args); this.name = 'LedgerAuthError'; }
}
export class LedgerNotFoundError extends LedgerHttpError {
  constructor(...args) { super(...args); this.name = 'LedgerNotFoundError'; }
}
export class LedgerRateLimitError extends LedgerHttpError {
  constructor(...args) { super(...args); this.name = 'LedgerRateLimitError'; }
}
// Backwards-compatible alias.
export const LedgerError = LedgerHttpError;

function errorFor(res, url) {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  const msg = `Ledgerline responded ${res.status} for ${url}`;
  if (res.status === 401) return new LedgerAuthError(401, msg, requestId);
  if (res.status === 404) return new LedgerNotFoundError(404, msg, requestId);
  if (res.status === 429) return new LedgerRateLimitError(429, msg, requestId);
  return new LedgerHttpError(res.status, msg, requestId);
}

async function requestWithRetry(doFetch, sleep, url, headers) {
  let rateLimitRetries = 0;
  let serverRetries = 0;
  for (;;) {
    const res = await doFetch(url, { method: 'GET', headers });
    if (res.ok) return res;
    if (res.status === 429 && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      rateLimitRetries += 1;
      const seconds = Number.parseInt(res.headers.get('retry-after') ?? '0', 10) || 0;
      await sleep(seconds * 1000);
      continue;
    }
    if (TRANSIENT.has(res.status) && serverRetries < MAX_SERVER_RETRIES) {
      await sleep(BACKOFF_BASE_MS * 2 ** serverRetries);
      serverRetries += 1;
      continue;
    }
    throw errorFor(res, url);
  }
}

export async function fetchExportRecords(exportId, options = {}) {
  const {
    baseUrl,
    token,
    fetch: doFetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onPage = () => {},
  } = options;

  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Ledgerline-Version': API_VERSION,
    Accept: 'application/json',
  };

  const records = [];
  const seen = new Set();
  let cursor;
  let page = 0;
  do {
    const url = buildUrl(baseUrl, `v2/exports/${encodeURIComponent(exportId)}/records`, {
      limit: PAGE_LIMIT,
      cursor,
    });
    const res = await requestWithRetry(doFetch, sleep, url, headers);
    const body = await readJson(res);
    page += 1;
    onPage(page, body.data.length);
    for (const rec of body.data) {
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      records.push(rec);
    }
    cursor = body.next_cursor;
  } while (cursor);

  return records;
}
