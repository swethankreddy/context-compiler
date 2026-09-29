/**
 * Runs the selection evaluation set and prints a table.
 * Usage: npm run eval:selection   (add --verbose for per-case bundles)
 */
import { pathToFileURL } from "node:url";
import { buildContextBundle } from "../selection/pipeline.js";
import { renderBundle } from "../selection/render.js";
import { evaluateCase, SELECTION_CASES } from "./selection-cases.js";
export async function runSelectionEval(verbose = false) {
    const results = [];
    for (const c of SELECTION_CASES) {
        const bundle = buildContextBundle(await c.snapshot(), c.instruction);
        const r = evaluateCase(c, bundle);
        results.push(r);
        if (verbose)
            console.log(`\n### ${c.name}\n${renderBundle(bundle)}`);
    }
    return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const results = await runSelectionEval(process.argv.includes("--verbose"));
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\n${pad("case", 44)}${pad("result", 8)}${pad("required", 10)}${pad("sel/disc", 10)}tokens`);
    for (const r of results) {
        console.log(`${pad(r.name, 44)}${pad(r.pass ? "PASS" : "FAIL", 8)}${pad(`${r.requiredHit}/${r.requiredTotal}`, 10)}${pad(`${r.selected}/${r.discovered}`, 10)}${r.tokens}/${r.maxTokens}`);
        for (const e of r.errors)
            console.log(`    ✗ ${e}`);
    }
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} cases passed`);
    process.exitCode = passed === results.length ? 0 : 1;
}
