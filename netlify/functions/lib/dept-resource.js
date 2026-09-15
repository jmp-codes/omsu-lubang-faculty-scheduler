// Factory for a department-scoped resource endpoint (faculty / subjects /
// sections / syncPref).
// GET  -> registrar gets every department's data merged into one array/object;
//         a chair gets only their own department's data.
// PUT  -> body is the full replacement value for ONE department.
//         a chair may only replace their own department (department is forced
//         from their login, ignoring anything in the request); the registrar
//         must pass ?department=BSIT|BSBA-OM|BEEd to say which one they're replacing.
const { DEPARTMENTS, store, getRequester, json, unauthorized, forbidden } = require("./blob-helpers");

function keyFor(resource, dept) {
  return `${resource}:${dept}`;
}

function makeHandler(resource, { shape = "array" } = {}) {
  const empty = shape === "array" ? [] : {};

  return async function handler(event, context) {
    const requester = getRequester(context);
    if (!requester) return unauthorized();
    if (!requester.authorized) return forbidden("Your account isn't tagged with a department or the registrar role yet. Ask the registrar to fix your account's role in Netlify Identity.");

    const st = store();

    if (event.httpMethod === "GET") {
      const scope = event.queryStringParameters && event.queryStringParameters.scope;

      if (requester.isRegistrar) {
        // ?scope=all -> read-only merge across every department (for the
        // Assign Instructors / Generate Schedule / Home pages).
        if (scope === "all") {
          if (shape === "array") {
            const all = [];
            for (const dept of DEPARTMENTS) {
              const raw = await st.get(keyFor(resource, dept), { type: "json" });
              if (Array.isArray(raw)) all.push(...raw);
            }
            return json(200, all);
          }
          const merged = {};
          for (const dept of DEPARTMENTS) {
            const raw = await st.get(keyFor(resource, dept), { type: "json" });
            if (raw && typeof raw === "object") Object.assign(merged, raw);
          }
          return json(200, merged);
        }
        // Otherwise the registrar must say which single department they're
        // viewing/editing (the Faculty/Subjects/Sections pages' department
        // selector) — never silently fall back to "all", or a save right
        // after would overwrite every department with just this one.
        const dept = event.queryStringParameters && event.queryStringParameters.department;
        if (!dept || !DEPARTMENTS.includes(dept)) {
          return json(400, { error: "Registrar reads must include ?department=BSIT|BSBA-OM|BEEd or ?scope=all" });
        }
        const raw = await st.get(keyFor(resource, dept), { type: "json" });
        return json(200, (shape === "array" ? Array.isArray(raw) : raw && typeof raw === "object") ? raw : empty);
      }

      // Chair: always their own department, regardless of any query params.
      const raw = await st.get(keyFor(resource, requester.department), { type: "json" });
      return json(200, (shape === "array" ? Array.isArray(raw) : raw && typeof raw === "object") ? raw : empty);
    }

    if (event.httpMethod === "PUT") {
      let targetDept = requester.department;
      if (requester.isRegistrar) {
        targetDept = (event.queryStringParameters && event.queryStringParameters.department) || null;
        if (!targetDept || !DEPARTMENTS.includes(targetDept)) {
          return json(400, { error: "Registrar writes must include ?department=BSIT|BSBA-OM|BEEd" });
        }
      }
      if (!targetDept) return forbidden("No department to write to.");

      let payload;
      try {
        payload = JSON.parse(event.body || (shape === "array" ? "[]" : "{}"));
      } catch (e) {
        return json(400, { error: shape === "array" ? "Body must be a JSON array." : "Body must be a JSON object." });
      }

      if (shape === "array") {
        if (!Array.isArray(payload)) return json(400, { error: "Body must be a JSON array." });
        // Force every record's department to match the target, so a chair
        // can never smuggle a record into another department.
        const tagged = payload.map((rec) => ({ ...rec, department: targetDept }));
        await st.setJSON(keyFor(resource, targetDept), tagged);
        return json(200, { ok: true, count: tagged.length });
      }

      if (typeof payload !== "object" || Array.isArray(payload) || payload === null) {
        return json(400, { error: "Body must be a JSON object." });
      }
      await st.setJSON(keyFor(resource, targetDept), payload);
      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  };
}

module.exports = { makeHandler };
