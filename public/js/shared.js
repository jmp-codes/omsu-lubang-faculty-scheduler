/* ============================================================
   SHARED MODULE — auth/session, state, utilities, scheduling engine,
   API access, and the header/nav "chrome" injected into every page.
   Imported by every page-specific script (faculty.js, subjects.js, …).
   ============================================================ */

/* ============================= CONSTANTS ============================= */
export const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat"];
export const DAY_NAMES = {Mon:"Monday",Tue:"Tuesday",Wed:"Wednesday",Thu:"Thursday",Fri:"Friday",Sat:"Saturday"};
export const DAY_START = 7.5;  // 7:30 AM — the earliest any class may ever start
export const DAY_END   = 20.5; // 8:30 PM — no class may run past this
export const TIME_STEP = 0.5;  // granularity of schedulable start times (30 min)
export const LUNCH_START = 12;   // 12:00 NN
export const LUNCH_END   = 13;   // 1:00 PM — no class may occupy any part of this window

// True if a block running [start, start+duration) would occupy any part of
// the lunch break — used as a hard rule (unlike the other scheduling
// preferences in this file, there's no fallback that ignores this one).
export function spansLunch(start, duration){
  return start < LUNCH_END && start+duration > LUNCH_START;
}
export const YEAR_LABELS = {1:"1st Year",2:"2nd Year",3:"3rd Year",4:"4th Year",5:"5th Year"};
export const DEPARTMENTS = ["BSIT","BSBA-OM","BEEd"];

export function uid(prefix){ return prefix + "_" + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }

// Fisher-Yates shuffle, used only to randomize TIES when "Try a different
// valid arrangement" is checked on the Generate Schedule page — see
// randomizePass below. Never mutates its input.
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// True for the duration of one generateSchedule() call when its caller
// asked to randomize ties (see generateSchedule's randomize argument
// below) — false the rest of the time, including during drag-and-drop
// reschedule and manual placement, which must stay fully deterministic.
// daysByLoad/roomCandidatesFor/placeOnDayPair all read this flag to decide
// whether to shuffle before their stable sort; every hard rule they
// enforce (capacity, department ownership, conflicts, the break limit,
// lunch) is completely unaffected by it — this only changes which of
// several EQUALLY VALID candidates gets tried first.
let randomizePass = false;

export function defaultState(){
  return {
    faculty: [],     // {id,name,rank,qualifications:[],designations:[],externalBusy:[{id,day,start,duration,label}],department}
    subjects: [],    // {id,code,name,year,units,type,lecHours,labHours,department,semester,curriculum,archived,preferSaturday,oneMeeting}
    rooms: [],       // {id,name,type,capacity,homeSectionIds:[],department} — department is null/undefined for a Shared/Any-Department room (visible & usable by everyone, editable only by the registrar), or one of DEPARTMENTS for a department-owned room (visible to everyone for coordination, but only editable by that department's chair or the registrar); homeSectionIds only meaningful for type==='lecture'
    sections: [],    // {id,name,year,studentCount,subjectIds:[],department}
    assignments: {}, // `${sectionId}::${subjectId}` -> facultyId — shared/registrar-owned
    syncPref: {},    // `${year}::${subjectId}` -> true/false — department-owned
    yearPref: {},    // year -> 'morning'|'afternoon'|'none' — shared/registrar-owned
    schedule: [],    // placed blocks — shared/registrar-owned
    manualRemoved: {}, // blockId -> true — shared/registrar-owned
    previousSchedule: [],      // one-level undo backup — shared/registrar-owned
    previousManualRemoved: {},
    hasScheduleBackup: false,
    // One-level undo backup, scoped per department — { [department]: {
    // schedule: Block[], manualRemovedKeys: string[] } }. A chair's own
    // Generate/Clear/Revert only ever reads/writes their own entry here, so
    // it can never touch another department's already-placed schedule, and
    // two chairs acting back-to-back never clobber each other's undo. The
    // registrar's previousSchedule/previousManualRemoved/hasScheduleBackup
    // above stay a single whole-campus snapshot, unchanged, for their own
    // whole-schedule actions. See backupSchedule/revertSchedule/
    // generateSchedule/clearSchedule below.
    deptScheduleBackups: {}
  };
}

export let state = defaultState();

/* ============================= SESSION / AUTH =============================
   This app used to use Netlify Identity for login. Since it now runs on
   Cloudflare (which has no Netlify Identity service to talk to), this is a
   self-contained replacement: the server (functions/api/login.js) checks an
   email+password against Workers KV and hands back a signed token; this
   file stores that token in localStorage, decodes it just enough to drive
   the UI, and attaches it to every API call. The server independently
   re-verifies the token's signature on every single request — the
   client-side decode below is only ever used for display/UX, never trusted
   as a security boundary. */
export let session = { token: null, email: null, isRegistrar: false, department: null, manageDept: null };

const TOKEN_KEY = 'fs_token';
function loadToken(){
  try{ return localStorage.getItem(TOKEN_KEY); }catch(e){ return null; }
}
function saveToken(token){
  try{ localStorage.setItem(TOKEN_KEY, token); }catch(e){}
}
function clearToken(){
  try{ localStorage.removeItem(TOKEN_KEY); }catch(e){}
}

// Decodes a JWT's payload WITHOUT verifying its signature — fine here
// because this is only ever used to read back the claims this same app's
// server just issued, purely for display and a quick client-side expiry
// check. Every real authorization decision happens server-side, where the
// signature is re-checked on every request (see functions/_lib/auth.js).
function decodeJWTPayload(token){
  try{
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g,'+').replace(/_/g,'/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  }catch(e){
    return null;
  }
}

// This is a classic multi-page app — every nav click is a full page load,
// so the `session` object above gets rebuilt from nothing on every single
// page. Without saving the registrar's chosen department SOMEWHERE that
// survives that reload, bootSession() below has no way to know they'd
// picked BEEd a moment ago on the previous page, and always falls back to
// DEPARTMENTS[0] — which looked like "switching to BEEd keeps snapping
// back to BSIT every time I change tabs." sessionStorage (cleared when the
// tab closes, unlike localStorage) is the right place for this: it's a
// per-tab "what was I looking at" convenience, not real data, so it's fine
// if a private/locked-down browser blocks it — this just falls back to the
// old default-to-BSIT behavior in that case rather than breaking the page.
const MANAGE_DEPT_KEY = 'fs_manageDept';
function loadSavedManageDept(){
  try{ return sessionStorage.getItem(MANAGE_DEPT_KEY); }catch(e){ return null; }
}
function saveManageDept(dept){
  try{ sessionStorage.setItem(MANAGE_DEPT_KEY, dept); }catch(e){}
}

// Renders a simple centered email/password form in place of the whole page
// and resolves once /api/login succeeds — modeled on the old Netlify
// "please sign in" overlay, just backed by our own endpoint instead of a
// third-party widget. A full page reload after a successful login is the
// simplest way to get bootSession() to re-run and pick up the new token,
// consistent with this app already being a classic multi-page (not SPA) site.
function renderLoginForm(){
  document.body.innerHTML = `
    <div style="min-height:100vh; display:flex; align-items:center; justify-content:center;">
      <form id="loginForm" class="card" style="width:100%; max-width:360px; padding:28px;">
        <h2 style="margin-top:0;">Log In</h2>
        <div id="loginError" class="warn-box" style="display:none; margin-bottom:12px;"></div>
        <label class="muted" style="font-size:12px;">Email</label>
        <input type="email" id="loginEmail" required autocomplete="username" style="width:100%; margin:4px 0 14px;">
        <label class="muted" style="font-size:12px;">Password</label>
        <input type="password" id="loginPassword" required autocomplete="current-password" style="width:100%; margin:4px 0 18px;">
        <button type="submit" class="btn btn-teal" style="width:100%;" id="loginSubmitBtn">Log In</button>
      </form>
    </div>
  `;
  document.getElementById('loginForm').addEventListener('submit', async function(e){
    e.preventDefault();
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginSubmitBtn');
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Logging in…';
    try{
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value.trim(),
          password: document.getElementById('loginPassword').value
        })
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){
        throw new Error(data.error || 'Login failed.');
      }
      saveToken(data.token);
      location.reload();
    }catch(err){
      errEl.textContent = err.message || 'Login failed.';
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Log In';
    }
  });
}

export async function apiFetch(path, opts={}){
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(session.token) headers['Authorization'] = 'Bearer ' + session.token;
  const res = await fetch(path, Object.assign({}, opts, {headers}));
  if(res.status === 401){
    // The token is missing/invalid/expired as far as the server's
    // concerned — clear it and reload straight into the login form rather
    // than leaving the page in a half-broken state.
    clearToken();
    location.reload();
    throw new Error('Your session expired — please log in again.');
  }
  if(!res.ok){
    let msg = 'Request failed ('+res.status+')';
    try{ const j = await res.json(); if(j.error) msg = j.error; }catch(e){}
    throw new Error(msg);
  }
  if(res.status === 204) return null;
  return res.json();
}

function deptQS(){
  return session.isRegistrar ? ('?department='+encodeURIComponent(session.manageDept)) : '';
}

// "Edit" loaders: for a chair this is always their own department; for the
// registrar it's whichever single department is selected in the Faculty/
// Subjects/Sections page's department dropdown (session.manageDept). These
// pair with the matching save function, which writes back to that same
// single department — never call these from a page that also needs data
// from OTHER departments (use the "*All" aggregate loaders below for that).
export async function loadFaculty(){ state.faculty = await apiFetch('/api/faculty'+deptQS()); }
export async function saveFaculty(){ await apiFetch('/api/faculty'+deptQS(), {method:'PUT', body: JSON.stringify(state.faculty)}); }
export async function loadSubjects(){ state.subjects = await apiFetch('/api/subjects'+deptQS()); }
export async function saveSubjects(){ await apiFetch('/api/subjects'+deptQS(), {method:'PUT', body: JSON.stringify(state.subjects)}); }
export async function loadSections(){ state.sections = await apiFetch('/api/sections'+deptQS()); }
export async function saveSections(){ await apiFetch('/api/sections'+deptQS(), {method:'PUT', body: JSON.stringify(state.sections)}); }
export async function loadSyncPref(){ state.syncPref = await apiFetch('/api/sync-pref'+deptQS()); }
export async function saveSyncPref(){ await apiFetch('/api/sync-pref'+deptQS(), {method:'PUT', body: JSON.stringify(state.syncPref)}); }

// "All" loaders: READ-ONLY aggregate across every department, available
// to both the registrar and a chair (the server honors scope=all for any
// authorized account — see src/lib/dept-resource.js). Used by Home
// (counts) and the shared Rooms/Assign/Schedule pages, which need to see
// every department's sections/subjects/faculty at once but never write
// these resources back — a chair generating a schedule still sees and
// schedules every department, exactly like the registrar, so Generate
// Schedule never silently drops another department's classes.
export async function loadFacultyAll(){ state.faculty = await apiFetch('/api/faculty?scope=all'); }

// Same read as loadFacultyAll (every department's full faculty records,
// available to a chair too — see dept-resource.js), but does NOT touch
// state.faculty. Used by the Faculty page's "Link a Shared Instructor"
// search, which needs to look across every department without clobbering
// the department-scoped list (state.faculty) that page is editing.
export async function fetchFacultyAll(){ return apiFetch('/api/faculty?scope=all'); }
export async function loadSubjectsAll(){ state.subjects = await apiFetch('/api/subjects?scope=all'); }
export async function loadSectionsAll(){ state.sections = await apiFetch('/api/sections?scope=all'); }
export async function loadSyncPrefAll(){ state.syncPref = await apiFetch('/api/sync-pref?scope=all'); }

// Lightweight, read-only {id,name,department} list of EVERY faculty member
// across EVERY department (available to a chair too, unlike the "*All"
// loaders above which are registrar-only) — used solely to warn about a
// likely duplicate faculty record before one gets created; see
// js/faculty.js and functions/api/faculty-directory.js. Deliberately does
// not touch state.faculty.
export async function loadFacultyDirectory(){
  return apiFetch('/api/faculty-directory');
}

export async function loadSharedData(){
  const data = await apiFetch('/api/shared-data');
  Object.assign(state, data);
}
export async function saveSharedData(){
  const payload = {
    rooms: state.rooms, assignments: state.assignments, yearPref: state.yearPref,
    schedule: state.schedule, manualRemoved: state.manualRemoved,
    previousSchedule: state.previousSchedule, previousManualRemoved: state.previousManualRemoved,
    hasScheduleBackup: state.hasScheduleBackup,
    deptScheduleBackups: state.deptScheduleBackups
  };
  await apiFetch('/api/shared-data', {method:'PUT', body: JSON.stringify(payload)});
}

// Fire-and-forget save wrappers for click handlers — keeps the same
// "mutate then save" flow the app used with localStorage, just async
// underneath. Alerts the user if a save actually fails (e.g. dropped wifi).
function saver(fn){ return function(){ return fn().catch(err=> alert("Could not save your change — it may not have persisted. " + err.message)); }; }
export const persistFaculty = saver(saveFaculty);
export const persistSubjects = saver(saveSubjects);
export const persistSections = saver(saveSections);
export const persistSyncPref = saver(saveSyncPref);
export const persistSharedData = saver(saveSharedData);

/* ============================= UTIL ============================= */
export function el(html){
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export function escapeHtml(s){
  return String(s==null?"":s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Lightweight, non-blocking notification — replaces alert() for routine
// confirmations/validation (import counts, "please enter a name", etc.)
// that don't need the user to dismiss a dialog before continuing. Lazily
// creates its own fixed-position container the first time it's called, so
// no page's HTML needs a mount point for this. `type` is 'info' (default),
// 'success', or 'error' — purely cosmetic (left border color); nothing here
// is a substitute for confirm() on a destructive action, which should keep
// blocking the user as before.
export function toast(message, type, duration){
  type = type || 'info';
  duration = duration || 3500;
  let root = document.getElementById('toastRoot');
  if(!root){
    root = document.createElement('div');
    root.id = 'toastRoot';
    root.className = 'toast-root';
    document.body.appendChild(root);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  root.appendChild(t);
  setTimeout(function(){
    t.style.opacity = '0';
    setTimeout(function(){ t.remove(); }, 200);
  }, duration);
}
export function hourLabel(h){
  const hh = Math.floor(h);
  const period = hh < 12 ? "AM" : "PM";
  let disp = hh % 12; if(disp===0) disp = 12;
  const mins = Math.round((h-hh)*60);
  return disp + (mins? ":"+String(mins).padStart(2,'0') : ":00") + " " + period;
}
export function timeRangeLabel(start,duration){ return hourLabel(start) + " – " + hourLabel(start+duration); }
export function byId(arr,id){ return arr.find(x=>x.id===id); }
export function facultyName(id){ const f = byId(state.faculty,id); return f? f.name : "(unassigned)"; }
// Short human label for a part-time instructor's standing availability
// (set via the single "Availability" dropdown on the Faculty page — see
// f.availability = {mode, time, days}). Used in the Assign Instructors
// dropdown and the Faculty list so a chair can see the constraint before
// trying to place them, rather than finding out only after Generate
// Schedule fails.
export function describeAvailability(f){
  const a = f && f.availability;
  if(!a || !a.mode || a.mode==='full') return '';
  if(a.mode==='morning') return 'mornings only, before ' + hourLabel(a.time);
  if(a.mode==='evening') return 'evenings only, after ' + hourLabel(a.time);
  if(a.mode==='days') return (a.days||[]).join(', ') + ' only';
  return '';
}
export function subjectById(id){ return byId(state.subjects,id); }
export function roomById(id){ return byId(state.rooms,id); }
export function sectionById(id){ return byId(state.sections,id); }
export function assignKey(sectionId,subjectId){ return sectionId+"::"+subjectId; }
export function syncKey(year,subjectId){ return year+"::"+subjectId; }

// state.faculty (loadFacultyAll's full cross-department merge) can
// legitimately contain the SAME faculty id more than once — a linked
// shared instructor is stored as one copy per department they're linked
// into (see faculty.js/linkInstructor). That's correct for conflict
// checking, but any list that enumerates "every distinct faculty member"
// (Home's stat tiles, the Faculty Load Summary, the By Faculty dropdown)
// needs to collapse those back to one row per person first. Shared here so
// every such list uses the same rule.
export function dedupeById(arr){
  const seen = new Set();
  return arr.filter(f=>{
    if(seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

export function yearsInUse(){
  const ys = new Set();
  state.sections.forEach(s=>ys.add(String(s.year)));
  state.subjects.forEach(s=>ys.add(String(s.year)));
  return Array.from(ys).sort();
}

/* ============================= CSV / FILE UTIL ============================= */
function splitDelimitedLine(line, delim){
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for(let i=0;i<line.length;i++){
    const c = line[i];
    if(inQuotes){
      if(c === '"'){
        if(line[i+1] === '"'){ cur+='"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === delim){ fields.push(cur); cur=''; }
      else cur += c;
    }
  }
  fields.push(cur);
  return fields.map(f=>f.trim());
}
export function parseDelimitedText(text){
  return text.split(/\r\n|\r|\n/)
    .filter(l=>l.trim().length>0)
    .map(line=>{
      const delim = line.indexOf('\t')>=0 ? '\t' : ',';
      return splitDelimitedLine(line, delim);
    });
}
export function downloadTextFile(filename, mime, content){
  const blob = new Blob([content], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
export function csvEscape(v){
  const s = String(v==null?'':v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
export function toCsv(rows){
  return rows.map(r=>r.map(csvEscape).join(",")).join("\r\n");
}

/* ============================= SCHEDULING ALGORITHM ============================= */
export function overlaps(startA,durA,startB,durB){
  return startA < startB+durB && startB < startA+durA;
}

export function hasConflict(block, excludeBlockId){
  for(const b of state.schedule){
    if(b.blockId === excludeBlockId) continue;
    if(b.day !== block.day) continue;
    if(!overlaps(b.start,b.duration, block.start,block.duration)) continue;
    if(b.sectionId === block.sectionId) return {type:'section', with:b};
    if(block.facultyId && b.facultyId === block.facultyId) return {type:'faculty', with:b};
    if(block.roomId && b.roomId === block.roomId) return {type:'room', with:b};
  }
  if(block.facultyId){
    const fac = byId(state.faculty, block.facultyId);
    if(fac){
      for(const ext of (fac.externalBusy||[])){
        if(ext.day===block.day && overlaps(ext.start,ext.duration, block.start,block.duration)){
          return {type:'external', with:ext};
        }
      }
      // Hard availability rule, set via the single "Availability" dropdown
      // on the Faculty page (f.availability = {mode, time, days}) — same
      // "no exceptions" treatment as the lunch rule, never a soft
      // preference that falls back if it's inconvenient.
      const avail = fac.availability;
      if(avail && avail.mode && avail.mode!=='full'){
        if(avail.mode==='days' && !(avail.days||[]).includes(block.day)){
          return {type:'availability', with:{reason:'day', day:block.day}};
        }
        if(avail.mode==='morning' && block.start + block.duration > avail.time){
          return {type:'availability', with:{reason:'morning', time:avail.time}};
        }
        if(avail.mode==='evening' && block.start < avail.time){
          return {type:'availability', with:{reason:'evening', time:avail.time}};
        }
      }
    }
  }
  return null;
}

export function buildOfferings(){
  const offerings = [];
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      const subj = subjectById(subjId);
      if(!subj) return;
      const facultyId = state.assignments[assignKey(sec.id, subjId)] || null;
      const segments = [];
      if(subj.type === 'lab'){
        if(subj.labHours>0) segments.push({segType:'lab', hours:subj.labHours});
        if(subj.lecHours>0) segments.push({segType:'lecture', hours:subj.lecHours});
      } else {
        if(subj.lecHours>0) segments.push({segType:'lecture', hours:subj.lecHours});
      }
      const totalHours = segments.reduce((s,g)=>s+g.hours,0);
      offerings.push({ section:sec, subject:subj, facultyId, segments, totalHours });
    });
  });
  return offerings;
}

export function segmentBlockId(sectionId, subjectId, segType){
  return sectionId+"::"+subjectId+"::"+segType;
}

// The very first slot of the day (7:30 AM) and the last stretch before the
// 8:30 PM cutoff are technically allowed but should be used only as a last
// resort — the registrar would rather a class start at 8:00 AM or later,
// and end well before 8:30 PM, whenever there's any other option. This is
// a soft de-prioritization (these slots are still tried, just last), never
// a hard block.
function isEdgeHour(h){
  return h === DAY_START || h >= DAY_END - 1;
}

export function candidateStartHours(segType, year){
  const yearPref = state.yearPref[year] || 'none';
  // The year's morning/afternoon preference only steers LECTURE placement.
  // Labs always use the day's slots in their natural (no-bias) order —
  // they used to be pushed toward the opposite half of the day from the
  // lecture preference, which meant a year with a "morning" lecture
  // preference ended up with its labs avoiding mornings entirely. Labs
  // should be free to land in the morning just like any other slot.
  const pref = segType==='lecture' ? yearPref : 'none';
  const all = [];
  // A start time that falls IN the lunch window is always invalid, no
  // matter the segment's duration — skip those here. A start time that
  // begins before lunch but would run INTO it depends on that segment's
  // duration, which this function doesn't know, so that case is caught
  // separately by spansLunch() wherever a block actually gets placed.
  for(let h=DAY_START; h<DAY_END; h+=TIME_STEP){
    if(h >= LUNCH_START && h < LUNCH_END) continue;
    all.push(h);
  }
  let ordered;
  if(pref==='afternoon'){
    ordered = all.slice().sort((a,b)=>{
      const aAft = a>=13, bAft = b>=13;
      if(aAft && !bAft) return -1;
      if(!aAft && bAft) return 1;
      return a-b;
    });
  } else {
    ordered = all;
  }
  // Stable partition: keep the existing (morning/afternoon-aware) order for
  // every "core" hour, and push the day's opening/closing edge slots to try
  // last, without disturbing anything else's relative order.
  const core = ordered.filter(h=>!isEdgeHour(h));
  const edge = ordered.filter(isEdgeHour);
  return [...core, ...edge];
}

// Orders the week by how many hours are already scheduled on each day
// (least busy first), instead of the fixed Mon->Sat order. Without this,
// tryPlaceSegment/trySyncGroup always try Monday first for every single
// class, so the week fills up strictly left-to-right and later days
// (Thu-Sat) only ever get used once the earlier ones are completely full
// — for a typical course load that never happens, so the schedule ends up
// looking like it "stops" partway through the week even though nothing
// requires that. Recomputed fresh from state.schedule each call so it
// always reflects what's been placed so far in this generation pass.
//
// `preferDay`, when given (e.g. "Sat" for a subject like NSTP/PE that's
// flagged to prefer Saturdays — see subj.preferSaturday), is tried FIRST
// regardless of load; the rest of the week still falls back to
// least-busy-first if that day doesn't actually have room/time available.
function daysByLoad(preferDay){
  const load = {};
  DAYS.forEach(d=>{ load[d] = 0; });
  state.schedule.forEach(b=>{ load[b.day] = (load[b.day]||0) + b.duration; });
  // Array#sort is stable, so shuffling first and then sorting by load only
  // randomizes which day goes first AMONG DAYS WITH EQUAL LOAD — a day
  // that's genuinely less busy is still always tried before a busier one.
  // Off a randomized pass, this is byte-for-byte the old fixed Mon-Sat
  // tiebreak.
  const base = randomizePass ? shuffle(DAYS) : DAYS.slice();
  const ordered = base.sort((a,b)=> load[a]-load[b] || (randomizePass ? 0 : DAYS.indexOf(a)-DAYS.indexOf(b)));
  if(preferDay && ordered.includes(preferDay)){
    return [preferDay, ...ordered.filter(d=>d!==preferDay)];
  }
  return ordered;
}

// Lecture rooms a section is "assigned home" to (set on the Rooms page,
// room.homeSectionIds) — labs are never home-assigned, since sections move
// between whichever lab room fits the subject.
function homeRoomIdsFor(sec){
  return state.rooms.filter(r=>r.type==='lecture' && (r.homeSectionIds||[]).includes(sec.id)).map(r=>r.id);
}

// Candidate rooms for a segment, in the order they should be tried. For a
// lecture segment on a section with a home room set, that home room (or
// rooms, if more than one was assigned) is tried first — but this is only
// an ordering, not a hard restriction: if the home room isn't free at the
// particular day/time being attempted, the caller still falls through to
// the next candidate here, so the class still gets scheduled rather than
// being stuck waiting on one specific room.
function roomCandidatesFor(segType, sec){
  // A department-owned room (room.department set) is only a candidate for
  // that same department's sections — this is what actually keeps Generate
  // Schedule from ever placing one department's class in another
  // department's dedicated room. A Shared/Any-Department room (no
  // department set) remains a candidate for every section, same as before.
  const matches = state.rooms.filter(r=>r.type===segType && (!r.capacity || r.capacity>=sec.studentCount) && (!r.department || r.department===sec.department));
  // Only reorders rooms that TIE on capacity (and, for lecture, on
  // home-room status) when a randomized pass is running — every eligible
  // room is still exactly the same set as before; see roomCandidatesFor's
  // callers and randomizePass above.
  const candidates = randomizePass ? shuffle(matches) : matches;
  if(segType === 'lecture'){
    const homeIds = new Set(homeRoomIdsFor(sec));
    if(homeIds.size){
      return candidates.slice().sort((a,b)=>
        (homeIds.has(a.id)?0:1) - (homeIds.has(b.id)?0:1) || (a.capacity||9999) - (b.capacity||9999)
      );
    }
  }
  return candidates.slice().sort((a,b)=> (a.capacity||9999) - (b.capacity||9999));
}

export function findRoomFor(segType, sec, day, start, duration, excludeBlockId){
  for(const room of roomCandidatesFor(segType, sec)){
    const conflict = state.schedule.some(b=> b.blockId!==excludeBlockId && b.roomId===room.id && b.day===day && overlaps(b.start,b.duration,start,duration));
    if(!conflict) return room;
  }
  return null;
}

// HARD RULE: nobody — student section or instructor — may sit through more
// than MAX_CONTINUOUS_HOURS of back-to-back LECTURE time before a break of
// at least MIN_BREAK_HOURS (30 minutes, this schedule's finest
// granularity). Laboratory periods are entirely exempt: a lab never needs
// a break of its own no matter how long it runs, and time spent in a lab
// doesn't count toward (or get interrupted by) a lecture run — see the
// `type!=='lab'` filtering and the segType check in wouldExceedBreakLimit
// below. Unlike the softer preferences elsewhere in this file, there is NO
// fallback pass that ignores this — see placeSegmentBlock/trySyncGroup.
const MAX_CONTINUOUS_HOURS = 2;
const MIN_BREAK_HOURS = 0.5;

// Given a same-day list of {start,duration} LECTURE blocks for one entity
// (a section or a faculty member) PLUS one hypothetical new lecture block,
// merges every run of blocks that touch with no real gap (a gap smaller
// than MIN_BREAK_HOURS doesn't count as a break) and reports whether the
// merged run's total duration would exceed MAX_CONTINUOUS_HOURS.
function runExceedsContinuousLimit(existingBlocks, start, duration){
  const all = existingBlocks.concat([{start, duration}]).sort((a,b)=>a.start-b.start);
  let runStart = all[0].start, runEnd = all[0].start + all[0].duration;
  for(let i=1;i<all.length;i++){
    const b = all[i];
    if(b.start - runEnd < MIN_BREAK_HOURS - 1e-9){
      runEnd = Math.max(runEnd, b.start + b.duration);
    } else {
      runStart = b.start; runEnd = b.start + b.duration;
    }
    if(runEnd - runStart > MAX_CONTINUOUS_HOURS + 1e-9) return true;
  }
  return (runEnd - runStart) > MAX_CONTINUOUS_HOURS + 1e-9;
}

// Would placing this block push the SECTION's or the FACULTY member's day
// past MAX_CONTINUOUS_HOURS of unbroken LECTURE time? Checked separately
// for each. Laboratory periods are excluded entirely: placing a lab never
// triggers this check (segType==='lab' short-circuits below), and existing
// lab blocks are filtered out of both lists so a lab sitting in the middle
// of the day never counts toward — or gets treated as part of — a lecture
// run (its real wall-clock duration still naturally provides the gap that
// resets any lecture run around it).
function wouldExceedBreakLimit(sectionId, facultyId, day, start, duration, excludeBlockId, segType){
  if(segType === 'lab') return false;
  const sectionBlocks = state.schedule
    .filter(b=> b.sectionId===sectionId && b.day===day && b.blockId!==excludeBlockId && b.type!=='lab')
    .map(b=>({start:b.start, duration:b.duration}));
  if(runExceedsContinuousLimit(sectionBlocks, start, duration)) return true;
  if(facultyId){
    const facBlocks = state.schedule
      .filter(b=> b.facultyId===facultyId && b.day===day && b.blockId!==excludeBlockId && b.type!=='lab')
      .map(b=>({start:b.start, duration:b.duration}));
    if(runExceedsContinuousLimit(facBlocks, start, duration)) return true;
  }
  return false;
}

// Finds a single free day/start/room for one contiguous block of `hours`
// and, if found, pushes it onto state.schedule under `blockId`, returning
// the day it landed on (or null on failure — never pushes a warning
// itself; callers decide whether/how to report a final failure).
// `excludeDays` (optional Set) removes specific days from consideration —
// used to force a split lecture's second half onto a different day than
// its first half. `preferDay`, if given, is tried before the normal
// least-busy-day ordering (e.g. "Sat" for a preferSaturday subject).
//
// HARD rule (see MAX_CONTINUOUS_HOURS above): a slot that would push the
// section OR the faculty member past that much unbroken lecture time is
// never used — there is no second, more lenient pass anymore. If no
// day/time/room satisfies every rule (conflicts, lunch, the break limit,
// lab exemption included), the segment is
// left unscheduled (see the warning pushed by the caller) rather than
// placed in violation.
function placeSegmentBlock(sec, subj, facultyId, segType, hours, blockId, excludeDays, preferDay){
  const starts = candidateStartHours(segType, sec.year);
  let days = daysByLoad(preferDay);
  if(excludeDays && excludeDays.size) days = days.filter(d=>!excludeDays.has(d));
  for(const day of days){
    for(const start of starts){
      if(start+hours > DAY_END) continue;
      if(spansLunch(start, hours)) continue;
      const test = {day, start, duration:hours, sectionId:sec.id, facultyId, roomId:null};
      if(hasConflict(test, blockId)) continue;
      if(wouldExceedBreakLimit(sec.id, facultyId, day, start, hours, blockId, segType)) continue;
      const room = findRoomFor(segType, sec, day, start, hours, blockId);
      if(!room) continue;
      state.schedule.push({
        blockId, day, start, duration:hours, type:segType,
        sectionId:sec.id, sectionName:sec.name,
        subjectId: subj.id, subject: subj.code+" — "+subj.name,
        facultyId, roomId: room.id, roomName: room.name,
        synced:false, manual:false
      });
      return day;
    }
  }
  return null;
}

// The two "standard" day pairs a partitioned lecture/lab is allowed to
// split across — never any other pair of days.
const DAY_PAIRS = [['Mon','Wed'], ['Tue','Thu']];

// Tries to place two equal-length halves of a segment on the two days of
// ONE standard pair (Mon+Wed or Tue+Thu — never spread across any other
// pair). Tries the currently lighter-loaded pair first, then the other;
// within a pair, either day can end up first since both halves are the
// same length. Returns the day the first half landed on (truthy) on
// success, or null if neither pair has room for both halves.
function placeOnDayPair(sec, subj, facultyId, segType, partHours, baseBlockId){
  const load = {};
  DAYS.forEach(d=>{ load[d] = 0; });
  state.schedule.forEach(b=>{ load[b.day] = (load[b.day]||0) + b.duration; });
  const basePairs = randomizePass ? shuffle(DAY_PAIRS) : DAY_PAIRS.slice();
  const pairs = basePairs.sort((a,b)=> (load[a[0]]+load[a[1]]) - (load[b[0]]+load[b[1]]));
  for(const pair of pairs){
    const outsidePair = new Set(DAYS.filter(d=>!pair.includes(d)));
    const blockId1 = baseBlockId + '#1', blockId2 = baseBlockId + '#2';
    const day1 = placeSegmentBlock(sec, subj, facultyId, segType, partHours, blockId1, outsidePair, pair[0]);
    if(day1){
      const secondDay = pair.find(d=>d!==day1);
      const day2 = placeSegmentBlock(sec, subj, facultyId, segType, partHours, blockId2, new Set([...outsidePair, day1]), secondDay);
      if(day2) return day1;
      state.schedule = state.schedule.filter(b=>b.blockId!==blockId1);
    }
  }
  return null;
}

// Returns the day the segment was actually placed on (or null on failure).
export function tryPlaceSegment(sec, subj, facultyId, segType, hours, warnings){
  const preferDay = subj.preferSaturday ? 'Sat' : null;
  const baseBlockId = segmentBlockId(sec.id, subj.id, segType);

  // HARD RULE: a 3-hour lecture is always split into two 1.5-hour halves
  // on ONE standard day pair (Mon+Wed or Tue+Thu) — never left as a single
  // 3-hour block, and never spread across any other pair of days. There is
  // no fallback here (unlike the lab case below): if no pair has room, the
  // segment stays unscheduled and shows up in Unscheduled Sessions.
  // subj.oneMeeting still wins if the registrar explicitly asked for one
  // single meeting regardless of length.
  if(!subj.oneMeeting && segType === 'lecture' && hours === 3){
    const day1 = placeOnDayPair(sec, subj, facultyId, segType, hours/2, baseBlockId);
    if(day1) return day1;
    warnings.push(`Could not split the 3-hour lecture for ${subj.code} (${sec.name}) across Mon/Wed or Tue/Thu — no valid pair found.`);
    return null;
  }

  // A 2-hour lab is tried FIRST as two 1-hour sessions on a standard day
  // pair; only if room/faculty/day availability rules out BOTH pairs does
  // it fall back to one continuous 2-hour block on a single day (the
  // monolithic placement below) — this is the explicit fallback case.
  //
  // The SAME distribute-first/fallback-last treatment applies to the
  // 2-hour LECTURE component of a laboratory subject (subj.type==='lab') —
  // e.g. a subject with 2 lecture hrs + lab hrs should try 1hr+1hr on
  // Mon/Wed or Tue/Thu, and only sit as one straight 2-hour block if no
  // pair has room for both halves. This does NOT apply to a 2-hour
  // lecture on a lecture-ONLY subject (subj.type!=='lab') — that case
  // still always stays a single 2-hour block, per the rule below.
  // subj.oneMeeting only ever exempts the LECTURE half from splitting (it's
  // a "keep this lecture in one meeting" flag — see subjects.html) — it
  // never affects the lab half, which always tries the day-pair split.
  if(
    (segType === 'lab' && hours === 2) ||
    (segType === 'lecture' && hours === 2 && subj.type === 'lab' && !subj.oneMeeting)
  ){
    const day1 = placeOnDayPair(sec, subj, facultyId, segType, 1, baseBlockId);
    if(day1) return day1;
  }

  // A 2-hour lecture on a lecture-ONLY subject is never partitioned —
  // always one single 2-hour block (falls straight through to the
  // monolithic placement below). Any OTHER lecture length (e.g. 4 hours)
  // keeps the previous generic two-day split-then-fallback behavior,
  // since it isn't covered by a specific rule.
  if(!subj.oneMeeting && segType === 'lecture' && hours > 2 && hours !== 3){
    const part1 = Math.ceil(hours/2), part2 = hours - part1;
    if(part2 > 0){
      const blockId1 = baseBlockId + '#1', blockId2 = baseBlockId + '#2';
      const day1 = placeSegmentBlock(sec, subj, facultyId, segType, part1, blockId1, null, preferDay);
      if(day1){
        const day2 = placeSegmentBlock(sec, subj, facultyId, segType, part2, blockId2, new Set([day1]), preferDay);
        if(day2) return day1;
        state.schedule = state.schedule.filter(b=>b.blockId!==blockId1);
      }
    }
  }

  const day = placeSegmentBlock(sec, subj, facultyId, segType, hours, baseBlockId, null, preferDay);
  if(day) return day;
  warnings.push(`Could not place ${segType} for ${subj.code} (${sec.name}) — no free faculty/room/day-time combination found.`);
  return null;
}

export function trySyncGroup(year, subjectId, sections, warnings){
  const subj = subjectById(subjectId);
  if(!subj) return;
  const segTypes = subj.type==='lab' ? ['lab','lecture'] : ['lecture'];
  segTypes.forEach(segType=>{
    const hours = segType==='lab' ? subj.labHours : subj.lecHours;
    if(!hours) return;
    const parts = sections.map(sec=>({
      sec, facultyId: state.assignments[assignKey(sec.id, subjectId)] || null
    }));
    const readyParts = parts.filter(p=>p.facultyId);
    if(readyParts.length < 2){
      parts.forEach(p=>{
        if(p.facultyId) tryPlaceSegment(p.sec, subj, p.facultyId, segType, hours, warnings);
        else warnings.push(`${subj.code} (${p.sec.name}) has no instructor assigned — skipped.`);
      });
      return;
    }
    const starts = candidateStartHours(segType, year);
    // HARD rule: a day/time is only valid if NONE of the synced sections
    // (or their instructors) would end up past the back-to-back class
    // limit — there is no fallback pass that drops this check anymore.
    const findSlot = ()=>{
      for(const day of daysByLoad(subj.preferSaturday ? 'Sat' : null)){
        for(const start of starts){
          if(start+hours > DAY_END) continue;
          if(spansLunch(start, hours)) continue;
          const usedRooms = new Set();
          const plan = [];
          let ok = true;
          for(const p of readyParts){
            const blockId = segmentBlockId(p.sec.id, subj.id, segType);
            const test = {day, start, duration:hours, sectionId:p.sec.id, facultyId:p.facultyId, roomId:null};
            if(hasConflict(test, blockId)){ ok=false; break; }
            if(wouldExceedBreakLimit(p.sec.id, p.facultyId, day, start, hours, blockId, segType)){ ok=false; break; }
            const room = roomCandidatesFor(segType, p.sec).find(r=> !usedRooms.has(r.id)
              && !state.schedule.some(b=>b.blockId!==blockId && b.roomId===r.id && b.day===day && overlaps(b.start,b.duration,start,hours)));
            if(!room){ ok=false; break; }
            usedRooms.add(room.id);
            plan.push({p, blockId, room});
          }
          if(ok) return {day, start, plan};
        }
      }
      return null;
    };
    const found = findSlot();
    let placed = false;
    if(found){
      found.plan.forEach(({p,blockId,room})=>{
        state.schedule.push({
          blockId, day:found.day, start:found.start, duration:hours, type:segType,
          sectionId:p.sec.id, sectionName:p.sec.name,
          subjectId: subj.id, subject: subj.code+" — "+subj.name,
          facultyId:p.facultyId, roomId:room.id, roomName:room.name,
          synced:true, manual:false
        });
      });
      placed = true;
    }
    if(!placed){
      warnings.push(`Same-time scheduling for ${subj.code} (${YEAR_LABELS[year]}) wasn't feasible — placing sections independently instead.`);
      readyParts.forEach(p=> tryPlaceSegment(p.sec, subj, p.facultyId, segType, hours, warnings));
    }
    parts.filter(p=>!p.facultyId).forEach(p=> warnings.push(`${subj.code} (${p.sec.name}) has no instructor assigned — skipped.`));
  });
}

// Drag-and-drop rescheduling: moves one block to a new day/start, then
// walks that section's remaining blocks on the destination day left to
// right, nudging any that now overlap it — or now break the room/faculty
// availability rules, or now violate MAX_CONTINUOUS_HOURS of unbroken
// lecture time — forward in TIME_STEP steps ("ripple" shifting) until each
// is valid again (labs are exempt, per wouldExceedBreakLimit). Every
// rule stays hard (conflicts, lunch, the day bounds, the break limit); the
// whole move is rolled back — nothing in state.schedule changes — if the
// ripple can't be resolved before the day runs out. Callers should treat
// {ok:false} as "show the conflict to the user", never as a partial move.
export function rescheduleBlockWithCascade(blockId, newDay, newStart){
  const before = state.schedule.map(b=>Object.assign({}, b));
  const rollback = ()=>{ state.schedule = before; };

  const block = state.schedule.find(b=>b.blockId===blockId);
  if(!block) return {ok:false, reason:"That session no longer exists."};
  const duration = block.duration;

  if(newStart + duration > DAY_END) return {ok:false, reason:"That would run past the end of the day (8:30 PM)."};
  if(spansLunch(newStart, duration)) return {ok:false, reason:"That would overlap the 12:00–1:00 lunch break."};

  block.day = newDay;
  block.start = newStart;
  const conflict = hasConflict(block, blockId);
  if(conflict){
    if(conflict.type === 'room'){
      const room = findRoomFor(block.type, sectionById(block.sectionId) || {id:block.sectionId, studentCount:0}, newDay, newStart, duration, blockId);
      if(!room){ rollback(); return {ok:false, reason:"That slot is already taken and no other room is free at that time."}; }
      block.roomId = room.id; block.roomName = room.name;
    } else {
      rollback();
      const who = conflict.type==='faculty' ? 'the instructor already has a class' : conflict.type==='external' ? 'the instructor has an external commitment' : 'this section already has a class';
      return {ok:false, reason:`That exact time is taken — ${who} then.`};
    }
  }
  block.manual = true;

  const dayBlocks = state.schedule
    .filter(b=> b.sectionId===block.sectionId && b.day===newDay)
    .sort((a,b)=>a.start-b.start);
  for(let i=1;i<dayBlocks.length;i++){
    const cur = dayBlocks[i];
    let guard = 0;
    while(
      spansLunch(cur.start, cur.duration) ||
      cur.start + cur.duration > DAY_END ||
      hasConflict(cur, cur.blockId) ||
      wouldExceedBreakLimit(cur.sectionId, cur.facultyId, cur.day, cur.start, cur.duration, cur.blockId, cur.type)
    ){
      cur.start += TIME_STEP;
      guard++;
      if(cur.start + cur.duration > DAY_END || guard > 200){
        rollback();
        return {ok:false, reason:`Moving this class would leave "${cur.subject}" (${cur.sectionName}) with nowhere valid left on ${DAY_NAMES[newDay]}.`};
      }
    }
  }

  const shifted = [];
  before.forEach(orig=>{
    const now = state.schedule.find(b=>b.blockId===orig.blockId);
    if(now && (now.day!==orig.day || now.start!==orig.start)) shifted.push({blockId: now.blockId, subject: now.subject, day: now.day, start: now.start});
  });

  persistSharedData();
  return {ok:true, shifted};
}

// Department of the section a schedule block (or a manualRemoved blockId)
// belongs to — null if the section no longer exists. blockId is always
// `${sectionId}::${subjectId}::${segType}` (see segmentBlockId), so the
// section id is just its first `::`-delimited part.
function blockSectionDept(block){
  const sec = sectionById(block.sectionId);
  return sec ? sec.department : null;
}
function blockIdSectionDept(blockId){
  const sec = sectionById(blockId.split('::')[0]);
  return sec ? sec.department : null;
}

// deptScope is a department string to scope this call to (a chair acting
// only on their own department), or omitted/null for the registrar's
// whole-campus action — every function below keeps that same meaning.
export function backupSchedule(deptScope){
  if(!deptScope){
    state.previousSchedule = state.schedule.slice();
    state.previousManualRemoved = Object.assign({}, state.manualRemoved);
    state.hasScheduleBackup = true;
    return;
  }
  // Snapshot ONLY this department's own rows, keyed separately per
  // department so two chairs generating back-to-back never clobber each
  // other's undo, and Revert can never touch anyone else's schedule.
  state.deptScheduleBackups = state.deptScheduleBackups || {};
  state.deptScheduleBackups[deptScope] = {
    schedule: state.schedule.filter(b=> blockSectionDept(b)===deptScope),
    manualRemovedKeys: Object.keys(state.manualRemoved).filter(k=> blockIdSectionDept(k)===deptScope)
  };
}
export function hasDeptScheduleBackup(deptScope){
  return !!(deptScope && state.deptScheduleBackups && state.deptScheduleBackups[deptScope]);
}
export function revertSchedule(deptScope){
  if(!deptScope){
    const curSchedule = state.schedule;
    const curManualRemoved = state.manualRemoved;
    state.schedule = state.previousSchedule;
    state.manualRemoved = state.previousManualRemoved;
    state.previousSchedule = curSchedule;
    state.previousManualRemoved = curManualRemoved;
    persistSharedData();
    return;
  }
  const backups = state.deptScheduleBackups || {};
  const backup = backups[deptScope];
  if(!backup) return;
  // Pull this department's CURRENT rows/keys out first (becoming the new
  // backup, so Revert stays a one-level toggle), then splice the backup's
  // rows back in — every other department's rows/keys are never touched.
  const curDeptSchedule = state.schedule.filter(b=> blockSectionDept(b)===deptScope);
  const keepManual = {};
  const curDeptManualKeys = [];
  Object.keys(state.manualRemoved).forEach(k=>{
    if(blockIdSectionDept(k)===deptScope) curDeptManualKeys.push(k);
    else keepManual[k] = true;
  });
  backup.manualRemovedKeys.forEach(k=> keepManual[k] = true);

  state.schedule = state.schedule.filter(b=> blockSectionDept(b)!==deptScope).concat(backup.schedule);
  state.manualRemoved = keepManual;
  backups[deptScope] = { schedule: curDeptSchedule, manualRemovedKeys: curDeptManualKeys };
  state.deptScheduleBackups = backups;
  persistSharedData();
}
// Clears the generated schedule — every department's, for the registrar,
// or only deptScope's own rows for a chair, leaving every other
// department's already-placed blocks exactly where they are.
export function clearSchedule(deptScope){
  backupSchedule(deptScope);
  if(deptScope){
    state.schedule = state.schedule.filter(b=> blockSectionDept(b)!==deptScope);
    Object.keys(state.manualRemoved).forEach(k=>{
      if(blockIdSectionDept(k)===deptScope) delete state.manualRemoved[k];
    });
  } else {
    state.schedule = [];
    state.manualRemoved = {};
  }
  persistSharedData();
}

// `randomize`, when true, tries a different equally-valid arrangement each
// time you generate — it only shuffles which of several EQUALLY GOOD
// offerings/rooms/days is tried first (see randomizePass, shuffle() and
// their use in daysByLoad/roomCandidatesFor/placeOnDayPair above); every
// hard rule (conflicts, lunch, the continuous-hours break limit, room
// capacity/department, the Mon/Wed-Tue/Thu day-pair split) is checked by
// hasConflict/wouldExceedBreakLimit/findRoomFor exactly as before and is
// never relaxed. Omit it (or pass false) for the original deterministic
// behavior.
export function generateSchedule(deptScope, randomize){
  randomizePass = !!randomize;
  try {
    backupSchedule(deptScope);
    if(deptScope){
      state.schedule = state.schedule.filter(b=> blockSectionDept(b)!==deptScope);
    } else {
      state.schedule = [];
    }
    const warnings = [];

    const scopedSections = deptScope ? state.sections.filter(sec=>sec.department===deptScope) : state.sections;
    const syncGroups = {};
    scopedSections.forEach(sec=>{
      sec.subjectIds.forEach(subjId=>{
        const key = syncKey(sec.year, subjId);
        (syncGroups[key] = syncGroups[key]||{year:sec.year, subjectId:subjId, sections:[]}).sections.push(sec);
      });
    });
    const handledOfferings = new Set();
    const groups = randomizePass ? shuffle(Object.values(syncGroups)) : Object.values(syncGroups);
    groups.forEach(g=>{
      if(g.sections.length>=2 && state.syncPref[syncKey(g.year,g.subjectId)]){
        trySyncGroup(g.year, g.subjectId, g.sections, warnings);
        g.sections.forEach(sec=> handledOfferings.add(assignKey(sec.id,g.subjectId)));
      }
    });

    let offerings = buildOfferings().filter(o=>!handledOfferings.has(assignKey(o.section.id,o.subject.id)));
    if(deptScope) offerings = offerings.filter(o=> o.section.department===deptScope);
    // Stable sort, so shuffling first only randomizes ties — offerings
    // with MORE total hours are still always placed before ones with
    // fewer, exactly as before (that ordering is what keeps the week from
    // fragmenting).
    if(randomizePass) offerings = shuffle(offerings);
    offerings.sort((a,b)=> b.totalHours - a.totalHours);
    offerings.forEach(o=>{
      if(!o.facultyId){
        warnings.push(`${o.subject.code} (${o.section.name}) has no instructor assigned — skipped.`);
        return;
      }
      const segs = o.segments.slice().sort((a,b)=>b.hours-a.hours);
      segs.forEach(seg=>{
        tryPlaceSegment(o.section, o.subject, o.facultyId, seg.segType, seg.hours, warnings);
      });
    });

    if(deptScope){
      Object.keys(state.manualRemoved).forEach(k=>{
        if(blockIdSectionDept(k)===deptScope) delete state.manualRemoved[k];
      });
    } else {
      state.manualRemoved = {};
    }
    persistSharedData();
    return warnings;
  } finally {
    randomizePass = false;
  }
}

export function expectedBlockIds(){
  const ids = [];
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      const subj = subjectById(subjId);
      if(!subj) return;
      if(!state.assignments[assignKey(sec.id,subjId)]) return;
      if(subj.type==='lab'){
        if(subj.labHours>0) ids.push({blockId:segmentBlockId(sec.id,subjId,'lab'), sec, subj, segType:'lab', hours:subj.labHours});
        if(subj.lecHours>0) ids.push({blockId:segmentBlockId(sec.id,subjId,'lecture'), sec, subj, segType:'lecture', hours:subj.lecHours});
      } else if(subj.lecHours>0){
        ids.push({blockId:segmentBlockId(sec.id,subjId,'lecture'), sec, subj, segType:'lecture', hours:subj.lecHours});
      }
    });
  });
  return ids;
}

export function computeMissing(){
  const expected = expectedBlockIds();
  return expected.filter(e=>{
    // A lecture requirement may be satisfied either as one whole block
    // (blockId) or as two split halves (blockId#1 + blockId#2) — see
    // tryPlaceSegment. Sum whichever of those actually landed in the
    // schedule rather than checking for one exact blockId.
    const placedHours = state.schedule
      .filter(b=> b.blockId===e.blockId || b.blockId===e.blockId+'#1' || b.blockId===e.blockId+'#2')
      .reduce((sum,b)=>sum+b.duration, 0);
    return placedHours < e.hours;
  });
}

export function parseAdminUnits(designations){
  let total = 0;
  (designations||[]).forEach(d=>{
    const matches = String(d).matchAll(/(\d+(\.\d+)?)\s*units?/gi);
    for(const m of matches) total += parseFloat(m[1]);
  });
  return total;
}

/* ============================================================
   CHROME — shared header + nav injected into every page
   ============================================================ */
// Small hand-drawn line-icon set (24x24, stroke-based, no external icon
// font/library) shared by the sidebar nav, and by Home's stat tiles,
// Scheduling Status checklist and Quick Actions panel — see icon() below.
const ICON_PATHS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10"/><path d="M9 21v-6h6v6"/>',
  faculty: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.3 3-5.5 6.5-5.5s6.5 2.2 6.5 5.5"/><path d="M16 8.2c1.3.3 2.3 1.4 2.3 2.8 0 1.1-.6 2-1.5 2.5"/><path d="M15.5 14.7c2.6.5 4.5 2.3 4.5 4.8"/>',
  subjects: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15Z"/>',
  sections: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="15" width="7" height="7" rx="1.5"/><rect x="14" y="15" width="7" height="7" rx="1.5"/>',
  rooms: '<path d="M4 21V6l8-3 8 3v15"/><path d="M4 21h16"/><path d="M9 21v-5h6v5"/><path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01"/>',
  assign: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.3 3-5.5 6.5-5.5s6.5 2.2 6.5 5.5"/><path d="m16 11 2 2 3.5-3.5"/>',
  schedule: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
  users: '<circle cx="8" cy="8" r="3.2"/><circle cx="17" cy="9" r="2.6"/><path d="M2.5 20c0-3.1 2.8-5.2 5.5-5.2s5.5 2.1 5.5 5.2"/><path d="M14.5 15.3c2.2.2 4 1.9 4 4.7"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/>',
  warn: '<path d="M10.3 3.9 2.6 18a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0Z"/><path d="M12 9.5v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendarCheck: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="m8.5 15 2 2 4-4"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  clear: '<circle cx="12" cy="12" r="9"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>'
};
export function icon(name, cls){
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls||''}">${ICON_PATHS[name]||''}</svg>`;
}

// Generic tab-bar wiring reused by Faculty/Subjects/Generate Schedule's
// in-page sub-navigation (Add/Bulk Import/etc.) — clicking a
// [data-tab] button in the bar toggles .active on the buttons and
// toggles .hidden on every element matched by panelSelector whose
// data-panel matches the clicked button's data-tab.
export function wireTabs(tabBarId, panelSelector){
  const bar = document.getElementById(tabBarId);
  if(!bar) return;
  bar.addEventListener('click', function(e){
    const btn = e.target.closest('button[data-tab]');
    if(!btn) return;
    const key = btn.dataset.tab;
    bar.querySelectorAll('button[data-tab]').forEach(b=> b.classList.toggle('active', b===btn));
    document.querySelectorAll(panelSelector).forEach(p=> p.classList.toggle('hidden', p.dataset.panel!==key));
  });
}

const NAV_ITEMS = [
  {key:'home', href:'index.html', label:'Home', icon:'home', roles:['registrar','chair']},
  {key:'faculty', href:'faculty.html', label:'Faculty', icon:'faculty', roles:['registrar','chair']},
  {key:'subjects', href:'subjects.html', label:'Subjects', icon:'subjects', roles:['registrar','chair']},
  {key:'sections', href:'sections.html', label:'Sections', icon:'sections', roles:['registrar','chair']},
  {key:'rooms', href:'rooms.html', label:'Rooms', icon:'rooms', roles:['registrar','chair']},
  {key:'assign', href:'assign.html', label:'Assign Instructors', icon:'assign', roles:['registrar','chair']},
  {key:'schedule', href:'schedule.html', label:'Generate Schedule', icon:'schedule', roles:['registrar','chair']},
  {key:'users', href:'users.html', label:'Users', icon:'users', roles:['registrar']}
];

// Points the browser tab's favicon at the OMSU seal. Done here (once, at
// chrome render time) instead of a <link rel="icon"> in every page's
// <head> — same result, one place to maintain instead of seven HTML files.
function ensureFavicon(){
  let link = document.querySelector("link[rel~='icon']");
  if(!link){
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = 'assets/omsu-logo.png';
}

function renderChrome(activeKey){
  const headerMount = document.getElementById('chromeHeader');
  const navMount = document.getElementById('chromeNav');
  const footerMount = document.getElementById('chromeFooter');
  const roleLabel = session.isRegistrar ? "Registrar" : (session.department ? session.department + " Program Chair" : "");

  if(headerMount){
    headerMount.innerHTML = `
      <header class="app-header">
        <div class="row" style="justify-content:space-between; align-items:flex-start;">
          <div>
            <h1>Faculty Scheduler</h1>
            <div class="sub">Occidental Mindoro State University — Faculty, subjects, rooms &amp; sections — auto-generated weekly schedule</div>
          </div>
          <div class="row" style="flex:none; align-items:center;">
            <div class="user-badge">
              <div><strong>${escapeHtml(session.email||'')}</strong></div>
              <div class="muted" style="font-size:12px;">${escapeHtml(roleLabel)}</div>
            </div>
            <button class="btn btn-sm" id="exportDataBtn" title="Download the data currently loaded on this page as a JSON file">${icon('download')}Export Data</button>
            <button class="btn btn-sm" id="logoutBtn">${icon('logout')}Log Out</button>
          </div>
        </div>
        <div id="deptBar"></div>
      </header>
    `;
    ensureFavicon();
    document.getElementById('exportDataBtn').addEventListener('click', function(){
      const stamp = new Date().toISOString().slice(0,10);
      downloadTextFile("faculty-scheduler-"+activeKey+"-"+stamp+".json", "application/json", JSON.stringify(state, null, 2));
    });
    document.getElementById('logoutBtn').addEventListener('click', function(){
      clearToken();
      location.href = 'index.html';
    });
  }
  // #chromeNav is now the fixed left sidebar (see app.css) rather than a
  // row of top tabs — the OMSU seal and app name live here instead of the
  // header, plus an icon'd nav list and the campus tagline. Mount id is
  // unchanged, so no page's HTML needed to change, only what's injected.
  if(navMount){
    const visible = NAV_ITEMS.filter(item=> session.isRegistrar ? item.roles.includes('registrar') : item.roles.includes('chair'));
    navMount.innerHTML = `
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="assets/omsu-logo.png" alt="Occidental Mindoro State University seal" class="sidebar-logo">
          <div>
            <div class="sidebar-title">OMSU</div>
            <div class="sidebar-subtitle">Faculty Scheduler</div>
            <div class="sidebar-org">Occidental Mindoro State University</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${visible.map(item=>`<a href="${item.href}" class="${item.key===activeKey?'active':''}">${icon(item.icon)}<span>${item.label}</span></a>`).join("")}
        </nav>
        <div class="sidebar-foot">Excellence. Service. Development.</div>
      </aside>
    `;
  }
  if(footerMount){
    footerMount.innerHTML = `<div class="footer-note">Faculty Scheduler · signed in as ${escapeHtml(session.email||'')} (${escapeHtml(roleLabel)})</div>`;
  }
}

// Swaps the header's default "Faculty Scheduler" title + university
// subtitle for a page-specific title and a "Home > ... > Current Page"
// breadcrumb trail. Call after bootSession() (so #chromeHeader is already
// rendered) from any page that wants this — it's an opt-in post-process on
// the existing header markup rather than a renderChrome() parameter, so
// every page that doesn't call it keeps today's header exactly as-is.
// `crumbs` is an array of {label, href?} — the last entry (current page)
// should omit href.
export function renderPageTitle(title, crumbs){
  const header = document.querySelector('#chromeHeader .app-header');
  if(!header) return;
  const titleEl = header.querySelector('h1');
  const subEl = header.querySelector('.sub');
  if(titleEl) titleEl.textContent = title;
  if(subEl){
    subEl.className = 'breadcrumb';
    subEl.innerHTML = crumbs.map((c,i)=> i<crumbs.length-1 && c.href
      ? `<a href="${c.href}">${escapeHtml(c.label)}</a><span class="sep">›</span>`
      : `<span class="current">${escapeHtml(c.label)}</span>`
    ).join('');
  }
}

// Renders the "Managing department:" dropdown into the header's #deptBar,
// visible only for a registrar. Calling this again (e.g. after boot) is
// safe/idempotent. `onChange` is called (and may be async) after the
// dropdown selection changes and session.manageDept has been updated.
function renderDeptBar(onChange){
  const bar = document.getElementById('deptBar');
  if(!bar) return;
  if(!session.isRegistrar){ bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <div class="dept-bar">
      <label class="muted" style="font-size:12px;">Managing department:</label>
      <select id="deptSelect">
        ${DEPARTMENTS.map(d=>`<option value="${d}" ${d===session.manageDept?'selected':''}>${d}</option>`).join("")}
      </select>
    </div>`;
  document.getElementById('deptSelect').addEventListener('change', async function(e){
    session.manageDept = e.target.value;
    saveManageDept(session.manageDept);
    await onChange();
  });
}

/* ============================================================
   PAGE BOOT HELPERS
   ============================================================ */

// Call once at the top of every page script. Checks for a stored login
// token, shows a login form if there isn't a valid one, resolves the
// signed-in user's role from the token's claims, and renders the shared
// chrome. Returns false (and shows a blocking message) if there's no valid
// session yet, or the account isn't set up with a valid role.
export async function bootSession(activeKey){
  const token = loadToken();
  const payload = token ? decodeJWTPayload(token) : null;
  const stillValid = payload && payload.exp && payload.exp > Math.floor(Date.now()/1000);

  if(!stillValid){
    clearToken();
    renderLoginForm();
    return false;
  }

  session.token = token;
  session.email = payload.email;
  session.isRegistrar = !!payload.isRegistrar;
  session.department = payload.department || null;
  if(session.isRegistrar){
    const saved = loadSavedManageDept();
    session.manageDept = (saved && DEPARTMENTS.includes(saved)) ? saved : DEPARTMENTS[0];
  } else {
    session.manageDept = session.department;
  }

  if(!session.isRegistrar && !session.department){
    // Shouldn't normally happen (the server only ever issues a token for a
    // registrar or a chair-<dept> account), but kept as a safety net —
    // e.g. if an account's role gets cleared after the token was issued.
    document.body.innerHTML = `<div class="empty-msg" style="margin:60px auto; max-width:560px; text-align:center;">
      <p>Your account (${escapeHtml(session.email)}) isn't tagged with a department or the registrar role.
      Ask the registrar to fix your account's role from the Users page.</p>
      <button class="btn" id="stuckLogoutBtn">Log Out &amp; Try Again</button>
    </div>`;
    document.getElementById('stuckLogoutBtn').addEventListener('click', function(){
      clearToken();
      location.reload();
    });
    return false;
  }
  renderChrome(activeKey);
  return true;
}

// For the one page that only the registrar may use (Users — account
// management). Rooms / Assign Instructors / Generate Schedule are shared
// pages both the registrar and any department chair may use now, so they
// no longer call this. Shows a blocking message and returns false for
// anyone who isn't the registrar.
export function requireRegistrar(){
  if(session.isRegistrar) return true;
  document.querySelectorAll('main').forEach(m=>{
    m.innerHTML = `<div class="card"><div class="empty-msg">This page is managed by the registrar only.</div></div>`;
  });
  return false;
}

// Wires the department dropdown (registrar only) for a department-scoped
// page (Faculty/Subjects/Sections), calling `reload` whenever it changes.
export function wireDeptBar(reload){
  renderDeptBar(reload);
}
