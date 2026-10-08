import {
  state, el, escapeHtml, icon, assignKey, YEAR_LABELS, describeAvailability, session,
  bootSession, renderPageTitle, loadFaculty, loadSubjects, loadSections,
  loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadFacultyDirectory,
  loadSharedData, persistSharedData
} from './shared.js';

// Tracks year-level groups the user has manually expanded. Renders
// collapsed by default — same reasoning and pattern as Subjects/Sections —
// and a bulk assignment (which re-renders the whole tab) keeps whatever a
// user has opened or closed open instead of silently resetting it.
const openedYears = new Set();
// Tracks which subjects have their per-section override sub-row expanded
// (only subjects with more than one section ever show the toggle).
const openedSections = new Set();
let facultyDeptById = {};
let assignSearchQuery = '';
let assignFilterType = '';
let assignFilterStatus = '';

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
// Just the faculty <option> tags, no leading "— unassigned —" option —
// used for the "mixed" dropdown state, where there is no single current
// value to show as unassigned.
function facOptionsOnly(selectedId){
  return state.faculty.map(f=>`<option value="${f.id}" ${f.id===selectedId?'selected':''}>${facOptionLabel(f)}</option>`).join("");
}
function facultyOptionsHtml(selectedId){
  return `<option value="">— unassigned —</option>` + facOptionsOnly(selectedId);
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

  const q = assignSearchQuery.trim().toLowerCase();
  const allOffered = state.subjects.filter(s=>bySubject[s.id]);
  const orderedSubjects = allOffered.filter(s=>{
    if(q && !(s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))) return false;
    if(assignFilterType && s.type!==assignFilterType) return false;
    if(assignFilterStatus){
      const secs = bySubject[s.id];
      const allAssigned = secs.every(sec=>state.assignments[assignKey(sec.id, s.id)]);
      if(assignFilterStatus==='assigned' && !allAssigned) return false;
      if(assignFilterStatus==='unassigned' && allAssigned) return false;
    }
    return true;
  });
  const searchEmpty = document.getElementById('assignSearchEmpty');
  if(searchEmpty) searchEmpty.classList.toggle('hidden', !((q || assignFilterType || assignFilterStatus) && orderedSubjects.length===0 && allOffered.length>0));

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

    const table = el(`<table><thead><tr>
      <th>Subject Code</th><th>Subject Name</th><th>Type</th><th>Sections</th><th style="min-width:200px;">Default Instructor</th><th style="width:70px;">Actions</th>
    </tr></thead><tbody></tbody></table>`);
    const tbody = table.querySelector('tbody');

    subjectsForYear.forEach(subj=>{
      const sections = bySubject[subj.id];
      const assignedIds = sections.map(sec=>state.assignments[assignKey(sec.id, subj.id)] || "");
      const allSame = assignedIds.every(id=>id===assignedIds[0]);
      const sectionsOpen = openedSections.has(subj.id);
      const row = el(`<tr>
        <td><strong>${escapeHtml(subj.code)}</strong></td>
        <td>${escapeHtml(subj.name)}</td>
        <td><span class="badge ${subj.type==='lab'?'badge-lab':'badge-lecture'}">${subj.type==='lab'?'Laboratory':'Lecture'}</span></td>
        <td>
          ${sections.map(sec=>`<span class="chip" style="cursor:default;">${escapeHtml(sec.name)}</span>`).join('')}
          ${sections.length>1 ? `<button type="button" class="btn btn-sm secToggleBtn${sectionsOpen?' expanded':''}" data-subj="${subj.id}" title="Set a different instructor per section">${icon('chevron')}</button>` : ''}
        </td>
        <td>
          <select class="bulkAssign" data-subj="${subj.id}">
            ${allSame ? facultyOptionsHtml(assignedIds[0]) : `<option value="" disabled selected>— mixed, see sections —</option>` + facOptionsOnly('')}
          </select>
        </td>
        <td><button type="button" class="btn btn-sm btn-danger clearSubjBtn" data-subj="${subj.id}" title="Clear every instructor assigned to this subject">${icon('clear')}</button></td>
      </tr>`);
      tbody.appendChild(row);

      if(sections.length>1){
        const subRow = el(`<tr class="secExpandRow${sectionsOpen?'':' hidden'}" data-subj-expand="${subj.id}">
          <td colspan="6">
            <div style="display:flex; flex-direction:column; gap:6px;">
              ${sections.map(sec=>{
                const currentFac = state.assignments[assignKey(sec.id, subj.id)] || "";
                return `<div class="assign-row">
                  <div>${escapeHtml(sec.name)} <span class="muted" style="font-size:12px;">(${sec.studentCount} students)</span></div>
                  <select class="indivAssign" data-sec="${sec.id}" data-subj="${subj.id}" style="min-width:200px;">
                    ${facultyOptionsHtml(currentFac)}
                  </select>
                </div>`;
              }).join('')}
            </div>
          </td>
        </tr>`);
        tbody.appendChild(subRow);
      }
    });
    table.appendChild(tbody);
    body.appendChild(table);

    wrap.appendChild(det);
  });
}

document.getElementById('assignGroups').addEventListener('click', function(e){
  const toggleBtn = e.target.closest('.secToggleBtn');
  if(toggleBtn){
    const subjId = toggleBtn.dataset.subj;
    if(openedSections.has(subjId)) openedSections.delete(subjId);
    else openedSections.add(subjId);
    renderAssignTab();
    return;
  }
  const clearBtn = e.target.closest('.clearSubjBtn');
  if(clearBtn){
    const subjId = clearBtn.dataset.subj;
    state.sections.filter(sec=>sec.subjectIds.includes(subjId)).forEach(sec=>{
      delete state.assignments[assignKey(sec.id, subjId)];
    });
    persistSharedData();
    renderAssignTab();
    return;
  }
});
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
    renderAssignTab();
  }
});

document.getElementById('assignSearchInput').addEventListener('input', function(e){
  assignSearchQuery = e.target.value;
  renderAssignTab();
});
document.getElementById('assignFiltersBtn').addEventListener('click', function(){
  document.getElementById('assignFiltersBar').classList.toggle('hidden');
});
document.getElementById('assignFilterType').addEventListener('change', function(e){
  assignFilterType = e.target.value;
  renderAssignTab();
});
document.getElementById('assignFilterStatus').addEventListener('change', function(e){
  assignFilterStatus = e.target.value;
  renderAssignTab();
});

(async function boot(){
  const ok = await bootSession('assign');
  if(!ok) return;
  renderPageTitle('Assign Instructors', [{label:'Home', href:'index.html'}, {label:'Assign Instructors'}]);
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
