// Self-contained auth for the Cloudflare rebuild: password hashing
// (PBKDF2 via the Workers runtime's built-in Web Crypto) + signed JWTs
// (HMAC-SHA256), replacing Netlify Identity now that this app no longer
// runs on Netlify at all. Everything here uses only crypto.subtle, which
// is built into the Workers runtime — Pages Functions can't npm-install a
// JWT or bcrypt library, so this is written from scratch on purpose rather
// than missing a dependency.

const PBKDF2_ITERATIONS = 100000;

function b64urlEncode(bytes) {
  const str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Each password gets its own random salt, hashed with PBKDF2-SHA256 at
// 100,000 iterations (OWASP's current baseline recommendation for PBKDF2).
// Returns base64url-encoded strings so they drop straight into KV as JSON.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return { hash: b64urlEncode(bits), salt: b64urlEncode(salt) };
}

export async function verifyPassword(password, hash, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64urlDecode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return b64urlEncode(bits) === hash;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

// A minimal hand-rolled JWT (header.payload.signature, HMAC-SHA256) — this
// app only ever needs to issue and verify its own tokens, never interpret
// a token from anyone else, so a full JWT library would be overkill.
export async function signJWT(payload, secret, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + expiresInSeconds });
  const encHeader = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encBody = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const data = `${encHeader}.${encBody}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJWT(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encBody, encSig] = parts;
  const data = `${encHeader}.${encBody}`;
  const key = await hmacKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(encSig), new TextEncoder().encode(data));
  } catch (e) {
    return null;
  }
  if (!valid) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(encBody)));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// The secret that signs/verifies every login token. Rather than making you
// manually generate a random string and paste it into a Cloudflare
// environment variable, this generates one itself the first time it's
// needed and stores it in the same KV namespace as everything else, under
// a key (`_system:jwt_secret`) that never shows up in the Users list (that
// only lists `user:*` keys). An env var named JWT_SECRET still works as a
// manual override if you ever set one, but nothing requires it anymore.
async function getJWTSecret(env) {
  const existing = await env.FACULTY_KV.get("_system:jwt_secret");
  if (existing) return existing;
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = b64urlEncode(bytes);
  await env.FACULTY_KV.put("_system:jwt_secret", secret);
  return secret;
}
export { getJWTSecret };

// Reads + verifies the `Authorization: Bearer <jwt>` header and returns the
// same {email, isRegistrar, department, authorized} shape the old Netlify
// getRequester() did — so every endpoint that used it barely had to change.
export async function getRequester(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return null;
  const secret = await getJWTSecret(env);
  const payload = await verifyJWT(token, secret);
  if (!payload) return null;
  return {
    email: payload.email,
    isRegistrar: !!payload.isRegistrar,
    department: payload.department || null,
    authorized: !!(payload.isRegistrar || payload.department),
  };
}
