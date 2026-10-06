// Shared bundle: rooms, instructor assignments, the generated schedule,
// year-level time preferences, and the one-level undo backup. Available to
// BOTH the registrar and every department chair (Program Chair) — Rooms,
// Assign Instructors, and Generate Schedule are shared pages either role
// can use; only account management (Users) stays registrar-only. Kept as
// a single JSON blob since the client already treats these as one unit.
// (syncPref is intentionally NOT part of this bundle — it's
// department-scoped and served by /api/sync-pref instead, since it's set
// from the chair-editable Sections page, not these shared pages.)
import { getRequester } from "../lib/auth.js";
import { json, unauthorized, forbidden } from "../lib/kv.js";

const KEY = "shared-data";
const DEFAULT_SHARED = {
  rooms: [],
  assignments: {},
  yearPref: {},
  schedule: [],
  manualRemoved: {},
  previousSchedule: [],
  previousManualRemoved: {},
  hasScheduleBackup: false,
};

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.authorized) {
      return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role on the Users page.");
    }
    const raw = await env.FACULTY_KV.get(KEY, { type: "json" });
    return json(200, raw && typeof raw === "object" ? Object.assign({}, DEFAULT_SHARED, raw) : DEFAULT_SHARED);
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.authorized) {
      return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role on the Users page.");
    }
    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json(400, { error: "Body must be a JSON object." });
    }
    const merged = Object.assign({}, DEFAULT_SHARED, payload);
    await env.FACULTY_KV.put(KEY, JSON.stringify(merged));
    return json(200, { ok: true });
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}
