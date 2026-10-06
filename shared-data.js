// Registrar-only bundle: rooms, instructor assignments, the generated
// schedule, year-level time preferences, and the one-level undo backup.
// Kept as a single JSON blob since the client already treats these as one
// unit. (syncPref is intentionally NOT part of this bundle — it's
// department-scoped and served by /api/sync-pref instead, since it's set
// from the chair-editable Sections page, not the registrar's pages.)
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
    if (!requester.isRegistrar) {
      return forbidden("Only the registrar account can view or change Rooms, Assign Instructors, or the generated Schedule.");
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
    if (!requester.isRegistrar) {
      return forbidden("Only the registrar account can view or change Rooms, Assign Instructors, or the generated Schedule.");
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
