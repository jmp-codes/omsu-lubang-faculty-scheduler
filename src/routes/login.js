// Replaces Netlify Identity's login call. Verifies email+password against
// the KV-stored account, then issues a signed JWT the client stores and
// sends back as `Authorization: Bearer <token>` on every other API call —
// see functions/_lib/auth.js for how that token is made and checked.
import { verifyPassword, signJWT, getJWTSecret } from "../lib/auth.js";
import { json } from "../lib/kv.js";

const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 14; // 14 days

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json(400, { error: "Invalid request body." });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || !password) return json(400, { error: "Email and password are required." });

    const raw = await env.FACULTY_KV.get(`user:${email}`, { type: "json" });
    if (!raw) return json(401, { error: "Incorrect email or password." });

    const ok = await verifyPassword(password, raw.passwordHash, raw.passwordSalt);
    if (!ok) return json(401, { error: "Incorrect email or password." });

    const isRegistrar = raw.role === "registrar";
    const department = raw.role && raw.role.startsWith("chair-") ? raw.role.slice("chair-".length) : null;

    const secret = await getJWTSecret(env);
    const token = await signJWT(
      { email: raw.email, isRegistrar, department },
      secret,
      TOKEN_LIFETIME_SECONDS
    );

    return json(200, { token, email: raw.email, isRegistrar, department });
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}
