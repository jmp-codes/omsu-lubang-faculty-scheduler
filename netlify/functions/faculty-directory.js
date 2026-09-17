// Read-only, lightweight directory of every faculty member's name +
// department, merged across ALL departments — visible to ANY authorized
// user (a chair as well as the registrar), unlike the normal
// department-scoped /api/faculty endpoint.
//
// Why this exists: faculty are stored one list per department
// (faculty:<dept> in the blob store — see dept-resource.js), so there's no
// built-in notion of "the same person, entered under two departments."
// The Faculty page (js/faculty.js) uses this directory purely to warn
// "someone with this name already exists in <other dept>" before a
// chair/registrar accidentally creates a second record for a person who
// already teaches elsewhere — two records means two different faculty IDs,
// and the schedule's conflict-checking (which matches on faculty ID) has
// no way to know they're the same human and won't catch a double-booking
// between them.
//
// Deliberately returns only {id, name, department} — never rank,
// qualifications, designations, or externalBusy — so a chair browsing
// this never actually sees another department's real faculty data, just
// enough to catch a likely duplicate name.
const { DEPARTMENTS, store, getRequester, json, unauthorized, forbidden } = require("./lib/blob-helpers");

exports.handler = async function handler(event, context) {
  try {
    return await run(event, context);
  } catch (err) {
    console.error("[faculty-directory] handler crashed:", err);
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
};

async function run(event, context) {
  const requester = getRequester(context);
  if (!requester) return unauthorized();
  if (!requester.authorized) return forbidden("Your account isn't tagged with a department or the registrar role yet.");
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const st = store();
  const directory = [];
  for (const dept of DEPARTMENTS) {
    const raw = await st.get(`faculty:${dept}`, { type: "json" });
    if (Array.isArray(raw)) {
      raw.forEach((f) => {
        if (f && f.id && f.name) directory.push({ id: f.id, name: f.name, department: dept });
      });
    }
  }
  return json(200, directory);
}
