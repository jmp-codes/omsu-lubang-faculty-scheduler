// Shared helpers for every Cloudflare Pages Function in this app.
// Lives under _lib (an underscore-prefixed folder) so Cloudflare Pages does
// NOT treat this file as a routable endpoint — only files directly under
// functions/api/ (and not starting with _) become /api/... routes.

export const DEPARTMENTS = ["BSIT", "BSBA-OM", "BEEd"];

export function keyFor(resource, dept) {
  return `${resource}:${dept}`;
}

export async function getJSON(kv, key, fallback) {
  const raw = await kv.get(key, { type: "json" });
  return raw == null ? fallback : raw;
}

export async function putJSON(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function unauthorized() {
  return json(401, { error: "You must be signed in." });
}

export function forbidden(msg) {
  return json(403, { error: msg || "Not allowed for your account." });
}
