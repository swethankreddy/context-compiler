import { fetchExportRecords } from '../src/ledgerClient.js';

const [exportId] = process.argv.slice(2);
if (!exportId) {
  console.error('usage: npm run sync -- <exportId>');
  process.exit(2);
}

const records = await fetchExportRecords(exportId, {
  baseUrl: process.env.LEDGERLINE_BASE_URL ?? 'https://sandbox.api.ledgerline.io',
  token: process.env.LEDGERLINE_TOKEN,
  onPage: (page, n) => console.log(`page ${page}: ${n} records`),
});
console.log(`fetched ${records.length} records for ${exportId}`);
