// One-time bootstrap: creates the FIRST registrar account. Works only when
// zero accounts exist yet in KV — the moment any account exists, this
// endpoint refuses forever, so it can't be (ab)used to create a backdoor
// account later. Visit setup.html once to use this, then it's permanently
// dead — every account after the first one is created from the Users page
// by a signed-in registrar instead.
import { hashPassword } from "../lib/auth.js";
import { json } from "../lib/kv.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const kv = env.FACULTY_KV;

    const existing = await kv.list({ prefix: "user:", limit: 1 });
    if (existing.keys.length > 0) {
      return json(403, { error: "Setup has already been completed — an account already exists. Ask your registrar to create your account from the Users page instead." });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json(400, { error: "Invalid request body." });
    }
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    if (!email || !email.includes("@")) return json(400, { error: "A valid email is required." });
    if (password.length < 8) return json(400, { error: "Password must be at least 8 characters." });

    const { hash, salt } = await hashPassword(password);
    await kv.put(`user:${email}`, JSON.stringify({
      email, passwordHash: hash, passwordSalt: salt, role: "registrar",
    }));

    return json(200, { ok: true, message: "Registrar account created. You can now log in." });
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}
