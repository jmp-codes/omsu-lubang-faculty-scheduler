/* ============================================================
   SHARED MODULE — auth/session, state, utilities, scheduling engine,
   API access, and the header/nav "chrome" injected into every page.
   Imported by every page-specific script (faculty.js, subjects.js, …).
   ============================================================ */

/* ============================= CONSTANTS ============================= */
export const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat"];
export const DAY_NAMES = {Mon:"Monday",Tue:"Tuesday",Wed:"Wednesday",Thu:"Thursday",Fri:"Friday",Sat:"Saturday"};
export const DAY_START = 7;   // 7:00 AM
export const DAY_END   = 21;  // 9:00 PM
export const YEAR_LABELS = {1:"1st Year",2:"2nd Year",3:"3rd Year",4:"4th Year",5:"5th Year"};
export const DEPARTMENTS = ["BSIT","BSBA-OM","BEEd"];

export function uid(prefix){ return prefix + "_" + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }

export function defaultState(){
  return {
    faculty: [],     // {id,name,rank,qualifications:[],designations:[],externalBusy:[{id,day,start,duration,label}],department}
    subjects: [],    // {id,code,name,year,units,type,lecHours,labHours,department}
    rooms: [],       // {id,name,type,capacity} — shared/registrar-owned
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

async function requireLogin(){
  const ni = await waitForIdentityWidget();
  if(!ni){
    document.body.innerHTML = `<div class="empty-msg" style="margin:60px auto; max-width:520px;">Couldn't load the sign-in widget (Netlify Identity script). Check your internet connection and reload.</div>`;
    throw new Error("Identity widget unavailable");
  }
  return new Promise((resolve)=>{
    ni.on('init', user=>{ if(user) resolve(user); else ni.open('login'); });
    ni.on('login', user=>{ stopWidgetFixPolling(); ni.close(); resolve(user); });
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

export function candidateStartHours(segType, year){
  const pref = segType==='lecture' ? (state.yearPref[year]||'none') : 'none';
  const all = [];
  for(let h=DAY_START; h<DAY_END; h++) all.push(h);
  if(pref==='morning') return all;
  if(pref==='afternoon') return all.slice().sort((a,b)=>{
    const aAft = a>=13, bAft = b>=13;
    if(aAft && !bAft) return -1;
    if(!aAft && bAft) return 1;
    return a-b;
  });
  return all;
}

export function findRoomFor(subjType, studentCount, day, start, duration, excludeBlockId){
  const roomType = subjType;
  const candidates = state.rooms.filter(r=>r.type===roomType && (!r.capacity || r.capacity>=studentCount))
    .sort((a,b)=> (a.capacity||9999) - (b.capacity||9999));
  for(const room of candidates){
    const conflict = state.schedule.some(b=> b.blockId!==excludeBlockId && b.roomId===room.id && b.day===day && overlaps(b.start,b.duration,start,duration));
    if(!conflict) return room;
  }
  return null;
}

export function tryPlaceSegment(sec, subj, facultyId, segType, hours, warnings){
  const blockId = segmentBlockId(sec.id, subj.id, segType);
  const starts = candidateStartHours(segType, sec.year);
  for(const day of DAYS){
    for(const start of starts){
      if(start+hours > DAY_END) continue;
      const test = {day, start, duration:hours, sectionId:sec.id, facultyId, roomId:null};
      if(hasConflict(test, blockId)) continue;
      const room = findRoomFor(segType, sec.studentCount, day, start, hours, blockId);
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
    let placed = false;
    outer:
    for(const day of DAYS){
      for(const start of starts){
        if(start+hours > DAY_END) continue;
        const usedRooms = new Set();
        const plan = [];
        let ok = true;
        for(const p of readyParts){
          const blockId = segmentBlockId(p.sec.id, subj.id, segType);
          const test = {day, start, duration:hours, sectionId:p.sec.id, facultyId:p.facultyId, roomId:null};
          if(hasConflict(test, blockId)){ ok=false; break; }
          const roomType = segType;
          const room = state.rooms.find(r=> r.type===roomType && (!r.capacity || r.capacity>=p.sec.studentCount) && !usedRooms.has(r.id)
            && !state.schedule.some(b=>b.blockId!==blockId && b.roomId===r.id && b.day===day && overlaps(b.start,b.duration,start,hours)));
          if(!room){ ok=false; break; }
          usedRooms.add(room.id);
          plan.push({p, blockId, room});
        }
        if(ok){
          plan.forEach(({p,blockId,room})=>{
            state.schedule.push({
              blockId, day, start, duration:hours, type:segType,
              sectionId:p.sec.id, sectionName:p.sec.name,
              subjectId: subj.id, subject: subj.code+" — "+subj.name,
              facultyId:p.facultyId, roomId:room.id, roomName:room.name,
              synced:true, manual:false
            });
          });
          placed = true;
          break outer;
        }
      }
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
  const placedIds = new Set(state.schedule.map(b=>b.blockId));
  return expected.filter(e=>!placedIds.has(e.blockId));
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
