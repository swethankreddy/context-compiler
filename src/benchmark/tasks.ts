/**
 * Phase 6 A/B benchmark tasks: small synthetic repositories with a prior Claude Code session,
 * a raw user instruction and a HIDDEN deterministic verifier (copied in only after the run).
 *
 * Written after Context Compiler v1 was frozen (tag context-compiler-v1) and not used to tune it.
 * All content is invented.
 */
import { TranscriptBuilder } from "../evaluation/transcript-builder.js";

export interface BenchTask {
  id: string;
  name: string;
  category: string;
  instruction: string;
  /** Committed starting state. */
  files: Record<string, string>;
  /** Uncommitted changes made during the prior session (the agent's recent work). */
  sessionChanges?: Record<string, string>;
  /** The prior session, as Claude Code would have recorded it. */
  transcript: (root: string) => TranscriptBuilder;
  /** Hidden verifier tests, written to .verify/ after the run. */
  verifier: Record<string, string>;
  /** Paths (regex) the task legitimately changes; anything else counts as an unnecessary change. */
  expectedChanges: RegExp[];
}

const pkg = (name: string, test = "node --test") => JSON.stringify({ name, version: "1.0.0", type: "module", private: true, scripts: { test } }, null, 2) + "\n";
const imp = (what: string, from: string) => `import { ${what} } from "../${from}";`;
const T = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n`;

export const BENCH_TASKS: BenchTask[] = [
  {
    id: "T01",
    name: "simple: version bump",
    category: "simple",
    instruction: "bump the package version to 1.4.0",
    files: {
      "package.json": JSON.stringify({ name: "greeter", version: "1.3.2", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/index.js": 'export const greet = (name) => `Hello, ${name}!`;\n',
      "test/index.test.js": `${T}${imp("greet", "src/index.js")}\ntest("greet", () => assert.equal(greet("Ada"), "Hello, Ada!"));\n`,
    },
    transcript: (r) => new TranscriptBuilder({ cwd: r }).user("what does src/index.js export?").read(`${r}/src/index.js`).say("It exports one function, `greet(name)`, which returns a greeting string."),
    verifier: {
      "version.test.js": `${T}import { readFileSync } from "node:fs";\ntest("version bumped", () => assert.equal(JSON.parse(readFileSync("package.json", "utf8")).version, "1.4.0"));\n`,
    },
    expectedChanges: [/^package(-lock)?\.json$/],
  },
  {
    id: "T02",
    name: "vague debugging: auth",
    category: "vague-debugging",
    instruction: "fix the auth issue",
    files: {
      "package.json": pkg("auth-demo"),
      "src/auth/issue.js": "// expiresAt is a millisecond timestamp.\nexport function issueToken(user, ttlMs = 15 * 60 * 1000, now = Date.now()) {\n  return { user, value: `tok_${user}_${now}`, expiresAt: now + ttlMs };\n}\n",
      "src/auth/session.js":
        "import { issueToken } from \"./issue.js\";\n\nexport function isExpired(token, now = Date.now()) {\n  return token.expiresAt < Math.floor(now / 1000);\n}\n\nexport async function getSession(token, { refresh = async (t) => issueToken(t.user), now = Date.now() } = {}) {\n  if (isExpired(token, now)) return refresh(token);\n  return token;\n}\n",
      "src/auth/password.js": "import { createHash } from \"node:crypto\";\n\n// TODO: enforce a minimum password length.\nexport const hashPassword = (pw, salt) => createHash(\"sha256\").update(salt + pw).digest(\"hex\");\nexport const verifyPassword = (pw, salt, hash) => hashPassword(pw, salt) === hash;\n",
      "test/auth.test.js": `${T}${imp("hashPassword, verifyPassword", "src/auth/password.js")}\n${imp("issueToken", "src/auth/issue.js")}\ntest("hash roundtrip", () => assert.ok(verifyPassword("pw", "s", hashPassword("pw", "s"))));\ntest("issue sets expiry", () => { const t = issueToken("u", 1000, 5000); assert.equal(t.expiresAt, 6000); });\n`,
      "README.md": "# auth-demo\n\nSession handling demo.\n",
    },
    sessionChanges: { "README.md": "# auth-demo\n\n![build](https://img.shields.io/badge/build-passing-green)\n\nSession handling demo.\n" },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("users keep getting logged out — expired sessions aren't being refreshed")
        .read(`${r}/src/auth/session.js`)
        .bash(`node -e "import('./src/auth/session.js').then(m => console.log(m.isExpired({ expiresAt: Date.now() - 1000 })))"`, { stdout: "false" })
        .say("`isExpired` returns false for a token that expired a second ago, so `getSession` never refreshes it. I'm looking into why.")
        .user("hold on, first add a build badge to the README")
        .edit(`${r}/README.md`)
        .say("Added the badge."),
    verifier: {
      "auth.test.js": `${T}import { isExpired, getSession } from "../src/auth/session.js";\nimport { verifyPassword, hashPassword } from "../src/auth/password.js";\ntest("expired token is expired", () => assert.equal(isExpired({ expiresAt: Date.now() - 1000 }), true));\ntest("future token is not expired", () => assert.equal(isExpired({ expiresAt: Date.now() + 60000 }), false));\ntest("getSession refreshes expired", async () => { const r = await getSession({ user: "u", expiresAt: Date.now() - 5 }, { refresh: async () => "fresh" }); assert.equal(r, "fresh"); });\ntest("password still works", () => assert.ok(verifyPassword("pw", "s", hashPassword("pw", "s"))));\n`,
    },
    expectedChanges: [/^src\/auth\/session\.js$/, /^src\/auth\/issue\.js$/, /^test\//],
  },
  {
    id: "T03",
    name: "previous failed attempt: discount",
    category: "previous-failure",
    instruction: "try fixing the discount bug again",
    files: {
      "package.json": pkg("shop"),
      "src/pricing.js": "// rate is a fraction: 0.1 means 10% off.\nexport const applyDiscount = (total, rate) => Math.round((total - total * rate) * 100) / 100;\n",
      "src/cart.js": "import { applyDiscount } from \"./pricing.js\";\n\nexport function checkout(items, discountPercent = 0) {\n  const total = items.reduce((n, i) => n + i.price, 0);\n  return applyDiscount(total, discountPercent);\n}\n",
      "src/invoice.js": "import { applyDiscount } from \"./pricing.js\";\n\n// Wholesale invoices get a flat 20% discount.\nexport const invoiceTotal = (lines) => applyDiscount(lines.reduce((n, l) => n + l.qty * l.unit, 0), 0.2);\n",
      "test/cart.test.js": `${T}${imp("checkout", "src/cart.js")}\ntest("10% discount", () => assert.equal(checkout([{ price: 100 }], 10), 90));\n`,
    },
    sessionChanges: { "src/pricing.js": "// rate is a fraction: 0.1 means 10% off.\nexport const applyDiscount = (total, rate) => Number((total - total * rate).toFixed(2));\n" },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("the cart discount is wrong")
        .read(`${r}/src/pricing.js`)
        .edit(`${r}/src/pricing.js`)
        .bash("npm test", { exit: 1, stdout: "✖ 10% discount\n  AssertionError: Expected values to be strictly equal:\n  -900 !== 90" })
        .say("I changed the rounding in pricing.js, but the test still fails: checkout returns -900 instead of 90.")
        .user("ok leave it for now"),
    verifier: {
      "shop.test.js": `${T}import { checkout } from "../src/cart.js";\nimport { invoiceTotal } from "../src/invoice.js";\nimport { applyDiscount } from "../src/pricing.js";\ntest("10% off 100", () => assert.equal(checkout([{ price: 100 }], 10), 90));\ntest("25% off 100", () => assert.equal(checkout([{ price: 50 }, { price: 50 }], 25), 75));\ntest("no discount", () => assert.equal(checkout([{ price: 40 }]), 40));\ntest("invoice keeps fraction semantics", () => assert.equal(invoiceTotal([{ qty: 2, unit: 50 }]), 80));\ntest("applyDiscount takes a fraction", () => assert.equal(applyDiscount(200, 0.5), 100));\n`,
    },
    expectedChanges: [/^src\/cart\.js$/, /^src\/pricing\.js$/, /^test\//],
  },
  {
    id: "T04",
    name: "recently modified file: signup validation",
    category: "recent-modification",
    instruction: "add input validation to the signup form",
    files: {
      "package.json": pkg("forms"),
      "src/legacy/signupForm.js": "// Deprecated: kept for the old admin UI.\nexport function validateSignup(values) {\n  return { ok: true, errors: {} };\n}\n",
      "src/forms/login.js": "export function validate({ email, password }) {\n  const errors = {};\n  if (!email) errors.email = \"required\";\n  if (!password) errors.password = \"required\";\n  return { ok: Object.keys(errors).length === 0, errors };\n}\n",
      "test/login.test.js": `${T}${imp("validate", "src/forms/login.js")}\ntest("login requires fields", () => assert.equal(validate({}).ok, false));\n`,
    },
    sessionChanges: {
      "src/forms/signup.js": "export function createSignup({ email, password }) {\n  return { email, password };\n}\n\n// TODO: validation\nexport function validate(values) {\n  return { ok: true, errors: {} };\n}\n",
    },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("create a new signup form module in src/forms/signup.js. we'll add validation after: emails must contain an @ and a dot after it, and passwords need at least 10 characters")
        .write(`${r}/src/forms/signup.js`)
        .say("Created `src/forms/signup.js` with `createSignup()` and a `validate()` stub."),
    verifier: {
      "signup.test.js": `${T}import { validate } from "../src/forms/signup.js";\ntest("valid", () => assert.equal(validate({ email: "a@b.co", password: "0123456789" }).ok, true));\ntest("bad email", () => assert.equal(validate({ email: "ab.co", password: "0123456789" }).ok, false));\ntest("email needs dot after @", () => assert.equal(validate({ email: "a@bco", password: "0123456789" }).ok, false));\ntest("9-char password rejected", () => assert.equal(validate({ email: "a@b.co", password: "012345678" }).ok, false));\n`,
    },
    expectedChanges: [/^src\/forms\/signup\.js$/, /^test\//],
  },
  {
    id: "T05",
    name: "project instructions: migration",
    category: "project-instructions",
    instruction: "add a migration that adds a role column to users",
    files: {
      "package.json": pkg("db-app"),
      "CLAUDE.md": "# Project rules\n\n## Migrations\n- Create `db/migrations/NNN_description.sql`, where NNN is the next 3-digit number.\n- Every migration has a `-- up` section and a `-- down` section that reverses it.\n- Never edit an existing migration.\n",
      "db/migrations/001_init.sql": "-- up\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n-- down\nDROP TABLE users;\n",
      "db/migrations/002_add_email.sql": "-- up\nALTER TABLE users ADD COLUMN email TEXT;\n-- down\nALTER TABLE users DROP COLUMN email;\n",
      "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n`,
    },
    transcript: (r) => new TranscriptBuilder({ cwd: r }).user("what tables do we have?").read(`${r}/db/migrations/001_init.sql`).say("There is one table, `users` (id, name, email)."),
    verifier: {
      "migration.test.js": `${T}import { readdirSync, readFileSync } from "node:fs";\nconst dir = "db/migrations";\nconst files = readdirSync(dir).sort();\ntest("new 003 migration", () => assert.ok(files.some((f) => /^003_.+\\.sql$/.test(f)), files.join(",")));\ntest("up adds role, down drops it", () => { const f = files.find((f) => /^003_/.test(f)); const s = readFileSync(\`\${dir}/\${f}\`, "utf8"); const [up, down] = s.split(/--\\s*down/i); assert.match(up, /--\\s*up/i); assert.match(up, /add\\s+(column\\s+)?role/i); assert.ok(down && /drop\\s+(column\\s+)?role/i.test(down)); });\ntest("old migrations untouched", () => { assert.equal(readFileSync(\`\${dir}/001_init.sql\`, "utf8"), "-- up\\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\\n-- down\\nDROP TABLE users;\\n"); assert.equal(readFileSync(\`\${dir}/002_add_email.sql\`, "utf8"), "-- up\\nALTER TABLE users ADD COLUMN email TEXT;\\n-- down\\nALTER TABLE users DROP COLUMN email;\\n"); });\n`,
    },
    expectedChanges: [/^db\/migrations\/003_.+\.sql$/],
  },
  {
    id: "T06",
    name: "conflicting evidence: upload",
    category: "conflicting-evidence",
    instruction: "fix the upload",
    files: {
      "package.json": pkg("uploader"),
      "src/upload.js": "export const MAX_UPLOAD_BYTES = 1 * 1024 * 1024;\n\nexport function accept(buf) {\n  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, reason: \"too large\" };\n  return { ok: true, size: buf.length };\n}\n",
      "src/server/limits.js": "// Request body limit enforced before any handler runs.\nexport const BODY_LIMIT_BYTES = 1 * 1024 * 1024;\n",
      "src/server/handler.js": "import { BODY_LIMIT_BYTES } from \"./limits.js\";\nimport { accept } from \"../upload.js\";\n\nexport function handleUpload(body) {\n  if (body.length > BODY_LIMIT_BYTES) return { status: 413 };\n  const r = accept(body);\n  return r.ok ? { status: 200, size: r.size } : { status: 400, error: r.reason };\n}\n",
      "test/upload.test.js": `${T}${imp("accept", "src/upload.js")}\ntest("accepts 5MB", () => assert.equal(accept(Buffer.alloc(5 * 1024 * 1024)).ok, true));\n`,
    },
    sessionChanges: { "src/upload.js": "export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;\n\nexport function accept(buf) {\n  if (buf.length > MAX_UPLOAD_BYTES) return { ok: false, reason: \"too large\" };\n  return { ok: true, size: buf.length };\n}\n" },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("uploading 5MB files fails")
        .read(`${r}/src/upload.js`)
        .edit(`${r}/src/upload.js`)
        .bash("npm test", { stdout: "✔ accepts 5MB\nℹ tests 1\nℹ pass 1\nℹ fail 0" })
        .say("Raised MAX_UPLOAD_BYTES to 50MB in upload.js; the upload test passes.")
        .user("it still fails in the browser — the network tab shows 413"),
    verifier: {
      "handler.test.js": `${T}import { handleUpload } from "../src/server/handler.js";\ntest("5MB upload succeeds end to end", () => assert.equal(handleUpload(Buffer.alloc(5 * 1024 * 1024)).status, 200));\ntest("60MB still rejected", () => assert.notEqual(handleUpload(Buffer.alloc(60 * 1024 * 1024)).status, 200));\n`,
    },
    expectedChanges: [/^src\/server\/limits\.js$/, /^src\/server\/handler\.js$/, /^src\/upload\.js$/, /^test\//],
  },
  {
    id: "T07",
    name: "large irrelevant output: date parsing",
    category: "large-output",
    instruction: "fix the date parsing bug",
    files: {
      "package.json": pkg("dates", "TZ=Asia/Tokyo node --test"),
      "src/dates.js": "// Parses YYYY-MM-DD and returns the same calendar date as YYYY-MM-DD.\nexport function parseISODate(s) {\n  const [y, m, d] = s.split(\"-\").map(Number);\n  return new Date(y, m - 1, d).toISOString().slice(0, 10);\n}\n",
      "src/widgets.js": "export const widget = (n) => ({ id: n, label: `Widget ${n}` });\n",
      "test/dates.test.js": `${T}${imp("parseISODate", "src/dates.js")}\ntest("parses ISO dates", () => assert.equal(parseISODate("2026-03-01"), "2026-03-01"));\n`,
      "test/widgets.test.js": `${T}${imp("widget", "src/widgets.js")}\nfor (let i = 0; i < 400; i++) test(\`widget \${i} renders\`, () => assert.equal(widget(i).label, \`Widget \${i}\`));\n`,
    },
    transcript: (r) => {
      const noise = Array.from({ length: 400 }, (_, i) => `✔ widget ${i} renders (0.1ms)`).join("\n");
      return new TranscriptBuilder({ cwd: r })
        .user("dates from the API show the wrong day")
        .bash("npm test", { exit: 1, stdout: `${noise.slice(0, noise.length / 2)}\n✖ parses ISO dates (1.2ms)\n  AssertionError: '2026-02-28' !== '2026-03-01'\n${noise.slice(noise.length / 2)}\nℹ tests 401\nℹ pass 400\nℹ fail 1` });
    },
    verifier: {
      "dates.test.js": `${T}import { execFileSync } from "node:child_process";\nconst run = (tz) => execFileSync(process.execPath, ["-e", "import('./src/dates.js').then(m => process.stdout.write([m.parseISODate('2026-03-01'), m.parseISODate('2026-12-31'), m.parseISODate('2024-02-29')].join(',')))"], { env: { ...process.env, TZ: tz } }).toString();\nfor (const tz of ["Asia/Tokyo", "America/New_York", "UTC", "Pacific/Kiritimati"]) test(\`correct in \${tz}\`, () => assert.equal(run(tz), "2026-03-01,2026-12-31,2024-02-29"));\n`,
    },
    expectedChanges: [/^src\/dates\.js$/, /^test\/dates\.test\.js$/],
  },
  {
    id: "T08",
    name: "multiple files: CSV export",
    category: "multi-file",
    instruction: "implement the CSV export we discussed",
    files: {
      "package.json": pkg("reports"),
      "src/lib/csv.js": "const cell = (v) => { const s = String(v); return /[\",\\n]/.test(s) ? `\"${s.replace(/\"/g, '\"\"')}\"` : s; };\nexport const toCsv = (rows) => rows.map((r) => r.map(cell).join(\",\")).join(\"\\n\");\n",
      "src/reports.js": "const DATA = [\n  { name: \"Acme, Inc.\", amount: 12.5, date: \"2026-01-03\" },\n  { name: \"Globex\", amount: 7, date: \"2026-01-04\" },\n  { name: \"Initech\", amount: 99.999, date: \"2026-02-10\" },\n];\n\nexport function getReportRows({ month } = {}) {\n  return month ? DATA.filter((r) => r.date.startsWith(month)) : DATA;\n}\n",
      "src/index.js": "export { getReportRows } from \"./reports.js\";\n",
      "test/reports.test.js": `${T}${imp("getReportRows", "src/index.js")}\ntest("filters by month", () => assert.equal(getReportRows({ month: "2026-01" }).length, 2));\n`,
    },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("plan for the CSV export: add exportReportCsv(filters) to src/reports.js that returns CSV text for getReportRows(filters). header row must be exactly: Name,Amount (USD),Date. format amounts with 2 decimals. reuse toCsv from src/lib/csv.js (it handles quoting) and export the function from src/index.js")
        .read(`${r}/src/lib/csv.js`)
        .read(`${r}/src/reports.js`)
        .say("Plan: add `exportReportCsv(filters)` in `src/reports.js` using `toCsv`, format amounts with `toFixed(2)`, and re-export it from `src/index.js`. I'll implement it when you say go."),
    verifier: {
      "csv.test.js": `${T}import { exportReportCsv } from "../src/index.js";\ntest("header", () => assert.equal(exportReportCsv().split("\\n")[0], "Name,Amount (USD),Date"));\ntest("quoting and 2 decimals", () => assert.equal(exportReportCsv({ month: "2026-01" }), 'Name,Amount (USD),Date\\n"Acme, Inc.",12.50,2026-01-03\\nGlobex,7.00,2026-01-04'));\ntest("rounding", () => assert.match(exportReportCsv({ month: "2026-02" }), /Initech,100\\.00,2026-02-10/));\n`,
    },
    expectedChanges: [/^src\/reports\.js$/, /^src\/index\.js$/, /^test\//],
  },
  {
    id: "T09",
    name: "continue: async migration",
    category: "continue",
    instruction: "continue from where you left off",
    files: {
      "package.json": pkg("api"),
      "src/api/users.js": "const USERS = { 1: { id: 1, name: \"Ada\" } };\nexport function getUser(id, cb) {\n  setImmediate(() => (USERS[id] ? cb(null, USERS[id]) : cb(new Error(\"not found\"))));\n}\n",
      "src/api/orders.js": "const ORDERS = { 7: { id: 7, userId: 1, total: 30 } };\nexport function getOrder(id, cb) {\n  setImmediate(() => (ORDERS[id] ? cb(null, ORDERS[id]) : cb(new Error(\"not found\"))));\n}\n",
      "src/api/invoices.js": "const INVOICES = { 3: { id: 3, orderId: 7, paid: false } };\nexport function getInvoice(id, cb) {\n  setImmediate(() => (INVOICES[id] ? cb(null, INVOICES[id]) : cb(new Error(\"not found\"))));\n}\n",
      "test/api.test.js": `${T}import { getUser } from "../src/api/users.js";\ntest("user exists", async () => assert.equal((await getUser(1)).name, "Ada"));\n`,
    },
    sessionChanges: {
      "src/api/users.js": "const USERS = { 1: { id: 1, name: \"Ada\" } };\nexport async function getUser(id) {\n  if (!USERS[id]) throw new Error(\"not found\");\n  return USERS[id];\n}\n",
      "src/api/orders.js": "const ORDERS = { 7: { id: 7, userId: 1, total: 30 } };\nexport async function getOrder(id) {\n  if (!ORDERS[id]) throw new Error(\"not found\");\n  return ORDERS[id];\n}\n",
    },
    transcript: (r) =>
      new TranscriptBuilder({ cwd: r })
        .user("convert getUser, getOrder and getInvoice in src/api to async functions that return promises (no callbacks). a missing id should reject with Error('not found')")
        .edit(`${r}/src/api/users.js`)
        .edit(`${r}/src/api/orders.js`)
        .say("Converted `getUser` and `getOrder` to async. `getInvoice` is next."),
    verifier: {
      "api.test.js": `${T}import { getUser } from "../src/api/users.js";\nimport { getOrder } from "../src/api/orders.js";\nimport { getInvoice } from "../src/api/invoices.js";\ntest("invoice async", async () => { const p = getInvoice(3); assert.ok(p instanceof Promise); assert.equal((await p).orderId, 7); });\ntest("invoice missing rejects", async () => assert.rejects(getInvoice(99), /not found/));\ntest("invoice has no callback param", () => assert.equal(getInvoice.length, 1));\ntest("users/orders still async", async () => { assert.equal((await getUser(1)).name, "Ada"); assert.equal((await getOrder(7)).total, 30); });\n`,
    },
    expectedChanges: [/^src\/api\/invoices\.js$/, /^test\//],
  },
  {
    id: "T10",
    name: "already precise: clamp",
    category: "precise",
    instruction: "In src/math.js, fix clamp(value, min, max) so values above max return max. The failing test is test/math.test.js.",
    files: {
      "package.json": pkg("mathlib"),
      "src/math.js": "export function clamp(value, min, max) {\n  if (value < min) return min;\n  if (value > max) return min;\n  return value;\n}\n",
      "test/math.test.js": `${T}${imp("clamp", "src/math.js")}\ntest("clamps high", () => assert.equal(clamp(15, 0, 10), 10));\n`,
    },
    transcript: (r) => new TranscriptBuilder({ cwd: r }).user("run the tests").bash("npm test", { exit: 1, stdout: "✖ clamps high\n  AssertionError: 0 !== 10" }).say("One test fails: `clamp(15, 0, 10)` returns 0 instead of 10."),
    verifier: {
      "clamp.test.js": `${T}import { clamp } from "../src/math.js";\ntest("high", () => assert.equal(clamp(15, 0, 10), 10));\ntest("low", () => assert.equal(clamp(-5, 0, 10), 0));\ntest("inside", () => assert.equal(clamp(5, 0, 10), 5));\ntest("edges", () => { assert.equal(clamp(0, 0, 10), 0); assert.equal(clamp(10, 0, 10), 10); });\n`,
    },
    expectedChanges: [/^src\/math\.js$/, /^test\//],
  },
];
