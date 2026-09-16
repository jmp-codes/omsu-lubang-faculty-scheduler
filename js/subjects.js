import {
  state, uid, el, escapeHtml, subjectById, YEAR_LABELS, parseDelimitedText,
  bootSession, wireDeptBar, loadSubjects, persistSubjects, loadSections, saveSections
} from './shared.js';

let editingSubjectId = null;
const SEMESTER_LABELS = {'1st':'1st Sem', '2nd':'2nd Sem', 'summer':'Summer', 'both':'Both Sems'};

// Tracks year-level groups the user has manually collapsed. renderSubjectsGroups()
// rebuilds every group from scratch after almost every action (edit/archive/
// delete a subject, toggle "show archived", etc.), so without this a full
// re-render would silently re-expand every group back open each time. A
// year that isn't in this set renders open — and a year is explicitly
// un-collapsed (see below) whenever a subject is added or edited into it,
// so the newly added/changed row is immediately visible even if that
// year's group was previously shut.
const collapsedYears = new Set();

// Keeps the Curriculum field's suggestion list in sync with whatever
// curriculum names are already in use, so the registrar/chair can reuse an
// existing one (e.g. "2024 Curriculum") by picking it instead of retyping
// it — while still being free text, so a brand-new curriculum name works too.
function refreshCurriculumOptions(){
  const list = document.getElementById('subjCurriculumList');
  const names = Array.from(new Set(state.subjects.map(s=>s.curriculum).filter(Boolean))).sort();
  list.innerHTML = names.map(n=>`<option value="${escapeHtml(n)}"></option>`).join("");
}

document.getElementById('subjType').addEventListener('change', function(){
  const isLab = this.value === 'lab';
  document.getElementById('subjLabHoursField').style.display = isLab ? '' : 'none';
  if(isLab){
    document.getElementById('subjLecHours').value = document.getElementById('subjLecHours').value || 2;
    document.getElementById('subjLabHours').value = document.getElementById('subjLabHours').value || 3;
  }
});

function renderSubjectsGroups(){
  const wrap = document.getElementById('subjectsGroups');
  wrap.innerHTML = "";
  document.getElementById('subjectsEmpty').classList.toggle('hidden', state.subjects.length>0);
  const showArchived = document.getElementById('subjShowArchived').checked;
  const visible = state.subjects.filter(s=> showArchived || !s.archived);
  refreshCurriculumOptions();
  const byYear = {};
  visible.forEach(s=>{ (byYear[s.year] = byYear[s.year]||[]).push(s); });
  Object.keys(byYear).sort((a,b)=>a-b).forEach(year=>{
    const list = byYear[year].sort((a,b)=>a.code.localeCompare(b.code));
    const isOpen = !collapsedYears.has(year);
    const det = el(`<details class="group"${isOpen?' open':''}><summary>${YEAR_LABELS[year]||('Year '+year)} <span class="count">${list.length} subject${list.length===1?'':'s'}</span></summary><div class="group-body"></div></details>`);
    // Remembers this group's open/closed state across the next re-render
    // (see collapsedYears above) instead of always snapping back open.
    det.addEventListener('toggle', function(){
      if(det.open) collapsedYears.delete(year);
      else collapsedYears.add(year);
    });
    const body = det.querySelector('.group-body');
    const table = el(`<table><thead><tr><th>Code</th><th>Name</th><th>Curriculum</th><th>Semester</th><th>Units</th><th>Type</th><th>Hours</th><th style="width:160px;">Actions</th></tr></thead><tbody></tbody></table>`);
    const tbody = table.querySelector('tbody');
    list.forEach(s=>{
      const hoursTxt = s.type==='lab' ? `Lec ${s.lecHours}h + Lab ${s.labHours}h` : `${s.lecHours}h`;
      const tr = el(`<tr${s.archived?' style="opacity:0.55;"':''}>
        <td><strong>${escapeHtml(s.code)}</strong></td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.curriculum||'')}${s.archived?' <span class="badge badge-muted" style="margin-left:4px;">Archived</span>':''}</td>
        <td>${SEMESTER_LABELS[s.semester]||'—'}</td>
        <td>${s.units}</td>
        <td><span class="badge ${s.type==='lab'?'badge-lab':'badge-lecture'}">${s.type==='lab'?'Laboratory':'Lecture'}</span></td>
        <td>${hoursTxt}</td>
        <td>
          <button class="btn btn-sm editSubj" data-id="${s.id}">Edit</button>
          <button class="btn btn-sm archiveSubj" data-id="${s.id}">${s.archived?'Unarchive':'Archive'}</button>
          <button class="btn btn-sm btn-danger delSubj" data-id="${s.id}">Delete</button>
        </td>
      </tr>`);
      tbody.appendChild(tr);
    });
    body.appendChild(table);
    wrap.appendChild(det);
  });
}
document.getElementById('subjShowArchived').addEventListener('change', renderSubjectsGroups);

document.getElementById('subjectsGroups').addEventListener('click', async function(e){
  const editBtn = e.target.closest('.editSubj');
  const delBtn = e.target.closest('.delSubj');
  const archiveBtn = e.target.closest('.archiveSubj');
  if(editBtn) startEditSubject(editBtn.dataset.id);
  if(archiveBtn){
    const s = subjectById(archiveBtn.dataset.id);
    if(s){
      s.archived = !s.archived;
      persistSubjects();
      renderSubjectsGroups();
    }
  }
  if(delBtn){
    if(confirm("Delete this subject? It will be removed from any of this department's sections that reference it.")){
      const subjId = delBtn.dataset.id;
      state.subjects = state.subjects.filter(s=>s.id!==subjId);
      persistSubjects();
      renderSubjectsGroups();
      // Best-effort cleanup: strip this subject from this department's
      // sections too, so it doesn't linger as an orphaned reference.
      try{
        const savedSubjects = state.subjects; // loadSections() only touches state.sections
        await loadSections();
        const before = state.sections;
        let touched = false;
        state.sections = before.map(sec=>{
          if(!sec.subjectIds.includes(subjId)) return sec;
          touched = true;
          return { ...sec, subjectIds: sec.subjectIds.filter(id=>id!==subjId) };
        });
        if(touched) await saveSections();
        state.subjects = savedSubjects;
      }catch(err){
        console.warn("Could not clean up sections after subject delete:", err);
      }
    }
  }
});

function startEditSubject(id){
  const s = subjectById(id);
  if(!s) return;
  editingSubjectId = id;
  document.getElementById('subjCode').value = s.code;
  document.getElementById('subjName').value = s.name;
  document.getElementById('subjYear').value = s.year;
  document.getElementById('subjUnits').value = s.units;
  document.getElementById('subjType').value = s.type;
  document.getElementById('subjLecHours').value = s.lecHours;
  document.getElementById('subjLabHours').value = s.labHours||3;
  document.getElementById('subjLabHoursField').style.display = s.type==='lab' ? '' : 'none';
  document.getElementById('subjSemester').value = s.semester||'1st';
  document.getElementById('subjCurriculum').value = s.curriculum||'';
  document.getElementById('subjFormTitle').textContent = "Edit Subject";
  document.getElementById('subjSaveBtn').textContent = "Save Changes";
  document.getElementById('subjCancelBtn').style.display = '';
  window.scrollTo({top:0, behavior:'smooth'});
}
function resetSubjectForm(){
  editingSubjectId = null;
  document.getElementById('subjCode').value='';
  document.getElementById('subjName').value='';
  document.getElementById('subjYear').value='1';
  document.getElementById('subjUnits').value='3';
  document.getElementById('subjType').value='lecture';
  document.getElementById('subjLecHours').value='3';
  document.getElementById('subjLabHours').value='3';
  document.getElementById('subjLabHoursField').style.display='none';
  document.getElementById('subjSemester').value='1st';
  document.getElementById('subjCurriculum').value='';
  document.getElementById('subjFormTitle').textContent = "Add Subject";
  document.getElementById('subjSaveBtn').textContent = "Add Subject";
  document.getElementById('subjCancelBtn').style.display = 'none';
}
document.getElementById('subjCancelBtn').addEventListener('click', resetSubjectForm);
document.getElementById('subjSaveBtn').addEventListener('click', function(){
  const code = document.getElementById('subjCode').value.trim();
  const name = document.getElementById('subjName').value.trim();
  if(!code || !name){ alert("Please enter both subject code and name."); return; }
  const year = parseInt(document.getElementById('subjYear').value,10);
  const units = parseFloat(document.getElementById('subjUnits').value)||0;
  const type = document.getElementById('subjType').value;
  const lecHours = parseFloat(document.getElementById('subjLecHours').value)||0;
  const labHours = type==='lab' ? (parseFloat(document.getElementById('subjLabHours').value)||0) : 0;
  const semester = document.getElementById('subjSemester').value;
  const curriculum = document.getElementById('subjCurriculum').value.trim();
  if(editingSubjectId){
    Object.assign(subjectById(editingSubjectId), {code,name,year,units,type,lecHours,labHours,semester,curriculum});
  } else {
    state.subjects.push({id: uid('subj'), code, name, year, units, type, lecHours, labHours, semester, curriculum, archived:false});
  }
  // Make sure the year this subject now belongs to is expanded, even if
  // that group was previously collapsed — otherwise the add/edit you just
  // made wouldn't visibly show up.
  collapsedYears.delete(String(year));
  persistSubjects();
  resetSubjectForm();
  renderSubjectsGroups();
});

document.getElementById('subjBulkImportBtn').addEventListener('click', function(){
  const text = document.getElementById('subjBulkText').value;
  if(!text.trim()){ alert("Paste some rows first."); return; }
  const rows = parseDelimitedText(text);
  let count = 0;
  rows.forEach(cols=>{
    const code = (cols[0]||'').trim();
    const name = (cols[1]||'').trim();
    if(!code || !name) return;
    const year = parseInt(cols[2],10) || 1;
    const units = parseFloat(cols[3]) || 0;
    const type = (cols[4]||'').trim().toLowerCase() === 'lab' ? 'lab' : 'lecture';
    const lecHours = parseFloat(cols[5]) || 0;
    const labHours = type==='lab' ? (parseFloat(cols[6]) || 0) : 0;
    const semRaw = (cols[7]||'').trim().toLowerCase();
    const semester = SEMESTER_LABELS[semRaw] ? semRaw : '1st';
    const curriculum = (cols[8]||'').trim();
    state.subjects.push({id: uid('subj'), code, name, year, units, type, lecHours, labHours, semester, curriculum, archived:false});
    collapsedYears.delete(String(year)); // expand any year group these rows land in, even if it was collapsed
    count++;
  });
  persistSubjects();
  document.getElementById('subjBulkText').value = '';
  renderSubjectsGroups();
  alert(count + " subject" + (count===1?"":"s") + " imported.");
});

async function reload(){
  await loadSubjects();
  renderSubjectsGroups();
}

(async function boot(){
  const ok = await bootSession('subjects');
  if(!ok) return;
  wireDeptBar(reload);
  await reload();
})();
