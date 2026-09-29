/**
 * Last-line secret redaction before anything reaches the model. Deliberately small:
 * common key/token formats, credential assignments, auth headers, private keys and
 * credentials in URLs. Matches are replaced with a visible marker, never silently removed.
 */
export const REDACTED = "[REDACTED_SECRET]";
const PATTERNS = [
    { kind: "private_key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replace: () => REDACTED },
    { kind: "authorization_header", re: /\b(authorization\s*[:=]\s*["']?)((?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, pre = "", scheme = "") => `${pre}${scheme}${REDACTED}` },
    { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, replace: () => REDACTED },
    { kind: "openai_style_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: () => REDACTED },
    { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => REDACTED },
    { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: () => REDACTED },
    { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => REDACTED },
    { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTED },
    { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => REDACTED },
    { kind: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: () => REDACTED },
    { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => REDACTED },
    { kind: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi, replace: (_m, a = "", _p = "", c = "") => `${a}${REDACTED}${c}` },
    {
        kind: "credential_assignment",
        re: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s"'`,;]{4,})\2/gi,
        replace: (m, pre = "", q = "", value = "") => (value === REDACTED || /^(\$|process\.env|os\.environ|<|\{\{|\*+$|true|false|null|undefined|none)/i.test(value) ? m : `${pre}${q}${REDACTED}${q}`),
    },
];
export function redactSecrets(text) {
    let out = text;
    let count = 0;
    const kinds = new Set();
    for (const p of PATTERNS) {
        out = out.replace(p.re, (...args) => {
            const m = args[0];
            const groups = args.slice(1, -2);
            const r = p.replace(m, ...groups);
            if (r !== m) {
                count++;
                kinds.add(p.kind);
            }
            return r;
        });
    }
    return { text: out, count, kinds: [...kinds] };
}
