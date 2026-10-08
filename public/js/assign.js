import {
  state, el, escapeHtml, icon, assignKey, YEAR_LABELS, describeAvailability, session,
  bootSession, loadFaculty, loadSubjects, loadSections,
  loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadFacultyDirectory,
  loadSharedData, persistSharedData
} from './shared.js';

// Tracks year-level groups the user has manually expanded. Renders
// collapsed by default — same reasoning and pattern as Subjects/Sections —
// and a bulk assignment (which re-renders the whole tab) keeps whatever a
// user has opened or closed open instead of silently resetting it.
const openedYears = new Set();
let facultyDeptById = {};
// Lets a chair pick an existing faculty member from another department by
// name+department instead of re-typing them as a new record (see boot()).
function facOptionLabel(f){
  const dept = facultyDeptById[f.id];
  const myDept = session.manageDept || session.department;
  const avail = describeAvailability(f);
  let label = escapeHtml(f.name);
  // Only call out the department when it differs from the one being
  // managed here — a chair's own faculty would otherwise all show a
  // redundant "(BSIT)" next to every single name.
  if(dept && dept!==myDept) label += ' ('+escapeHtml(dept)+')';
  if(avail) label += ' — ' + escapeHtml(avail);
  return label;
}

// Icon stat tiles mirroring the Home dashboard's .home-card style — counts
// every section/subject pair that needs an instructor (the same pairs
// renderAssignTab() below builds rows for), how many already have one, and
// the completion rate.
function assignStats(){
  let total = 0, assigned = 0;
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      total++;
      if(state.assignments[assignKey(sec.id, subjId)]) assigned++;
    });
  });
  return { total, assigned, unassigned: total - assigned, pct: total ? Math.round(100*assigned/total) : 0 };
}
function renderAssignStats(){
  const mount = document.getElementById('assignStatTiles');
  if(!mount) return;
  const s = assignStats();
  const tiles = [
    {icn:'assign', cls:'c-blue', n:s.total, label:'Total Assignments', sub:'section–subject pairs'},
    {icn:'check', cls:'c-teal', n:s.assigned, label:'Assigned', sub:'instructor set'},
    {icn:'warn', cls:'c-gold', n:s.unassigned, label:'Unassigned', sub:'needs an instructor'},
    {icn:'calendarCheck', cls:'c-purple', n:s.pct+'%', label:'Completion Rate', sub:'of all assignments'}
  ];
  mount.innerHTML = tiles.map(t=>'<div class="home-card static-card">'
    + '<div class="home-card-icon '+t.cls+'">'+icon(t.icn)+'</div>'
    + '<div>'
    + '<div class="d" style="margin-bottom:2px;">'+escapeHtml(t.label)+'</div>'
    + '<div class="n">'+t.n+'</div>'
    + '<div class="d">'+escapeHtml(t.sub)+'</div>'
    + '</div>'
    + '</div>').join('');
}

function renderAssignTab(){
  renderAssignStats();
  const wrap = document.getElementById('assignGroups');
  wrap.innerHTML = "";
  const bySubject = {};
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      (bySubject[subjId] = bySubject[subjId]||[]).push(sec);
    });
  });
  const subjectIds = Object.keys(bySubject);
  document.getElementById('assignEmpty').classList.toggle('hidden', subjectIds.length>0);
  const orderedSubjects = state.subjects.filter(s=>bySubject[s.id]);

  const byYear = {};
  orderedSubjects.forEach(s=>{ (byYear[s.year] = byYear[s.year]||[]).push(s); });

  Object.keys(byYear).sort((a,b)=>a-b).forEach(year=>{
    const subjectsForYear = byYear[year].slice().sort((a,b)=> a.code.localeCompare(b.code));
    const isOpen = openedYears.has(year);
    let yearAssigned = 0, yearTotal = 0;
    subjectsForYear.forEach(s=>{
      bySubject[s.id].forEach(sec=>{
        yearTotal++;
        if(state.assignments[assignKey(sec.id, s.id)]) yearAssigned++;
      });
    });
    const yearUnassigned = yearTotal - yearAssigned;
    const det = el(`<details class="group"${isOpen?' open':''}><summary><span>${YEAR_LABELS[year]||('Year '+year)} <span class="count">${subjectsForYear.length} subject${subjectsForYear.length===1?'':'s'}</span></span><span class="row" style="flex:none; gap:6px;"><span class="badge badge-lecture">${yearAssigned} assigned</span>${yearUnassigned ? '<span class="badge badge-danger">'+yearUnassigned+' unassigned</span>' : ''}</span></summary><div class="group-body"></div></details>`);
    det.addEventListener('toggle', function(){
      if(det.open) openedYears.add(year);
      else openedYears.delete(year);
    });
    const body = det.querySelector('.group-body');

    subjectsForYear.forEach(subj=>{
      const sections = bySubject[subj.id];
      const block = el(`<div class="subject-offer-block">
        <div class="offer-header">
          <div><strong>${escapeHtml(subj.code)}</strong> — ${escapeHtml(subj.name)} <span class="badge ${subj.type==='lab'?'badge-lab':'badge-lecture'}">${subj.type==='lab'?'Laboratory':'Lecture'}</span> ${subj.department?`<span class="muted" style="font-size:11px;">${escapeHtml(subj.department)}</span>`:''}</div>
          <div class="row">
            <span class="muted" style="font-size:12px;">Assign same instructor to all sections below:</span>
            <select class="bulkAssign" data-subj="${subj.id}" style="min-width:180px;">
              <option value="">— choose faculty —</option>
              ${state.faculty.map(f=>`<option value="${f.id}">${facOptionLabel(f)}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="offer-rows"></div>
      </div>`);
      const rows = block.querySelector('.offer-rows');
      sections.forEach(sec=>{
        const currentFac = state.assignments[assignKey(sec.id, subj.id)] || "";
        const row = el(`<div class="assign-row">
          <div>${escapeHtml(sec.name)} <span class="muted" style="font-size:12px;">(${sec.studentCount} students)</span></div>
          <select class="indivAssign" data-sec="${sec.id}" data-subj="${subj.id}" style="min-width:180px;">
            <option value="">— unassigned —</option>
            ${state.faculty.map(f=>`<option value="${f.id}" ${f.id===currentFac?'selected':''}>${facOptionLabel(f)}</option>`).join("")}
          </select>
        </div>`);
        rows.appendChild(row);
      });
      body.appendChild(block);
    });

    wrap.appendChild(det);
  });
}
document.getElementById('assignGroups').addEventListener('change', function(e){
  if(e.target.classList.contains('bulkAssign')){
    const subjId = e.target.dataset.subj;
    const facId = e.target.value;
    if(!facId) return;
    state.sections.filter(sec=>sec.subjectIds.includes(subjId)).forEach(sec=>{
      state.assignments[assignKey(sec.id, subjId)] = facId;
    });
    persistSharedData();
    renderAssignTab();
  }
  if(e.target.classList.contains('indivAssign')){
    const key = assignKey(e.target.dataset.sec, e.target.dataset.subj);
    if(e.target.value) state.assignments[key] = e.target.value;
    else delete state.assignments[key];
    persistSharedData();
  }
});

(async function boot(){
  const ok = await bootSession('assign');
  if(!ok) return;
  // The registrar still manages the whole campus here in one merged view
  // (unchanged). A chair only sees their own department's sections/
  // subjects/faculty — plus any instructor they've linked in from another
  // department on the Faculty page — so they can no longer assign another
  // department's instructor to another department's section.
  const facultyLoader = session.isRegistrar ? loadFacultyAll : loadFaculty;
  const subjectsLoader = session.isRegistrar ? loadSubjectsAll : loadSubjects;
  const sectionsLoader = session.isRegistrar ? loadSectionsAll : loadSections;
  const [, , , , directory] = await Promise.all([facultyLoader(), subjectsLoader(), sectionsLoader(), loadSharedData(), loadFacultyDirectory()]);
  facultyDeptById = {};
  (directory||[]).forEach(f=>{ facultyDeptById[f.id] = f.department; });
  renderAssignTab();
})();
