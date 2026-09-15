// Shared helpers for every Netlify Function in this app.
// Lives in a subfolder so Netlify's function bundler does NOT treat this
// file itself as a callable function endpoint (only top-level files in
// netlify/functions/ become endpoints).

const { getStore } = require("@netlify/blobs");

const DEPARTMENTS = ["BSIT", "BSBA-OM", "BEEd"];

function store() {
  // Zero-config: Netlify injects the site ID + token automatically at
  // runtime when this function runs on Netlify's own infrastructure.
  return getStore("faculty-scheduler-data");
}

// Reads the Identity user Netlify attaches to the request context when the
// client sends `Authorization: Bearer <identity-jwt>`.
function getRequester(context) {
  const user = context.clientContext && context.clientContext.user;
  if (!user) return null;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const isRegistrar = roles.includes("registrar");
  const chairRole = roles.find((r) => r.startsWith("chair-"));
  const department = chairRole ? chairRole.slice("chair-".length) : null;
  if (!isRegistrar && !(department && DEPARTMENTS.includes(department))) {
    return { email: user.email, isRegistrar: false, department: null, authorized: false };
  }
  return { email: user.email, isRegistrar, department, authorized: true };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function unauthorized() {
  return json(401, { error: "You must be signed in." });
}

function forbidden(msg) {
  return json(403, { error: msg || "Not allowed for your account." });
}

module.exports = { DEPARTMENTS, store, getRequester, json, unauthorized, forbidden };
