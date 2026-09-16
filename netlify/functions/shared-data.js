// Registrar-only bundle: rooms, instructor assignments, the generated
// schedule, year-level time preferences, and the one-level undo backup.
// Kept as a single JSON blob since the client already treats these as one
// unit (it saves/loads them together, same as the old localStorage state).
const { store, getRequester, json, unauthorized, forbidden } = require("./lib/blob-helpers");

const KEY = "shared-data";
// NOTE: syncPref is intentionally NOT part of this bundle — it's
// department-scoped and served by /api/sync-pref instead, since it's set
// from the (chair-editable) Sections page, not the registrar's pages.
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

exports.handler = async function handler(event, context) {
  // See dept-resource.js for why this wrapper exists: without it, any
  // unexpected error crashes the function and the client just sees a bare
  // 502 with no useful information.
  try {
    return await run(event, context);
  } catch (err) {
    console.error("[shared-data] handler crashed:", err);
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
};

async function run(event, context) {
  const requester = getRequester(context);
  if (!requester) return unauthorized();
  if (!requester.isRegistrar) return forbidden("Only the registrar account can view or change Rooms, Assign Instructors, or the generated Schedule.");

  const st = store();

  if (event.httpMethod === "GET") {
    const raw = await st.get(KEY, { type: "json" });
    return json(200, raw && typeof raw === "object" ? { ...DEFAULT_SHARED, ...raw } : DEFAULT_SHARED);
  }

  if (event.httpMethod === "PUT") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Body must be a JSON object." });
    }
    const merged = { ...DEFAULT_SHARED, ...payload };
    await st.setJSON(KEY, merged);
    return json(200, { ok: true });
  }

  return json(405, { error: "Method not allowed" });
};
