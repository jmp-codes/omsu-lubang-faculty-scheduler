// Shared helpers for every Netlify Function in this app.
// Lives in a subfolder so Netlify's function bundler does NOT treat this
// file itself as a callable function endpoint (only top-level files in
// netlify/functions/ become endpoints).

const { getStore } = require("@netlify/blobs");

const DEPARTMENTS = ["BSIT", "BSBA-OM", "BEEd"];

function store() {
  // Zero-config Blobs (Netlify auto-injecting the site ID + token at
  // runtime) isn't resolving on this site for some platform-specific
  // reason, even though everything else about the deploy is correct — it
  // throws "The environment has not been configured to use Netlify Blobs."
  // Netlify's own fallback for that is to supply siteID + token manually.
  // The site ID isn't secret, but the token is, so it comes from an
  // environment variable (Site settings -> Environment variables ->
  // BLOBS_TOKEN) rather than being committed here.
  const token = process.env.BLOBS_TOKEN;
  if (token) {
    return getStore({ name: "faculty-scheduler-data", siteID: "848b5e5f-1487-465f-ae5c-14d5fd36f04b", token });
  }
  // Falls back to zero-config in case Netlify's auto-detection starts
  // working on its own (e.g. after a future platform fix) before
  // BLOBS_TOKEN is set.
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
