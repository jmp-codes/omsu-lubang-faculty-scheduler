// Registrar-only account management — replaces Netlify Identity's
// dashboard (Users -> add a "registrar"/"chair-BSIT" role) now that there's
// no Netlify Identity. Used by the new Users page (users.html / js/users.js).
import { getRequester, hashPassword } from "../lib/auth.js";
import { json, unauthorized, forbidden, DEPARTMENTS } from "../lib/kv.js";

const VALID_ROLES = ["registrar", ...DEPARTMENTS.map((d) => `chair-${d}`)];

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.isRegistrar) return forbidden("Only the registrar can manage accounts.");

    const kv = env.FACULTY_KV;
    const list = await kv.list({ prefix: "user:" });
    const users = [];
    for (const k of list.keys) {
      const raw = await kv.get(k.name, { type: "json" });
      if (raw) users.push({ email: raw.email, role: raw.role });
    }
    users.sort((a, b) => a.email.localeCompare(b.email));
    return json(200, users);
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.isRegistrar) return forbidden("Only the registrar can manage accounts.");

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json(400, { error: "Invalid request body." });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const role = body.role || "";
    if (!email || !email.includes("@")) return json(400, { error: "A valid email is required." });
    if (password.length < 8) return json(400, { error: "Password must be at least 8 characters." });
    if (!VALID_ROLES.includes(role)) return json(400, { error: "Role must be registrar or chair-<department>." });

    const kv = env.FACULTY_KV;
    const { hash, salt } = await hashPassword(password);
    await kv.put(`user:${email}`, JSON.stringify({ email, passwordHash: hash, passwordSalt: salt, role }));

    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.isRegistrar) return forbidden("Only the registrar can manage accounts.");

    const url = new URL(request.url);
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    if (!email) return json(400, { error: "Missing ?email=" });
    if (email === requester.email) return json(400, { error: "You can't delete your own account while signed in as it." });

    await env.FACULTY_KV.delete(`user:${email}`);
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}
