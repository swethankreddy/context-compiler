/**
 * Reference solutions, used only by `--check` to prove each hidden verifier fails on the
 * starting state and passes on a correct solution. Never shown to the agent.
 */
export const SOLUTIONS = {
    T01: { "package.json": JSON.stringify({ name: "greeter", version: "1.4.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n" },
    T02: {
        "src/auth/session.js": "import { issueToken } from \"./issue.js\";\n\nexport function isExpired(token, now = Date.now()) {\n  return token.expiresAt <= now;\n}\n\nexport async function getSession(token, { refresh = async (t) => issueToken(t.user), now = Date.now() } = {}) {\n  if (isExpired(token, now)) return refresh(token);\n  return token;\n}\n",
    },
    T03: {
        "src/cart.js": "import { applyDiscount } from \"./pricing.js\";\n\nexport function checkout(items, discountPercent = 0) {\n  const total = items.reduce((n, i) => n + i.price, 0);\n  return applyDiscount(total, discountPercent / 100);\n}\n",
    },
    T04: {
        "src/forms/signup.js": "export function createSignup({ email, password }) {\n  return { email, password };\n}\n\nexport function validate({ email = \"\", password = \"\" } = {}) {\n  const errors = {};\n  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) errors.email = \"invalid\";\n  if (password.length < 10) errors.password = \"too short\";\n  return { ok: Object.keys(errors).length === 0, errors };\n}\n",
    },
    T05: { "db/migrations/003_add_role.sql": "-- up\nALTER TABLE users ADD COLUMN role TEXT;\n-- down\nALTER TABLE users DROP COLUMN role;\n" },
    T06: { "src/server/limits.js": "// Request body limit enforced before any handler runs.\nexport const BODY_LIMIT_BYTES = 50 * 1024 * 1024;\n" },
    T07: {
        "src/dates.js": "// Parses YYYY-MM-DD and returns the same calendar date as YYYY-MM-DD.\nexport function parseISODate(s) {\n  const [y, m, d] = s.split(\"-\").map(Number);\n  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);\n}\n",
    },
    T08: {
        "src/reports.js": "import { toCsv } from \"./lib/csv.js\";\n\nconst DATA = [\n  { name: \"Acme, Inc.\", amount: 12.5, date: \"2026-01-03\" },\n  { name: \"Globex\", amount: 7, date: \"2026-01-04\" },\n  { name: \"Initech\", amount: 99.999, date: \"2026-02-10\" },\n];\n\nexport function getReportRows({ month } = {}) {\n  return month ? DATA.filter((r) => r.date.startsWith(month)) : DATA;\n}\n\nexport function exportReportCsv(filters) {\n  const rows = getReportRows(filters).map((r) => [r.name, r.amount.toFixed(2), r.date]);\n  return toCsv([[\"Name\", \"Amount (USD)\", \"Date\"], ...rows]);\n}\n",
        "src/index.js": "export { getReportRows, exportReportCsv } from \"./reports.js\";\n",
    },
    T09: {
        "src/api/invoices.js": "const INVOICES = { 3: { id: 3, orderId: 7, paid: false } };\nexport async function getInvoice(id) {\n  if (!INVOICES[id]) throw new Error(\"not found\");\n  return INVOICES[id];\n}\n",
    },
    T10: { "src/math.js": "export function clamp(value, min, max) {\n  if (value < min) return min;\n  if (value > max) return max;\n  return value;\n}\n" },
};
