// Client for the Ledgerline partner API (exports).
import { buildUrl, readJson } from './http.js';

const PAGE_LIMIT = 200;

export class LedgerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
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
    'X-Ledgerline-Version': '2024-11-01',
    Accept: 'application/json',
  };

  const records = [];
  let cursor;
  let page = 0;
  do {
    const url = buildUrl(baseUrl, `v2/exports/${encodeURIComponent(exportId)}/records`, {
      limit: PAGE_LIMIT,
      cursor,
    });
    const res = await doFetch(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new LedgerError(res.status, `Ledgerline responded ${res.status} for ${url}`);
    }
    const body = await readJson(res);
    page += 1;
    onPage(page, body.data.length);
    records.push(...body.data);
    cursor = body.next_cursor;
  } while (cursor);

  return records;
}
