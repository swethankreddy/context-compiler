const T = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n`;
const pkg = (name) => JSON.stringify({ name, version: "1.0.0", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n";
export const RECOVERY_TASKS = [
    {
        id: "R1",
        name: "login rate limiting (constraints + correction)",
        instruction: "finish the login rate limiting",
        files: {
            "package.json": pkg("login"),
            "src/limiter.js": "// Fixed-window limiter. now() is injectable for tests.\nexport function createLimiter({ limit, windowMs, now = () => Date.now() }) {\n  const hits = new Map();\n  return {\n    hit(key) {\n      const t = now();\n      const e = hits.get(key);\n      if (!e || t - e.start >= windowMs) {\n        hits.set(key, { start: t, count: 1 });\n        return { allowed: true, retryAfterMs: 0 };\n      }\n      e.count++;\n      if (e.count > limit) return { allowed: false, retryAfterMs: e.start + windowMs - t };\n      return { allowed: true, retryAfterMs: 0 };\n    },\n  };\n}\n",
            "src/login.js": "// POST /login handler. req = { ip, body: { username, password } }; returns { status, headers, body }.\nexport function createLoginHandler({ checkPassword, now = () => Date.now() } = {}) {\n  return function login(req) {\n    const ok = checkPassword(req.body.username, req.body.password);\n    return ok ? { status: 200, headers: {}, body: { ok: true } } : { status: 401, headers: {}, body: { ok: false } };\n  };\n}\n",
            "test/limiter.test.js": `${T}import { createLimiter } from "../src/limiter.js";\ntest("limits", () => { let t = 0; const l = createLimiter({ limit: 2, windowMs: 100, now: () => t }); l.hit("a"); l.hit("a"); assert.equal(l.hit("a").allowed, false); });\n`,
        },
        before: (b, r) => b.user("add rate limiting to POST /login in src/login.js")
            .read(`${r}/src/login.js`)
            .say("What limit do you want?")
            .user("7 attempts per 10 minutes. when blocked return 429 with a Retry-After header in whole seconds")
            .write(`${r}/src/limiter.js`)
            .bash("npm test", { stdout: "✔ limits\nℹ pass 1" })
            .say("Added a fixed-window limiter in src/limiter.js. I'll key it by IP when I wire it into login.")
            .user("no — key by IP + username together. keying by IP alone blocks the whole office behind our NAT")
            .say("Understood: the key will be `${ip}:${username}`."),
        summary: "Summary:\n1. Primary request: add rate limiting to POST /login.\n2. Work done: a fixed-window limiter exists in src/limiter.js (createLimiter) with tests passing.\n3. Remaining: wire the limiter into src/login.js.",
        after: (b) => b.user("lunch break, back soon"),
        verifier: {
            "login.test.js": `${T}import { createLoginHandler } from "../src/login.js";\nconst mk = () => { let t = 1_000_000; const h = createLoginHandler({ checkPassword: () => false, now: () => t }); return { h, adv: (ms) => (t += ms) }; };\nconst req = (ip, username) => ({ ip, body: { username, password: "x" } });\ntest("[core] blocks after the limit with 429", () => { const { h } = mk(); let r; for (let i = 0; i < 12; i++) r = h(req("1.1.1.1", "ada")); assert.equal(r.status, 429); });\ntest("[constraint] 7 attempts allowed, 8th blocked", () => { const { h } = mk(); for (let i = 0; i < 7; i++) assert.notEqual(h(req("1.1.1.1", "ada")).status, 429, "attempt " + (i + 1)); assert.equal(h(req("1.1.1.1", "ada")).status, 429); });\ntest("[constraint] window is 10 minutes", () => { const { h, adv } = mk(); for (let i = 0; i < 8; i++) h(req("1.1.1.1", "ada")); adv(9 * 60_000); assert.equal(h(req("1.1.1.1", "ada")).status, 429); adv(61_000); assert.notEqual(h(req("1.1.1.1", "ada")).status, 429); });\ntest("[constraint] keyed by ip + username", () => { const { h } = mk(); for (let i = 0; i < 8; i++) h(req("1.1.1.1", "ada")); assert.notEqual(h(req("1.1.1.1", "bob")).status, 429); });\ntest("[constraint] Retry-After in whole seconds", () => { const { h } = mk(); let r; for (let i = 0; i < 8; i++) r = h(req("1.1.1.1", "ada")); const v = r.headers["Retry-After"] ?? r.headers["retry-after"]; assert.ok(/^\\d+$/.test(String(v)) && Number(v) > 0 && Number(v) <= 600, String(v)); });\n`,
        },
        solution: {
            "src/login.js": "import { createLimiter } from \"./limiter.js\";\n\nexport function createLoginHandler({ checkPassword, now = () => Date.now() } = {}) {\n  const limiter = createLimiter({ limit: 7, windowMs: 10 * 60 * 1000, now });\n  return function login(req) {\n    const r = limiter.hit(`${req.ip}:${req.body.username}`);\n    if (!r.allowed) return { status: 429, headers: { \"Retry-After\": String(Math.ceil(r.retryAfterMs / 1000)) }, body: { ok: false } };\n    const ok = checkPassword(req.body.username, req.body.password);\n    return ok ? { status: 200, headers: {}, body: { ok: true } } : { status: 401, headers: {}, body: { ok: false } };\n  };\n}\n",
        },
        expectedChanges: [/^src\/login\.js$/, /^src\/limiter\.js$/, /^test\//],
        keyFacts: [
            { name: "7 attempts", re: /\b7\b|seven/i },
            { name: "10 minutes", re: /10 min|ten min|600/i },
            { name: "ip + username key", re: /ip\s*\+\s*username|ip and username|\$\{ip\}:\$\{username\}|ip:username/i },
            { name: "429 + Retry-After seconds", re: /retry-after/i },
        ],
    },
    {
        id: "R2",
        name: "bank CSV import (format known only from a pasted sample)",
        instruction: "finish the bank statement importer",
        files: {
            "package.json": pkg("bank"),
            "src/importer.js": "// Parses one line of the bank's CSV export into { date: 'YYYY-MM-DD', description, amountCents }.\nexport function parseRow(line) {\n  throw new Error(\"not implemented\");\n}\n\nexport function parseStatement(text) {\n  return text.trim().split(/\\r?\\n/).slice(1).map(parseRow);\n}\n",
            "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n`,
        },
        before: (b) => b.pasted("here are the first lines of the bank export, write parseRow for it", "Buchungstag;Verwendungszweck;Betrag\n03.02.2026;REWE Markt 1234;-45,90\n28.01.2026;Gehalt Januar;2.150,00")
            .say("The export is semicolon-separated, dates are DD.MM.YYYY, and amounts use a comma for decimals and a dot for thousands. The first line is a header.")
            .bash("node -e \"console.log('03.02.2026;REWE;-45,90'.split(','))\"", { stdout: "[ '03.02.2026;REWE;-45', '90' ]" })
            .say("Splitting on commas breaks the amount, as expected; I'll split on semicolons.")
            .user("also descriptions can contain semicolons inside double quotes, like \"Miete; Februar\""),
        summary: "Summary:\n1. Primary request: implement parseRow in src/importer.js for the bank's CSV export.\n2. Findings: the export has a header row; splitting on commas does not work.\n3. Remaining: implement parseRow.",
        after: (b) => b.user("ok"),
        verifier: {
            "importer.test.js": `${T}import { parseRow, parseStatement } from "../src/importer.js";\ntest("[core] parses a simple row", () => assert.deepEqual(parseRow("03.02.2026;REWE Markt 1234;-45,90"), { date: "2026-02-03", description: "REWE Markt 1234", amountCents: -4590 }));\ntest("[constraint] thousands separator", () => assert.equal(parseRow("28.01.2026;Gehalt Januar;2.150,00").amountCents, 215000));\ntest("[constraint] quoted semicolons", () => assert.deepEqual(parseRow('01.02.2026;"Miete; Februar";-950,00'), { date: "2026-02-01", description: "Miete; Februar", amountCents: -95000 }));\ntest("[core] statement skips header", () => assert.equal(parseStatement("Buchungstag;Verwendungszweck;Betrag\\n03.02.2026;A;1,00\\n").length, 1));\n`,
        },
        solution: {
            "src/importer.js": "function split(line) {\n  const out = []; let cur = \"\", q = false;\n  for (const ch of line) {\n    if (ch === '\"') q = !q;\n    else if (ch === \";\" && !q) { out.push(cur); cur = \"\"; }\n    else cur += ch;\n  }\n  out.push(cur);\n  return out;\n}\n\nexport function parseRow(line) {\n  const [d, description, amount] = split(line);\n  const [dd, mm, yyyy] = d.split(\".\");\n  const cents = Math.round(Number(amount.replace(/\\./g, \"\").replace(\",\", \".\")) * 100);\n  return { date: `${yyyy}-${mm}-${dd}`, description, amountCents: cents };\n}\n\nexport function parseStatement(text) {\n  return text.trim().split(/\\r?\\n/).slice(1).map(parseRow);\n}\n",
        },
        expectedChanges: [/^src\/importer\.js$/, /^test\//],
        keyFacts: [
            { name: "semicolon separated", re: /semicolon|;-separated/i },
            { name: "DD.MM.YYYY dates", re: /DD\.MM\.YYYY/i },
            { name: "comma decimal, dot thousands", re: /comma.{0,20}decimal|decimal comma|thousands/i },
            { name: "quoted semicolons", re: /quot/i },
        ],
    },
    {
        id: "R3",
        name: "flaky retry (failed attempts, discovery, requirement)",
        instruction: "fix the flaky retry",
        files: {
            "package.json": pkg("retry"),
            "src/retry.js": "let attempts = 0;\nexport const MAX_ATTEMPTS = 3;\n\n// Calls fn until it succeeds or MAX_ATTEMPTS is reached.\nexport async function retry(fn, { delayMs = 10 } = {}) {\n  attempts = 0;\n  while (true) {\n    try {\n      attempts++;\n      return await fn();\n    } catch (e) {\n      if (attempts >= MAX_ATTEMPTS) throw e;\n      await new Promise((r) => setTimeout(r, delayMs));\n    }\n  }\n}\n",
            "test/retry.test.js": `${T}import { retry } from "../src/retry.js";\ntest("succeeds on 2nd try", async () => { let n = 0; assert.equal(await retry(async () => { if (++n < 2) throw new Error("x"); return "ok"; }, { delayMs: 1 }), "ok"); });\n`,
        },
        sessionChanges: {
            "src/retry.js": "let attempts = 0;\nexport const MAX_ATTEMPTS = 5;\n\n// Calls fn until it succeeds or MAX_ATTEMPTS is reached.\nexport async function retry(fn, { delayMs = 10 } = {}) {\n  attempts = 0;\n  while (true) {\n    try {\n      attempts++;\n      return await fn();\n    } catch (e) {\n      if (attempts >= MAX_ATTEMPTS) throw e;\n      await new Promise((r) => setTimeout(r, delayMs + Math.random() * delayMs));\n    }\n  }\n}\n",
        },
        before: (b, r) => b.user("the retry helper is flaky in production: sometimes a call gives up after 1 try, sometimes retries too many times. keep max 3 attempts, that's a product requirement")
            .read(`${r}/src/retry.js`)
            .edit(`${r}/src/retry.js`)
            .say("I raised MAX_ATTEMPTS to 5 and increased the delay to give slow calls more room.")
            .user("no, max 3 attempts is a hard requirement, don't change it")
            .edit(`${r}/src/retry.js`)
            .say("Added random jitter to the delay instead.")
            .bash("node scripts/concurrent-check.js", { exit: 1, stdout: "call A gave up after 1 attempt(s)\ncall B made 4 attempt(s)" })
            .say("Jitter didn't help. The real cause: `attempts` is a module-level variable shared by every concurrent retry() call, so concurrent calls reset and increment each other's counter. It needs to be local to each call."),
        summary: "Summary:\n1. Primary request: fix flakiness in the retry helper (src/retry.js).\n2. Attempts so far: increased MAX_ATTEMPTS/delay, then added jitter; neither fixed it.\n3. Remaining: find and fix the cause.",
        after: (b) => b.user("sorry, got pulled into a meeting"),
        verifier: {
            "retry.test.js": `${T}import { retry, MAX_ATTEMPTS } from "../src/retry.js";\nconst failing = (log) => async () => { log.n++; throw new Error("x"); };\ntest("[core] concurrent calls count attempts independently", async () => { const a = { n: 0 }, b = { n: 0 }; await Promise.allSettled([retry(failing(a), { delayMs: 5 }), retry(failing(b), { delayMs: 7 })]); assert.equal(a.n, 3); assert.equal(b.n, 3); });\ntest("[constraint] max 3 attempts", async () => { const a = { n: 0 }; await retry(failing(a), { delayMs: 1 }).catch(() => {}); assert.equal(a.n, 3); assert.equal(MAX_ATTEMPTS, 3); });\ntest("[core] still returns on success", async () => { let n = 0; assert.equal(await retry(async () => { if (++n < 3) throw new Error("x"); return 7; }, { delayMs: 1 }), 7); });\n`,
        },
        solution: {
            "src/retry.js": "export const MAX_ATTEMPTS = 3;\n\nexport async function retry(fn, { delayMs = 10 } = {}) {\n  let attempts = 0;\n  while (true) {\n    try {\n      attempts++;\n      return await fn();\n    } catch (e) {\n      if (attempts >= MAX_ATTEMPTS) throw e;\n      await new Promise((r) => setTimeout(r, delayMs));\n    }\n  }\n}\n",
        },
        expectedChanges: [/^src\/retry\.js$/, /^test\//, /^scripts\//],
        keyFacts: [
            { name: "max 3 attempts is a requirement", re: /\b3 attempts|max(imum)? (of )?3|three attempts/i },
            { name: "shared module-level counter is the cause", re: /module-level|shared|global/i },
        ],
    },
    {
        id: "R4",
        name: "migration with a later correction",
        instruction: "finish the roles migration",
        files: {
            "package.json": pkg("db"),
            "db/migrations/001_init.sql": "-- up\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n-- down\nDROP TABLE users;\n",
            "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n`,
        },
        sessionChanges: { "db/migrations/002_add_role.sql": "-- up\nALTER TABLE users ADD COLUMN role TEXT;\n-- down\n" },
        before: (b, r) => b.user("add a role column to users, new migration please")
            .write(`${r}/db/migrations/002_add_role.sql`)
            .say("Drafted 002_add_role.sql adding `role TEXT`.")
            .user("change of plan: role must be restricted to viewer, editor or admin via a CHECK constraint, NOT NULL, default viewer. and write the down section"),
        summary: "Summary:\n1. Primary request: add a role column to users via a new migration.\n2. Work done: drafted db/migrations/002_add_role.sql.\n3. Remaining: finish the migration.",
        after: (b) => b.user("ok"),
        verifier: {
            "migration.test.js": `${T}import { readFileSync } from "node:fs";\nconst s = () => readFileSync("db/migrations/002_add_role.sql", "utf8");\nconst [up, down] = [() => s().split(/--\\s*down/i)[0], () => s().split(/--\\s*down/i)[1] ?? ""];\ntest("[core] adds role column", () => assert.match(up(), /add\\s+column\\s+role/i));\ntest("[constraint] CHECK viewer/editor/admin", () => { const u = up(); assert.match(u, /check\\s*\\(/i); for (const v of ["viewer", "editor", "admin"]) assert.match(u, new RegExp("'" + v + "'")); });\ntest("[constraint] NOT NULL DEFAULT 'viewer'", () => { assert.match(up(), /not\\s+null/i); assert.match(up(), /default\\s+'viewer'/i); });\ntest("[core] down drops role", () => assert.match(down(), /drop\\s+column\\s+role/i));\n`,
        },
        solution: { "db/migrations/002_add_role.sql": "-- up\nALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin'));\n-- down\nALTER TABLE users DROP COLUMN role;\n" },
        expectedChanges: [/^db\/migrations\/002_add_role\.sql$/],
        keyFacts: [
            { name: "CHECK viewer/editor/admin", re: /viewer.{0,20}editor.{0,20}admin/i },
            { name: "NOT NULL default viewer", re: /default.{0,10}viewer/i },
        ],
    },
    {
        id: "R5",
        name: "webhook signature (discovered contract + failed approach)",
        instruction: "finish the webhook verification",
        files: {
            "package.json": pkg("hooks"),
            "src/webhook.js": "import { createHmac, timingSafeEqual } from \"node:crypto\";\n\n// verify({ headers, rawBody, secret, now }) -> boolean\nexport function verify({ headers, rawBody, secret, now = Date.now() }) {\n  return false; // TODO\n}\n",
            "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n`,
        },
        before: (b, r) => b.user("implement verify() in src/webhook.js for the payment provider's webhooks")
            .pasted("from their docs", "Each request carries X-Sig-256: hex HMAC-SHA256 of the raw request body using your signing secret, and X-Sig-Ts: the unix time in seconds when it was sent. Reject requests older than 300 seconds.")
            .edit(`${r}/src/webhook.js`)
            .bash("node scripts/replay.js fixtures/event.json", { exit: 1, stdout: "signature mismatch" })
            .say("My first version signed JSON.stringify(JSON.parse(body)); that re-serialises the payload and changes whitespace, so it never matches. It has to use the raw body bytes exactly as received."),
        summary: "Summary:\n1. Primary request: implement webhook signature verification in src/webhook.js.\n2. Status: a first attempt failed with a signature mismatch.\n3. Remaining: implement verify() correctly.",
        after: (b) => b.user("back"),
        verifier: {
            "webhook.test.js": `${T}import { createHmac } from "node:crypto";\nimport { verify } from "../src/webhook.js";\nconst secret = "whsec_test";\nconst rawBody = '{"id": 1,  "amount":  500}';\nconst sig = (body) => createHmac("sha256", secret).update(body).digest("hex");\nconst now = 1_800_000_000_000;\nconst h = (over = {}) => ({ "x-sig-256": sig(rawBody), "x-sig-ts": String(now / 1000 - 10), ...over });\ntest("[core] valid signature accepted", () => assert.equal(verify({ headers: h(), rawBody, secret, now }), true));\ntest("[no-repeat] uses the raw body, not re-serialised JSON", () => assert.equal(verify({ headers: h(), rawBody, secret, now }), true));\ntest("[core] wrong signature rejected", () => assert.equal(verify({ headers: h({ "x-sig-256": "00".repeat(32) }), rawBody, secret, now }), false));\ntest("[constraint] older than 300 s rejected", () => assert.equal(verify({ headers: h({ "x-sig-ts": String(now / 1000 - 301) }), rawBody, secret, now }), false));\ntest("[constraint] header names X-Sig-256 / X-Sig-Ts (case-insensitive)", () => assert.equal(verify({ headers: { "X-Sig-256": sig(rawBody), "X-Sig-Ts": String(now / 1000 - 5) }, rawBody, secret, now }), true));\n`,
        },
        solution: {
            "src/webhook.js": "import { createHmac, timingSafeEqual } from \"node:crypto\";\n\nexport function verify({ headers, rawBody, secret, now = Date.now() }) {\n  const get = (n) => { const k = Object.keys(headers).find((h) => h.toLowerCase() === n); return k ? String(headers[k]) : \"\"; };\n  const sig = get(\"x-sig-256\"), ts = Number(get(\"x-sig-ts\"));\n  if (!sig || !ts || now / 1000 - ts > 300) return false;\n  const want = createHmac(\"sha256\", secret).update(rawBody).digest(\"hex\");\n  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));\n}\n",
        },
        expectedChanges: [/^src\/webhook\.js$/, /^test\//, /^scripts\//, /^fixtures\//],
        keyFacts: [
            { name: "X-Sig-256 / X-Sig-Ts headers", re: /X-Sig-256/i },
            { name: "300 seconds", re: /300/ },
            { name: "raw body, not re-serialised", re: /raw body|raw bytes|JSON\.stringify/i },
        ],
    },
    {
        id: "R6",
        name: "continue a list after compaction",
        instruction: "continue where we left off",
        files: {
            "package.json": pkg("shop"),
            "src/customers.js": "export async function getCustomer(id) {\n  return { id, name: `Customer ${id}` };\n}\n",
            "src/utils.js": "export const formatMoney = (cents) => `$${(cents / 100).toFixed(2)}`;\nexport const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));\n",
            "src/orders.js": "export const listOrders = () => [{ id: 1, cents: 1250 }];\n",
            "src/app.js": "import { getCustomer } from \"./customers.js\";\nimport { formatMoney } from \"./utils.js\";\nimport { listOrders } from \"./orders.js\";\n\nexport async function summary(id) {\n  const c = await getCustomer(id);\n  return `${c.name}: ${listOrders().map((o) => formatMoney(o.cents)).join(\", \")}`;\n}\n",
            "test/app.test.js": `${T}import { summary } from "../src/app.js";\ntest("summary", async () => assert.equal(await summary(1), "Customer 1: $12.50"));\n`,
        },
        sessionChanges: {
            "src/orders.js": "export const fetchOrders = () => [{ id: 1, cents: 1250 }];\n",
            "src/app.js": "import { getCustomer } from \"./customers.js\";\nimport { formatMoney } from \"./utils.js\";\nimport { fetchOrders } from \"./orders.js\";\n\nexport async function summary(id) {\n  const c = await getCustomer(id);\n  return `${c.name}: ${fetchOrders().map((o) => formatMoney(o.cents)).join(\", \")}`;\n}\n",
        },
        before: (b, r) => b.user("cleanup list, one at a time: 1) rename listOrders to fetchOrders 2) rename getCustomer to fetchCustomer 3) move formatMoney from utils.js into a new src/money.js, update imports, no re-export from utils. keep the tests passing")
            .edit(`${r}/src/orders.js`)
            .edit(`${r}/src/app.js`)
            .bash("npm test", { stdout: "✔ summary\nℹ pass 1" })
            .say("Item 1 done: listOrders is now fetchOrders and app.js is updated; tests pass. Next is item 2."),
        summary: "Summary:\n1. Primary request: a cleanup list of renames/moves in src/.\n2. Done: renamed listOrders to fetchOrders (tests pass).\n3. Remaining: the rest of the list.",
        after: (b) => b.user("ok"),
        verifier: {
            "cleanup.test.js": `${T}import * as customers from "../src/customers.js";\nimport * as utils from "../src/utils.js";\nimport { summary } from "../src/app.js";\ntest("[constraint] fetchCustomer replaces getCustomer", () => { assert.equal(typeof customers.fetchCustomer, "function"); assert.equal(customers.getCustomer, undefined); });\ntest("[constraint] formatMoney moved to money.js, not re-exported", async () => { const m = await import("../src/money.js"); assert.equal(typeof m.formatMoney, "function"); assert.equal(utils.formatMoney, undefined); assert.equal(typeof utils.clamp, "function"); });\ntest("[core] app still works", async () => assert.equal(await summary(1), "Customer 1: $12.50"));\n`,
        },
        solution: {
            "src/customers.js": "export async function fetchCustomer(id) {\n  return { id, name: `Customer ${id}` };\n}\n",
            "src/utils.js": "export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));\n",
            "src/money.js": "export const formatMoney = (cents) => `$${(cents / 100).toFixed(2)}`;\n",
            "src/app.js": "import { fetchCustomer } from \"./customers.js\";\nimport { formatMoney } from \"./money.js\";\nimport { fetchOrders } from \"./orders.js\";\n\nexport async function summary(id) {\n  const c = await fetchCustomer(id);\n  return `${c.name}: ${fetchOrders().map((o) => formatMoney(o.cents)).join(\", \")}`;\n}\n",
        },
        expectedChanges: [/^src\/(customers|utils|money|app)\.js$/, /^test\//],
        keyFacts: [
            { name: "rename getCustomer → fetchCustomer", re: /fetchCustomer/ },
            { name: "move formatMoney to src/money.js, no re-export", re: /money\.js/ },
        ],
    },
];
export const HANDOFF_TASKS = [
    {
        id: "H1",
        name: "slugify with house rules",
        files: { "package.json": pkg("slug"), "src/slug.js": "export function slugify(title) {\n  return title; // TODO\n}\n", "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n` },
        agentAPrompt: "Implement slugify(title) in src/slug.js with these rules: (1) lowercase; (2) strip accents (é→e, ü→u); (3) any run of non-alphanumeric characters becomes a single '-', no leading/trailing '-'; (4) maximum 48 characters, cut at a '-' boundary when possible, never ending in '-'; (5) the reserved slugs 'new', 'edit' and 'admin' get the suffix '-page'. Do ONLY rules 1 and 2 now, with a test, then stop and tell me what's left. I'll pick the rest up later.",
        verifier: {
            "slug.test.js": `${T}import { slugify } from "../src/slug.js";\ntest("[core] lowercase + accents", () => assert.equal(slugify("Crème Brûlée"), "creme-brulee"));\ntest("[constraint] dash runs", () => assert.equal(slugify("  Hello,   World!! "), "hello-world"));\ntest("[constraint] max 48 at boundary", () => { const s = slugify("alpha beta gamma delta epsilon zeta eta theta iota kappa"); assert.ok(s.length <= 48 && !s.endsWith("-"), s); assert.equal(s, "alpha-beta-gamma-delta-epsilon-zeta-eta-theta"); });\ntest("[constraint] reserved words", () => { assert.equal(slugify("New"), "new-page"); assert.equal(slugify("ADMIN"), "admin-page"); assert.equal(slugify("news"), "news"); });\n`,
        },
        solution: {
            "src/slug.js": "const RESERVED = new Set([\"new\", \"edit\", \"admin\"]);\nexport function slugify(title) {\n  let s = title.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\").toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n  if (s.length > 48) { const cut = s.slice(0, 48); const i = cut.lastIndexOf(\"-\"); s = (i > 0 ? cut.slice(0, i) : cut).replace(/-+$/, \"\"); }\n  return RESERVED.has(s) ? `${s}-page` : s;\n}\n",
        },
        expectedChanges: [/^src\/slug\.js$/, /^test\//],
        keyFacts: [{ name: "48 chars", re: /48/ }, { name: "reserved new/edit/admin", re: /new.{0,15}edit.{0,15}admin/i }, { name: "-page suffix", re: /-page/ }],
    },
    {
        id: "H2",
        name: "config precedence",
        files: { "package.json": pkg("cfg"), "src/config.js": "// loadConfig({ file, env, argv }) -> config object\nexport function loadConfig({ file = {}, env = {}, argv = [] } = {}) {\n  return {}; // TODO\n}\n", "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n` },
        agentAPrompt: "Implement loadConfig({ file, env, argv }) in src/config.js. Keys: port (number, default 8080), host (string, default 'localhost'), debug (boolean, default false). Precedence: command-line flags (--port=N, --host=H, --debug) override environment variables, which override the file object, which overrides defaults. Environment variables use the prefix MYAPP_ (MYAPP_PORT, MYAPP_HOST, MYAPP_DEBUG where 'true'/'1' mean true). Numbers from env/argv must be coerced to numbers. Do ONLY defaults + file for now, then stop and tell me what's left.",
        verifier: {
            "config.test.js": `${T}import { loadConfig } from "../src/config.js";\ntest("[core] defaults", () => assert.deepEqual(loadConfig(), { port: 8080, host: "localhost", debug: false }));\ntest("[core] file overrides defaults", () => assert.equal(loadConfig({ file: { host: "a" } }).host, "a"));\ntest("[constraint] env prefix MYAPP_ and coercion", () => { const c = loadConfig({ file: { port: 1 }, env: { MYAPP_PORT: "9000", MYAPP_DEBUG: "1", PORT: "7" } }); assert.equal(c.port, 9000); assert.equal(c.debug, true); });\ntest("[constraint] argv overrides env", () => { const c = loadConfig({ env: { MYAPP_HOST: "e", MYAPP_PORT: "9000" }, argv: ["--host=cli", "--port=3000", "--debug"] }); assert.equal(c.host, "cli"); assert.equal(c.port, 3000); assert.equal(c.debug, true); });\n`,
        },
        solution: {
            "src/config.js": "const DEFAULTS = { port: 8080, host: \"localhost\", debug: false };\nexport function loadConfig({ file = {}, env = {}, argv = [] } = {}) {\n  const c = { ...DEFAULTS, ...file };\n  if (env.MYAPP_PORT !== undefined) c.port = Number(env.MYAPP_PORT);\n  if (env.MYAPP_HOST !== undefined) c.host = env.MYAPP_HOST;\n  if (env.MYAPP_DEBUG !== undefined) c.debug = env.MYAPP_DEBUG === \"true\" || env.MYAPP_DEBUG === \"1\";\n  for (const a of argv) {\n    const m = a.match(/^--(port|host|debug)(?:=(.*))?$/);\n    if (!m) continue;\n    if (m[1] === \"port\") c.port = Number(m[2]);\n    else if (m[1] === \"host\") c.host = m[2];\n    else c.debug = m[2] === undefined ? true : m[2] === \"true\" || m[2] === \"1\";\n  }\n  return c;\n}\n",
        },
        expectedChanges: [/^src\/config\.js$/, /^test\//],
        keyFacts: [{ name: "MYAPP_ prefix", re: /MYAPP_/ }, { name: "argv > env > file > defaults", re: /(command.line|argv|flags).{0,40}(env)/i }, { name: "--port=N style flags", re: /--port/ }],
    },
    {
        id: "H3",
        name: "paginated fetch",
        files: {
            "package.json": pkg("client"),
            "src/client.js": "// get(path, query) -> Promise<{ data: [], has_more: boolean, next_cursor?: string }>\nexport function createClient(get) {\n  return {\n    async fetchPage(cursor) {\n      return get(\"/items\", {}); // TODO\n    },\n    async fetchAll() {\n      return []; // TODO\n    },\n  };\n}\n",
            "test/placeholder.test.js": `${T}test("ok", () => assert.ok(true));\n`,
        },
        agentAPrompt: "In src/client.js implement fetchPage(cursor) and fetchAll(). The API takes query params `limit` (always 100) and `starting_after` (the cursor; omit it for the first page). Responses are { data, has_more, next_cursor }. fetchAll must follow next_cursor until has_more is false and must stop after 50 pages as a safety cap, returning what it has. Do ONLY fetchPage now, then stop and tell me what's left.",
        verifier: {
            "client.test.js": `${T}import { createClient } from "../src/client.js";\nconst api = (pages) => { const calls = []; return { calls, get: async (path, q) => { calls.push(q); const i = q.starting_after ? Number(q.starting_after) : 0; return { data: [i], has_more: i + 1 < pages, next_cursor: String(i + 1) }; } }; };\ntest("[core] fetchAll collects all pages", async () => { const a = api(3); assert.deepEqual(await createClient(a.get).fetchAll(), [0, 1, 2]); });\ntest("[constraint] limit 100 and starting_after param", async () => { const a = api(2); await createClient(a.get).fetchAll(); assert.equal(a.calls[0].limit, 100); assert.equal("starting_after" in a.calls[0] && a.calls[0].starting_after !== undefined, false); assert.equal(a.calls[1].starting_after, "1"); });\ntest("[constraint] 50-page safety cap", async () => { const a = api(1000); const r = await createClient(a.get).fetchAll(); assert.equal(a.calls.length, 50); assert.equal(r.length, 50); });\n`,
        },
        solution: {
            "src/client.js": "export function createClient(get) {\n  const c = {\n    async fetchPage(cursor) {\n      return get(\"/items\", cursor ? { limit: 100, starting_after: cursor } : { limit: 100 });\n    },\n    async fetchAll() {\n      const out = []; let cursor;\n      for (let i = 0; i < 50; i++) {\n        const p = await c.fetchPage(cursor);\n        out.push(...p.data);\n        if (!p.has_more) break;\n        cursor = p.next_cursor;\n      }\n      return out;\n    },\n  };\n  return c;\n}\n",
        },
        expectedChanges: [/^src\/client\.js$/, /^test\//],
        keyFacts: [{ name: "limit 100", re: /\b100\b/ }, { name: "starting_after", re: /starting_after/ }, { name: "50-page cap", re: /\b50\b/ }],
    },
];
const HEDGE = /(unknown|not (recorded|stated|established|known|specified|confirmed|clear)|unclear|unconfirmed|appears|seems|may|might|likely|probably|suggest|check|verify|confirm|whether|hypothes|reported|said|thought|believed|inferred)/i;
export { HEDGE as COMPACTION_HEDGE };
export const COMPACTION_CASES = [
    {
        id: "C1", kind: "explicit", instruction: "continue the import job",
        transcript: (b, r) => b.user("write the nightly import job in src/jobs/import.js. batches must be exactly 500 rows").write(`${r}/src/jobs/import.js`).compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: writing the nightly import job in src/jobs/import.js." } }))
            .user("ok continue"),
        fact: /\b500\b/, note: "batch size stated before compaction; the summary dropped it",
    },
    {
        id: "C2", kind: "explicit", instruction: "continue",
        transcript: (b, r) => b.user("add CSV export to reports. the header must be Name,Amount (USD),Date").read(`${r}/src/reports.js`).compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: adding a CSV export to reports." } }))
            .user("go on"),
        fact: /Name,Amount \(USD\),Date/, note: "exact header stated before compaction",
    },
    {
        id: "C3", kind: "explicit", instruction: "pick up where the last agent stopped",
        transcript: (b, r) => b.user("migrate the queue from polling to push").edit(`${r}/src/queue.js`).bash("npm test -- queue", { exit: 1, stdout: "FAIL queue.test.js > acks after processing\n  expected ack count 1, received 0" }).compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: migrating the queue to push; tests not passing yet." } })),
        fact: /acks? after processing|ack count|received 0/i, note: "the specific failing test lives only before compaction",
    },
    {
        id: "C4", kind: "implied", instruction: "continue the import job",
        transcript: (b, r) => b.user("write the nightly import job in src/jobs/import.js. use the same batch size as the nightly export job").read(`${r}/src/jobs/export.js`).compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: writing the import job." } }))
            .user("continue"),
        fact: /export/i, invented: /\b(100|250|500|1000|5000)\b/, note: "the value is only implied (same as export job); it must not be stated as a number",
    },
    {
        id: "C5", kind: "implied", instruction: "fix the flaky test",
        transcript: (b) => b.user("the report test is flaky").bash("npm test -- report", { exit: 1, stdout: "FAIL report.test.js > groups by day\n  expected 3 groups, received 4" }).say("This looks timezone-related: the test builds dates with local time. I haven't confirmed that yet.").compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: investigating a flaky report test." } })),
        fact: /timezone|time zone/i, note: "Claude's hypothesis; must be presented as unconfirmed",
    },
    {
        id: "C6", kind: "implied", instruction: "continue",
        transcript: (b) => b.user("bump the API version to v2 in the config").bash("sed -i '' 's/v1/v2/' src/config.ts").compact()
            .raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: bumping the API version." } })),
        fact: /config\.ts/, note: "the edit is inferred from a shell command; must be hedged",
    },
    {
        id: "C7", kind: "unavailable", instruction: "continue with the rate limit we agreed",
        transcript: (b, r) => b.raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: adding rate limiting to the login endpoint." } })).user("continue with the rate limit we agreed").read(`${r}/src/login.js`),
        fact: /rate limit/i, invented: /\b\d+\s*(attempts|requests|per|\/)|\b(5|7|10|100)\s*(per|\/|attempts)/i, note: "the agreed limit exists nowhere in the available data",
    },
    {
        id: "C8", kind: "unavailable", instruction: "finish the migration with the columns I listed",
        transcript: (b, r) => b.raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: writing a migration for the invoices table." } })).user("finish the migration with the columns I listed").write(`${r}/db/migrations/004_invoices.sql`),
        fact: /invoices/i, invented: /\b(amount|due_date|status|customer_id|total)\b\s+(numeric|integer|text|date|timestamp|varchar)/i, note: "the column list is not in the available data",
    },
    {
        id: "C9", kind: "unavailable", instruction: "use the naming convention we settled on",
        transcript: (b, r) => b.raw(JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "Summary: renaming React components." } })).user("use the naming convention we settled on").read(`${r}/src/components/Button.tsx`),
        fact: /convention/i, invented: /\b(PascalCase|camelCase|kebab-case|snake_case)\b(?![^.]{0,60}(unknown|not recorded|isn't|is not|unclear|check|confirm))/i, note: "the convention is not in the available data",
    },
];
