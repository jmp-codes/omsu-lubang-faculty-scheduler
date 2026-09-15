import {
  state, el, escapeHtml, assignKey, YEAR_LABELS,
  bootSession, requireRegistrar, loadFacultyAll, loadSubjectsAll, loadSectionsAll,
  loadSharedData, persistSharedData
} from './shared.js';

function renderAssignTab(){
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
  orderedSubjects.forEach(subj=>{
    const sections = bySubject[subj.id];
    const block = el(`<div class="subject-offer-block">
      <div class="offer-header">
        <div><strong>${escapeHtml(subj.code)}</strong> — ${escapeHtml(subj.name)} <span class="pill-year">${YEAR_LABELS[subj.year]}</span> <span class="badge ${subj.type==='lab'?'badge-lab':'badge-lecture'}">${subj.type==='lab'?'Laboratory':'Lecture'}</span> ${subj.department?`<span class="muted" style="font-size:11px;">${escapeHtml(subj.department)}</span>`:''}</div>
        <div class="row">
          <span class="muted" style="font-size:12px;">Assign same instructor to all sections below:</span>
          <select class="bulkAssign" data-subj="${subj.id}" style="min-width:180px;">
            <option value="">— choose faculty —</option>
            ${state.faculty.map(f=>`<option value="${f.id}">${escapeHtml(f.name)}</option>`).join("")}
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
          ${state.faculty.map(f=>`<option value="${f.id}" ${f.id===currentFac?'selected':''}>${escapeHtml(f.name)}</option>`).join("")}
        </select>
      </div>`);
      rows.appendChild(row);
    });
    wrap.appendChild(block);
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
  if(!requireRegistrar()) return;
  await Promise.all([loadFacultyAll(), loadSubjectsAll(), loadSectionsAll(), loadSharedData()]);
  renderAssignTab();
})();
