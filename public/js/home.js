import {
  state, session, escapeHtml, facultyName, sectionById,
  buildOfferings, dedupeById, DAYS, DAY_NAMES, hourLabel,
  bootSession, loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadSharedData, icon
} from './shared.js';

/* ============================================================
   Per-viewer scoping — a chair sees their own department's slice of
   everything (faculty includes anyone they've linked in via "Link a
   Shared Instructor"); the registrar sees the whole campus. Mirrors the
   same rules schedule.js/rooms.js/assign.js already use elsewhere, kept
   local to this file since Home is the only page that needs ALL of them
   together for one dashboard.
   ============================================================ */
function scopedFaculty(){
  const all = dedupeById(state.faculty);
  return session.isRegistrar ? all : all.filter(f=>f.department===session.department);
}
function scopedSubjects(){
  return session.isRegistrar ? state.subjects : state.subjects.filter(s=>s.department===session.department);
}
function scopedSections(){
  return session.isRegistrar ? state.sections : state.sections.filter(s=>s.department===session.department);
}
function scopedRooms(){
  return session.isRegistrar ? state.rooms : state.rooms.filter(r=>!r.department || r.department===session.department);
}
function scopedOfferings(){
  const all = buildOfferings();
  return session.isRegistrar ? all : all.filter(o=>o.section.department===session.department);
}
function scopedSchedule(){
  // Mirrors schedule.js's blockVisibleToViewer: a chair sees their own
  // department's placed sessions, plus a linked shared instructor's
  // sessions wherever that instructor teaches. The registrar sees
  // everything.
  if(session.isRegistrar) return state.schedule;
  const myFacIds = new Set(state.faculty.filter(f=>f.department===session.department).map(f=>f.id));
  return state.schedule.filter(b=>{
    const sec = sectionById(b.sectionId);
    if(sec && sec.department===session.department) return true;
    return !!(b.facultyId && myFacIds.has(b.facultyId));
  });
}

/* ---- Welcome hero ---- */
function renderHero(){
  const mount = document.getElementById('homeHero');
  if(!mount) return;
  const roleLabel = session.isRegistrar ? 'Registrar' : (session.department ? session.department + ' Program Chair' : '');
  mount.innerHTML = `
    <div class="hero-banner">
      <div class="eyebrow">Welcome back,</div>
      <h2>${escapeHtml(roleLabel)} 👋</h2>
      <div class="sub">Manage faculty, subjects, rooms, and class schedules in one place.</div>
      <div class="hero-tagline">Educate. Empower. Excel.</div>
    </div>
  `;
}

/* ---- Stat tiles ---- */
function renderStatTiles(){
  const mount = document.getElementById('homeStatTiles');
  if(!mount) return;
  const tiles = [
    {href:'faculty.html', icn:'faculty', cls:'c-blue', n:scopedFaculty().length, label:'Faculty',
      sub: session.isRegistrar ? 'faculty members' : `in ${session.department}`},
    {href:'subjects.html', icn:'subjects', cls:'c-gold', n:scopedSubjects().length, label:'Subjects', sub:'subjects'},
    {href:'sections.html', icn:'sections', cls:'c-teal', n:scopedSections().length, label:'Sections', sub:'sections'},
    {href:'rooms.html', icn:'rooms', cls:'c-purple', n:scopedRooms().length, label:'Rooms', sub:'lecture rooms & labs'}
  ];
  mount.innerHTML = tiles.map(t=>`
    <a class="home-card" href="${t.href}">
      <div class="home-card-icon ${t.cls}">${icon(t.icn)}</div>
      <div>
        <div class="d" style="margin-bottom:2px;">${escapeHtml(t.label)}</div>
        <div class="n">${t.n}</div>
        <div class="d">${escapeHtml(t.sub)}</div>
      </div>
    </a>
  `).join('');
}

/* ---- Scheduling status ----
   Four straightforward readiness checks, each counted directly from the
   same data Generate Schedule itself will use — not a reproduction of any
   particular mockup numbers, just an honest X/Y against this department's
   (or, for the registrar, the whole campus's) current data. */
function statusItems(){
  const subs = scopedSubjects();
  const secs = scopedSections();
  const rooms = scopedRooms();
  const offerings = scopedOfferings();
  return [
    {label:'Subjects with units & hours set', x: subs.filter(s=>s.units>0 && ((s.lecHours||0)+(s.labHours||0))>0).length, y: subs.length},
    {label:'Sections configured with subjects', x: secs.filter(s=>(s.subjectIds||[]).length>0).length, y: secs.length},
    {label:'Rooms with capacity set', x: rooms.filter(r=>r.capacity>0).length, y: rooms.length},
    {label:'Instructor assignments complete', x: offerings.filter(o=>o.facultyId).length, y: offerings.length}
  ];
}
function renderSchedulingStatus(){
  const mount = document.getElementById('schedulingStatus');
  if(!mount) return;
  const items = statusItems();
  const totalX = items.reduce((s,i)=>s+i.x,0);
  const totalY = items.reduce((s,i)=>s+i.y,0);
  const pct = totalY===0 ? 0 : Math.round(100*totalX/totalY);
  mount.innerHTML = `
    <div class="status-overall">
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%;"></div></div>
      <div class="status-pct">${pct}% ready</div>
    </div>
    <div class="status-list">
      ${items.map(i=>{
        const ok = i.y>0 && i.x===i.y;
        return `<div class="status-item ${ok?'ok':'warn'}">
          ${icon(ok?'check':'warn')}
          <div class="lbl">${escapeHtml(i.label)}</div>
          <div class="frac">${i.x} / ${i.y}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ---- Weekly schedule preview ----
   This data model has no calendar dates — DAYS is a recurring Mon-Sat
   weekly template, not date-stamped — so unlike a real calendar app there
   is no "this week vs next week" to page through. This shows the
   viewer's next placed sessions in day/time order instead of a full
   mini-grid, with a link to the real (filterable, printable) Weekly
   Schedule on Generate Schedule for anything beyond a quick glance. */
function renderWeeklyPreview(){
  const mount = document.getElementById('weeklyPreview');
  if(!mount) return;
  const blocks = scopedSchedule();
  if(blocks.length===0){
    mount.innerHTML = `<div class="empty-msg">No sessions placed yet. Head to <a href="schedule.html" style="color:var(--gold);">Generate Schedule</a> to create one.</div>`;
    return;
  }
  const sorted = blocks.slice().sort((a,b)=> DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.start-b.start).slice(0,8);
  mount.innerHTML = `<div class="status-list">` + sorted.map(b=>`
    <div class="status-item">
      <div class="lbl">
        <strong>${escapeHtml(b.subject)}</strong>
        <div class="muted" style="font-size:12px;">${escapeHtml(b.sectionName)} · ${escapeHtml(facultyName(b.facultyId))} · ${escapeHtml(b.roomName)}</div>
      </div>
      <div class="frac">${DAY_NAMES[b.day]} · ${hourLabel(b.start)}</div>
    </div>
  `).join('') + `</div>
  <div class="row" style="justify-content:flex-end; margin-top:12px;">
    <a class="btn btn-sm" href="schedule.html">View Full Schedule</a>
  </div>`;
}

/* ---- Quick actions ---- */
function renderQuickActions(){
  const mount = document.getElementById('quickActions');
  if(!mount) return;
  const actions = [
    {href:'schedule.html', icn:'schedule', label:'Generate Schedule', primary:true},
    {href:'faculty.html', icn:'faculty', label:'Add Faculty'},
    {href:'subjects.html', icn:'subjects', label:'Import Subjects'},
    {href:'rooms.html', icn:'rooms', label:'Manage Rooms'},
    {href:'assign.html', icn:'assign', label:'Assign Instructors'}
  ];
  mount.innerHTML = `<div class="quick-actions">` + actions.map(a=>`
    <a class="${a.primary?'primary':''}" href="${a.href}">
      ${icon(a.icn)}<span>${escapeHtml(a.label)}</span>${icon('chevron','chev')}
    </a>
  `).join('') + `</div>`;
}

function renderAll(){
  renderHero();
  renderStatTiles();
  renderSchedulingStatus();
  renderWeeklyPreview();
  renderQuickActions();
}

(async function boot(){
  const ok = await bootSession('home');
  if(!ok) return;
  await loadFacultyAll();
  await loadSubjectsAll();
  await loadSectionsAll();
  // Scheduling Status and the Weekly Schedule Preview need state.schedule
  // for every role now, not just the registrar — the old Home page only
  // ever loaded it when session.isRegistrar was true.
  await loadSharedData();
  renderAll();
})();
