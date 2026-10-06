// Read-only, lightweight directory of every faculty member's name +
// department, merged across ALL departments — visible to ANY authorized
// user (a chair as well as the registrar), unlike /api/faculty which is
// department-scoped. Used purely to warn "someone with this name already
// exists in <other dept>" before a chair/registrar accidentally creates a
// second record for a person who already teaches elsewhere.
import { getRequester } from "../lib/auth.js";
import { json, unauthorized, forbidden, DEPARTMENTS } from "../lib/kv.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const requester = await getRequester(request, env);
    if (!requester) return unauthorized();
    if (!requester.authorized) {
      return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role on the Users page.");
    }

    const kv = env.FACULTY_KV;
    const directory = [];
    for (const dept of DEPARTMENTS) {
      const raw = await kv.get(`faculty:${dept}`, { type: "json" });
      if (Array.isArray(raw)) {
        raw.forEach((f) => {
          if (f && f.id && f.name) directory.push({ id: f.id, name: f.name, department: dept });
        });
      }
    }
    return json(200, directory);
  } catch (err) {
    return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
  }
}
