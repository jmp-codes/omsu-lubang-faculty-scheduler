// The Worker's entry point. This project deploys as a plain Cloudflare
// Worker with static assets (NOT Cloudflare Pages), so there is no
// file-based /functions routing — this fetch handler does the routing by
// hand: any /api/* request is matched against the table below and handed
// to the same handler functions the app used when it briefly targeted
// Pages Functions (each one still takes a {request, env} "context" object
// and returns a Response, so nothing about their logic changed — only how
// they get called did). Everything else falls through to the static
// assets binding, which serves the HTML/CSS/JS in /public.
import * as faculty from "./routes/faculty.js";
import * as subjects from "./routes/subjects.js";
import * as sections from "./routes/sections.js";
import * as syncPref from "./routes/sync-pref.js";
import * as facultyDirectory from "./routes/faculty-directory.js";
import * as sharedData from "./routes/shared-data.js";
import * as setup from "./routes/setup.js";
import * as login from "./routes/login.js";
import * as users from "./routes/users.js";
import { json } from "./lib/kv.js";

const ROUTES = [
  { method: "GET", path: "/api/faculty", fn: faculty.onRequestGet },
  { method: "PUT", path: "/api/faculty", fn: faculty.onRequestPut },
  { method: "GET", path: "/api/subjects", fn: subjects.onRequestGet },
  { method: "PUT", path: "/api/subjects", fn: subjects.onRequestPut },
  { method: "GET", path: "/api/sections", fn: sections.onRequestGet },
  { method: "PUT", path: "/api/sections", fn: sections.onRequestPut },
  { method: "GET", path: "/api/sync-pref", fn: syncPref.onRequestGet },
  { method: "PUT", path: "/api/sync-pref", fn: syncPref.onRequestPut },
  { method: "GET", path: "/api/faculty-directory", fn: facultyDirectory.onRequestGet },
  { method: "GET", path: "/api/shared-data", fn: sharedData.onRequestGet },
  { method: "PUT", path: "/api/shared-data", fn: sharedData.onRequestPut },
  { method: "POST", path: "/api/setup", fn: setup.onRequestPost },
  { method: "POST", path: "/api/login", fn: login.onRequestPost },
  { method: "GET", path: "/api/users", fn: users.onRequestGet },
  { method: "POST", path: "/api/users", fn: users.onRequestPost },
  { method: "DELETE", path: "/api/users", fn: users.onRequestDelete },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const route = ROUTES.find((r) => r.method === request.method && r.path === url.pathname);
      if (!route) return json(404, { error: "Not found." });
      try {
        return await route.fn({ request, env, ctx });
      } catch (err) {
        return json(500, { error: "Server error: " + (err && err.message ? err.message : String(err)) });
      }
    }

    // Not an API call — serve the static site (HTML/CSS/JS/images) from
    // the assets binding configured in wrangler.toml.
    return env.ASSETS.fetch(request);
  },
};
