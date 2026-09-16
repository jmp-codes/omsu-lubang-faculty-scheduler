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
export const YEAR_LABELS = {1:"1st Year",2:"2nd Year",3:"3rd Year",4:"4th Year",5:"5th Year"};
export const DEPARTMENTS = ["BSIT","BSBA-OM","BEEd"];

export function uid(prefix){ return prefix + "_" + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }

export function defaultState(){
  return {
    faculty: [],     // {id,name,rank,qualifications:[],designations:[],externalBusy:[{id,day,start,duration,label}],department}
    subjects: [],    // {id,code,name,year,units,type,lecHours,labHours,department,semester,curriculum,archived,preferSaturday}
    rooms: [],       // {id,name,type,capacity,homeSectionIds:[]} — shared/registrar-owned; homeSectionIds only meaningful for type==='lecture'
    sections: [],    // {id,name,year,studentCount,subjectIds:[],department}
    assignments: {}, // `${sectionId}::${subjectId}` -> facultyId — shared/registrar-owned
    syncPref: {},    // `${year}::${subjectId}` -> true/false — department-owned
    yearPref: {},    // year -> 'morning'|'afternoon'|'none' — shared/registrar-owned
    schedule: [],    // placed blocks — shared/registrar-owned
    manualRemoved: {}, // blockId -> true — shared/registrar-owned
    previousSchedule: [],      // one-level undo backup — shared/registrar-owned
    previousManualRemoved: {},
    hasScheduleBackup: false
  };
}

export let state = defaultState();

/* ============================= SESSION / AUTH ============================= */
// `session.department` is the signed-in chair's own department (fixed).
// `session.manageDept` is which department a REGISTRAR is currently viewing
// on the Faculty/Subjects/Sections pages (chairs never change this).
export let session = { user: null, email: null, isRegistrar: false, department: null, manageDept: null };

function waitForIdentityWidget(){
  return new Promise((resolve)=>{
    if(window.netlifyIdentity){ resolve(window.netlifyIdentity); return; }
    let tries = 0;
    const t = setInterval(()=>{
      tries++;
      if(window.netlifyIdentity){ clearInterval(t); resolve(window.netlifyIdentity); }
      else if(tries>100){ clearInterval(t); resolve(null); }
    }, 50);
  });
}

// Resolves once a user is signed in (opening the login widget if needed).
//
// netlify-identity-widget needs its own init() call to configure gotrue and
// fetch /.netlify/identity/settings — without it, open('login') creates an
// iframe shell that never finishes rendering an actual form. But this
// widget version has a separate, known quirk: after init(), it can leave
// TWO #netlify-identity-widget iframes in the DOM instead of one — an
// empty, full-screen, invisible one sitting on top of the real login form,
// silently swallowing every click on the page (with zero console errors,
// so it looks like the page just froze). fixDuplicateWidgetFrame() below
// cleans that up: whichever iframe actually has form content in it is the
// real one — keep that one visible and remove any empty duplicates.
function fixDuplicateWidgetFrame(){
  const frames = Array.from(document.querySelectorAll('iframe#netlify-identity-widget'));
  if(frames.length < 2) return;
  let real = null;
  frames.forEach(f=>{
    let hasContent = false;
    try{ hasContent = !!(f.contentDocument && f.contentDocument.querySelector('input,button')); }catch(e){}
    if(hasContent) real = f;
  });
  frames.forEach(f=>{
    if(real && f === real) f.style.setProperty('display','block','important');
    else if(f !== real) f.remove();
  });
}

// Shown if the person closes the login/signup modal (the "X" button)
// without actually signing in. Without this, there was no way to get the
// modal back afterward short of reloading the whole page.
//
// IMPORTANT: this must NOT do document.body.innerHTML = ... — the widget's
// own iframe lives in <body>, and replacing the whole body wipes it out of
// the document. The widget object still thinks that (now-detached) iframe
// exists, so a later ni.open('login') silently does nothing. Instead we
// add an overlay alongside the existing content rather than replacing it.
function showSignInPrompt(ni){
  const old = document.getElementById('signInPromptOverlay');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'signInPromptOverlay';
  overlay.style.cssText = 'position:fixed; inset:0; z-index:90; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.55);';
  overlay.innerHTML = `<div class="empty-msg" style="background:#fff; padding:32px; border-radius:10px; max-width:360px; text-align:center;">
    <p>Please sign in to continue.</p>
    <button class="btn" id="reopenLoginBtn">Log In / Sign Up</button>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('reopenLoginBtn').addEventListener('click', function(){
    overlay.remove();
    ni.open('login');
    startWidgetFixPolling();
  });
}

// The stray-iframe fix (fixDuplicateWidgetFrame) has to poll for a few
// seconds after each open(), since which iframe ends up empty vs.
// populated can settle a little after the fact. But if that polling is
// still running at the moment a real login succeeds and the modal closes,
// it can grab the (still momentarily content-having) login iframe and
// force it back to display:block — leaving an invisible, full-screen,
// click-eating iframe sitting over the whole app even though you're
// signed in and the modal looks closed. So every place that starts this
// polling must go through here, and login/close must stop it immediately.
let widgetFixIntervalId = null;
function startWidgetFixPolling(){
  stopWidgetFixPolling();
  widgetFixIntervalId = setInterval(fixDuplicateWidgetFrame, 150);
  setTimeout(stopWidgetFixPolling, 8000);
}
function stopWidgetFixPolling(){
  if(widgetFixIntervalId){ clearInterval(widgetFixIntervalId); widgetFixIntervalId = null; }
}

// Belt-and-suspenders on top of all of the above: once we're actually past
// the login gate, the widget's iframe should NEVER be visible again on
// this page — there's nothing left for it to do. Rather than keep chasing
// every timing quirk in the widget's own internals that can leave it
// (invisibly, silently) sitting on top of the page eating clicks, this
// permanently forces it hidden the moment login succeeds, and a
// MutationObserver keeps re-hiding it if the widget's own code ever
// flips it back to visible afterward for any reason.
function neutralizeWidgetFrames(){
  document.querySelectorAll('iframe#netlify-identity-widget').forEach(f=>{
    f.style.setProperty('display','none','important');
    f.style.setProperty('pointer-events','none','important');
  });
}
let widgetFrameObserver = null;
function lockDownWidgetFrames(){
  neutralizeWidgetFrames();
  if(widgetFrameObserver) return;
  widgetFrameObserver = new MutationObserver(neutralizeWidgetFrames);
  widgetFrameObserver.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['style']});
}

async function requireLogin(){
  const ni = await waitForIdentityWidget();
  if(!ni){
    document.body.innerHTML = `<div class="empty-msg" style="margin:60px auto; max-width:520px;">Couldn't load the sign-in widget (Netlify Identity script). Check your internet connection and reload.</div>`;
    throw new Error("Identity widget unavailable");
  }
  return new Promise((resolve)=>{
    ni.on('init', user=>{ if(user) resolve(user); else ni.open('login'); });
    ni.on('login', user=>{ stopWidgetFixPolling(); ni.close(); neutralizeWidgetFrames(); resolve(user); });
    // Fires whenever the modal closes for any reason — including our own
    // ni.close() right after a successful login above, so only react to it
    // when the person closed it (the "X") WITHOUT ever signing in.
    ni.on('close', function(){ stopWidgetFixPolling(); if(!ni.currentUser()) showSignInPrompt(ni); });
    ni.init();
    startWidgetFixPolling();
  });
}

function resolveRole(user){
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  const isRegistrar = roles.includes('registrar');
  const chairRole = roles.find(r=>r.startsWith('chair-'));
  const department = chairRole ? chairRole.slice('chair-'.length) : null;
  return { isRegistrar, department: DEPARTMENTS.includes(department) ? department : null };
}

async function apiFetch(path, opts={}){
  const token = session.user ? await session.user.jwt() : null;
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  if(token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, Object.assign({}, opts, {headers}));
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

// "All" loaders: READ-ONLY aggregate across every department. For a chair
// this is identical to their own department's data (the server ignores
// scope=all for a chair); for the registrar it merges BSIT+BSBA-OM+BEEd.
// Used by Home (counts) and the registrar-only Assign/Schedule pages, which
// need to see every department's sections/subjects/faculty at once but
// never write these resources back.
export async function loadFacultyAll(){ state.faculty = await apiFetch('/api/faculty?scope=all'); }
export async function loadSubjectsAll(){ state.subjects = await apiFetch('/api/subjects?scope=all'); }
export async function loadSectionsAll(){ state.sections = await apiFetch('/api/sections?scope=all'); }
export async function loadSyncPrefAll(){ state.syncPref = await apiFetch('/api/sync-pref?scope=all'); }

export async function loadSharedData(){
  const data = await apiFetch('/api/shared-data');
  Object.assign(state, data);
}
export async function saveSharedData(){
  const payload = {
    rooms: state.rooms, assignments: state.assignments, yearPref: state.yearPref,
    schedule: state.schedule, manualRemoved: state.manualRemoved,
    previousSchedule: state.previousSchedule, previousManualRemoved: state.previousManualRemoved,
    hasScheduleBackup: state.hasScheduleBackup
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
export function subjectById(id){ return byId(state.subjects,id); }
export function roomById(id){ return byId(state.rooms,id); }
export function sectionById(id){ return byId(state.sections,id); }
export function assignKey(sectionId,subjectId){ return sectionId+"::"+subjectId; }
export function syncKey(year,subjectId){ return year+"::"+subjectId; }

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
  // Labs get pushed toward the OPPOSITE time of day from that year's
  // lecture preference where one is set — a year that prefers morning
  // lectures gets its labs nudged toward the afternoon, and vice versa —
  // so the two don't end up competing for the same rooms/hours. This is
  // still just an ordering of candidate start times (a soft preference),
  // not a hard rule: if the opposite half of the day has no room left,
  // placement still falls back to whatever slot actually works.
  const pref = segType==='lecture' ? yearPref
    : yearPref==='morning' ? 'afternoon'
    : yearPref==='afternoon' ? 'morning'
    : 'none';
  const all = [];
  for(let h=DAY_START; h<DAY_END; h+=TIME_STEP) all.push(h);
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
  const ordered = DAYS.slice().sort((a,b)=> load[a]-load[b] || DAYS.indexOf(a)-DAYS.indexOf(b));
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
  const candidates = state.rooms.filter(r=>r.type===segType && (!r.capacity || r.capacity>=sec.studentCount));
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

// Nobody — student section or instructor — should sit through more than
// this many back-to-back hours with zero gap before getting a break. Once
// a gap does appear it has to be at least MIN_BREAK_HOURS (30 minutes,
// which is also this schedule's finest granularity — a real 15-minute gap
// isn't representable on this half-hour grid, but 30 minutes satisfies
// "at least 15 minutes" too).
const MAX_CONTINUOUS_HOURS = 3;
const MIN_BREAK_HOURS = 0.5;

// Given a same-day list of {start,duration} blocks for one entity (a
// section or a faculty member) PLUS one hypothetical new block, merges
// every run of blocks that touch with no gap (or a gap smaller than
// MIN_BREAK_HOURS) and reports whether any merged run exceeds
// MAX_CONTINUOUS_HOURS. Existing schedules that already have a lone block
// longer than the limit (e.g. a long lab) will always "exceed" no matter
// where the new block goes — that's fine, since the caller falls back to
// ignoring this check entirely when no slot can satisfy it (see
// placeSegmentBlock), rather than refusing to schedule.
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
// past MAX_CONTINUOUS_HOURS of unbroken classes? Checked separately for
// each (a section's own back-to-back load, and — independently — that
// instructor's own back-to-back teaching load across whatever sections
// they teach), since either one having no break is worth avoiding.
function wouldExceedBreakLimit(sectionId, facultyId, day, start, duration, excludeBlockId){
  const sectionBlocks = state.schedule
    .filter(b=> b.sectionId===sectionId && b.day===day && b.blockId!==excludeBlockId)
    .map(b=>({start:b.start, duration:b.duration}));
  if(runExceedsContinuousLimit(sectionBlocks, start, duration)) return true;
  if(facultyId){
    const facBlocks = state.schedule
      .filter(b=> b.facultyId===facultyId && b.day===day && b.blockId!==excludeBlockId)
      .map(b=>({start:b.start, duration:b.duration}));
    if(runExceedsContinuousLimit(facBlocks, start, duration)) return true;
  }
  return false;
}

// Finds a single free day/start/room for one contiguous block of `hours`
// and, if found, pushes it onto state.schedule under `blockId`. `excludeDays`
// (optional Set) removes specific days from consideration — used to force a
// split lecture's second half onto a different day than its first half.
// Returns true/false and never pushes a warning itself; callers decide
// whether/how to report a final failure.
//
// Tries twice: first only considering slots that leave a real break after
// MAX_CONTINUOUS_HOURS (for both the section and the instructor), then —
// only if that finds nothing anywhere — again without that restriction, so
// the break preference never actually blocks a class from being scheduled.
function placeSegmentBlock(sec, subj, facultyId, segType, hours, blockId, excludeDays){
  const attempt = (avoidLongRuns)=>{
    const starts = candidateStartHours(segType, sec.year);
    let days = daysByLoad(subj.preferSaturday ? 'Sat' : null);
    if(excludeDays && excludeDays.size) days = days.filter(d=>!excludeDays.has(d));
    for(const day of days){
      for(const start of starts){
        if(start+hours > DAY_END) continue;
        const test = {day, start, duration:hours, sectionId:sec.id, facultyId, roomId:null};
        if(hasConflict(test, blockId)) continue;
        if(avoidLongRuns && wouldExceedBreakLimit(sec.id, facultyId, day, start, hours, blockId)) continue;
        const room = findRoomFor(segType, sec, day, start, hours, blockId);
        if(!room) continue;
        state.schedule.push({
          blockId, day, start, duration:hours, type:segType,
          sectionId:sec.id, sectionName:sec.name,
          subjectId: subj.id, subject: subj.code+" — "+subj.name,
          facultyId, roomId: room.id, roomName: room.name,
          synced:false, manual:false
        });
        return true;
      }
    }
    return false;
  };
  return attempt(true) || attempt(false);
}

export function tryPlaceSegment(sec, subj, facultyId, segType, hours, warnings){
  const baseBlockId = segmentBlockId(sec.id, subj.id, segType);
  // Lecture sessions are preferred split across two different days (e.g. a
  // 2-hour lecture placed as Monday 1h + Wednesday 1h) rather than as one
  // long block on a single day. This is tried FIRST; only when no valid
  // two-day placement exists does it fall back to a single contiguous
  // block covering the full duration (the previous behavior). Labs are
  // never split — they still run as one continuous session.
  if(segType === 'lecture' && hours >= 2){
    const part1 = Math.ceil(hours/2), part2 = hours - part1;
    if(part2 > 0){
      const blockId1 = baseBlockId + '#1', blockId2 = baseBlockId + '#2';
      if(placeSegmentBlock(sec, subj, facultyId, segType, part1, blockId1, null)){
        const usedDay = state.schedule.find(b=>b.blockId===blockId1).day;
        if(placeSegmentBlock(sec, subj, facultyId, segType, part2, blockId2, new Set([usedDay]))){
          return true;
        }
        // Couldn't find a second day for the other half — undo the first
        // half and fall back to a single monolithic block below.
        state.schedule = state.schedule.filter(b=>b.blockId!==blockId1);
      }
    }
  }
  if(placeSegmentBlock(sec, subj, facultyId, segType, hours, baseBlockId, null)){
    return true;
  }
  warnings.push(`Could not place ${segType} for ${subj.code} (${sec.name}) — no free faculty/room/day-time combination found.`);
  return false;
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
    // Same two-pass approach as placeSegmentBlock: first only accept a
    // day/time where NONE of the synced sections (or their instructors)
    // would end up with more than MAX_CONTINUOUS_HOURS unbroken; only if
    // no such slot exists for the whole group does a second pass drop that
    // preference, so the break rule never prevents synced sections from
    // being scheduled together.
    const findSlot = (avoidLongRuns)=>{
      for(const day of daysByLoad(subj.preferSaturday ? 'Sat' : null)){
        for(const start of starts){
          if(start+hours > DAY_END) continue;
          const usedRooms = new Set();
          const plan = [];
          let ok = true;
          for(const p of readyParts){
            const blockId = segmentBlockId(p.sec.id, subj.id, segType);
            const test = {day, start, duration:hours, sectionId:p.sec.id, facultyId:p.facultyId, roomId:null};
            if(hasConflict(test, blockId)){ ok=false; break; }
            if(avoidLongRuns && wouldExceedBreakLimit(p.sec.id, p.facultyId, day, start, hours, blockId)){ ok=false; break; }
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
    const found = findSlot(true) || findSlot(false);
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

export function backupSchedule(){
  state.previousSchedule = state.schedule.slice();
  state.previousManualRemoved = Object.assign({}, state.manualRemoved);
  state.hasScheduleBackup = true;
}
export function revertSchedule(){
  const curSchedule = state.schedule;
  const curManualRemoved = state.manualRemoved;
  state.schedule = state.previousSchedule;
  state.manualRemoved = state.previousManualRemoved;
  state.previousSchedule = curSchedule;
  state.previousManualRemoved = curManualRemoved;
  persistSharedData();
}

export function generateSchedule(){
  backupSchedule();
  state.schedule = [];
  const warnings = [];

  const syncGroups = {};
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      const key = syncKey(sec.year, subjId);
      (syncGroups[key] = syncGroups[key]||{year:sec.year, subjectId:subjId, sections:[]}).sections.push(sec);
    });
  });
  const handledOfferings = new Set();
  Object.values(syncGroups).forEach(g=>{
    if(g.sections.length>=2 && state.syncPref[syncKey(g.year,g.subjectId)]){
      trySyncGroup(g.year, g.subjectId, g.sections, warnings);
      g.sections.forEach(sec=> handledOfferings.add(assignKey(sec.id,g.subjectId)));
    }
  });

  const offerings = buildOfferings().filter(o=>!handledOfferings.has(assignKey(o.section.id,o.subject.id)));
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

  state.manualRemoved = {};
  persistSharedData();
  return warnings;
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
const NAV_ITEMS = [
  {key:'home', href:'index.html', label:'Home', roles:['registrar','chair']},
  {key:'faculty', href:'faculty.html', label:'Faculty', roles:['registrar','chair']},
  {key:'subjects', href:'subjects.html', label:'Subjects', roles:['registrar','chair']},
  {key:'sections', href:'sections.html', label:'Sections', roles:['registrar','chair']},
  {key:'rooms', href:'rooms.html', label:'Rooms', roles:['registrar']},
  {key:'assign', href:'assign.html', label:'Assign Instructors', roles:['registrar']},
  {key:'schedule', href:'schedule.html', label:'Generate Schedule', roles:['registrar']}
];

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
            <div class="sub">Faculty, subjects, rooms &amp; sections — auto-generated weekly schedule</div>
          </div>
          <div class="row" style="flex:none; align-items:center;">
            <div class="user-badge">
              <div><strong>${escapeHtml(session.email||'')}</strong></div>
              <div class="muted" style="font-size:12px;">${escapeHtml(roleLabel)}</div>
            </div>
            <button class="btn btn-sm" id="exportDataBtn" title="Download the data currently loaded on this page as a JSON file">Export Data</button>
            <button class="btn btn-sm" id="logoutBtn">Log Out</button>
          </div>
        </div>
        <div id="deptBar"></div>
      </header>
    `;
    document.getElementById('exportDataBtn').addEventListener('click', function(){
      const stamp = new Date().toISOString().slice(0,10);
      downloadTextFile("faculty-scheduler-"+activeKey+"-"+stamp+".json", "application/json", JSON.stringify(state, null, 2));
    });
    document.getElementById('logoutBtn').addEventListener('click', async function(){
      const ni = await waitForIdentityWidget();
      // logout() makes a network call to invalidate the session — it must
      // be awaited, otherwise the next page loads before the old session
      // is actually cleared and just sees the same stale logged-in user.
      if(ni){ try{ await ni.logout(); }catch(e){} }
      location.href = 'index.html';
    });
  }
  if(navMount){
    const visible = NAV_ITEMS.filter(item=> session.isRegistrar ? item.roles.includes('registrar') : item.roles.includes('chair'));
    navMount.innerHTML = `<nav class="tabs">` +
      visible.map(item=>`<a href="${item.href}" class="${item.key===activeKey?'active':''}">${item.label}</a>`).join("") +
      `</nav>`;
  }
  if(footerMount){
    footerMount.innerHTML = `<div class="footer-note">Faculty Scheduler · signed in as ${escapeHtml(session.email||'')} (${escapeHtml(roleLabel)})</div>`;
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
    await onChange();
  });
}

/* ============================================================
   PAGE BOOT HELPERS
   ============================================================ */

// Call once at the top of every page script. Handles the Identity login
// gate, resolves the signed-in user's role, and renders the shared chrome.
// Returns false (and shows a blocking message) if the account isn't set up
// with a valid role yet.
export async function bootSession(activeKey){
  const user = await requireLogin();
  const role = resolveRole(user);
  session.user = user;
  session.email = user.email;
  session.isRegistrar = role.isRegistrar;
  session.department = role.department;
  session.manageDept = role.isRegistrar ? DEPARTMENTS[0] : role.department;

  if(!session.isRegistrar && !session.department){
    // Note for whoever hits this: if a role was JUST added in Netlify
    // Identity, an already-logged-in browser won't see it until it signs
    // in again — the role list came from the session that was active at
    // login time. The button below forces that by logging out; logging
    // back in re-fetches the current roles from Netlify.
    document.body.innerHTML = `<div class="empty-msg" style="margin:60px auto; max-width:560px; text-align:center;">
      <p>Your account (${escapeHtml(user.email)}) isn't tagged with a department or the registrar role yet.
      Ask the registrar to open Netlify Identity → Users → your account, and add a role of
      <code>registrar</code> or <code>chair-BSIT</code> / <code>chair-BSBA-OM</code> / <code>chair-BEEd</code>.</p>
      <p class="muted" style="font-size:13px;">Already had a role added just now? Your browser is still using the sign-in from before that — log out and back in to pick it up.</p>
      <button class="btn" id="stuckLogoutBtn">Log Out &amp; Try Again</button>
    </div>`;
    document.getElementById('stuckLogoutBtn').addEventListener('click', async function(){
      const ni = await waitForIdentityWidget();
      if(ni){ try{ await ni.logout(); }catch(e){} }
      location.reload();
    });
    return false;
  }
  renderChrome(activeKey);
  lockDownWidgetFrames();
  return true;
}

// For pages that only the registrar may use (Rooms / Assign / Schedule).
// Shows a blocking message and returns false for a chair.
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
