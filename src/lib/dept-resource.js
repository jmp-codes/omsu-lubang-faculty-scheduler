// Factory for a department-scoped resource endpoint (faculty / subjects /
// sections / syncPref) — the Cloudflare Pages Functions port of the old
// netlify/functions/lib/dept-resource.js. Same behavior, same rules:
//
// GET  -> registrar gets every department's data merged into one array/object
//         (?scope=all), or one department's data (?department=...); a chair
//         always gets only their own department's data UNLESS they also
//         pass ?scope=all, which (like the registrar) returns the
//         read-only merged view across every department — Rooms, Assign
//         Instructors, and Generate Schedule are shared pages a chair can
//         also use now, and the scheduling engine needs to see every
//         department's sections/subjects/faculty at once or it would wipe
//         out every other department's already-placed schedule blocks.
// PUT  -> body is the full replacement value for ONE department. A chair
//         may only replace their own department (forced from their login,
//         ignoring anything in the request); the registrar must pass
//         ?department=BSIT|BSBA-OM|BEEd to say which one they're replacing.
import { getRequester } from "./auth.js";
import { json, unauthorized, forbidden, getJSON, putJSON, keyFor, DEPARTMENTS } from "./kv.js";

export function makeDeptResource(resource, { shape = "array" } = {}) {
  const empty = shape === "array" ? [] : {};

  async function onRequestGet(context) {
    const { request, env } = context;
    try {
      const requester = await getRequester(request, env);
      if (!requester) return unauthorized();
      if (!requester.authorized) {
        return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role on the Users page.");
      }

      const kv = env.FACULTY_KV;
      const url = new URL(request.url);
      const scope = url.searchParams.get("scope");

      // scope=all is a READ-ONLY aggregate across every department,
      // available to ANY authorized account (registrar or chair) — see the
      // note above.
      if (scope === "all") {
        if (shape === "array") {
          const all = [];
          for (const dept of DEPARTMENTS) {
            const raw = await getJSON(kv, keyFor(resource, dept), []);
            if (Array.isArray(raw)) all.push(...raw);
          }
          return json(200, all);
        }
        const merged = {};
        for (const dept of DEPARTMENTS) {
          const raw = await getJSON(kv, keyFor(resource, dept), {});
          if (raw && typeof raw === "object") Object.assign(merged, raw);
        }
        return json(200, merged);
      }

      if (requester.isRegistrar) {
        const dept = url.searchParams.get("department");
        if (!dept || !DEPARTMENTS.includes(dept)) {
          return json(400, { error: "Registrar reads must include ?department=BSIT|BSBA-OM|BEEd or ?scope=all" });
        }
        const raw = await getJSON(kv, keyFor(resource, dept), empty);
        return json(200, raw);
      }

      const raw = await getJSON(kv, keyFor(resource, requester.department), empty);
      return json(200, raw);
    } catch (err) {
      return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
    }
  }

  async function onRequestPut(context) {
    const { request, env } = context;
    try {
      const requester = await getRequester(request, env);
      if (!requester) return unauthorized();
      if (!requester.authorized) {
        return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role on the Users page.");
      }

      let targetDept = requester.department;
      const url = new URL(request.url);
      if (requester.isRegistrar) {
        targetDept = url.searchParams.get("department");
        if (!targetDept || !DEPARTMENTS.includes(targetDept)) {
          return json(400, { error: "Registrar writes must include ?department=BSIT|BSBA-OM|BEEd" });
        }
      }
      if (!targetDept) return forbidden("No department to write to.");

      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json(400, { error: shape === "array" ? "Body must be a JSON array." : "Body must be a JSON object." });
      }

      const kv = env.FACULTY_KV;
      if (shape === "array") {
        if (!Array.isArray(payload)) return json(400, { error: "Body must be a JSON array." });
        // Force every record's department to match the target, so a chair
        // can never smuggle a record into another department.
        const tagged = payload.map((rec) => Object.assign({}, rec, { department: targetDept }));
        await putJSON(kv, keyFor(resource, targetDept), tagged);
        return json(200, { ok: true, count: tagged.length });
      }

      if (typeof payload !== "object" || Array.isArray(payload) || payload === null) {
        return json(400, { error: "Body must be a JSON object." });
      }
      await putJSON(kv, keyFor(resource, targetDept), payload);
      return json(200, { ok: true });
    } catch (err) {
      return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
    }
  }

  return { onRequestGet, onRequestPut };
}
