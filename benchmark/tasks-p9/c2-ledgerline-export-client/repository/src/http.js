export function buildUrl(base, path, query = {}) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/');
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

export async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
