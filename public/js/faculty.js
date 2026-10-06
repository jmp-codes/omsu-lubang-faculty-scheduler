import {
  state, uid, el, escapeHtml, timeRangeLabel, byId,
  DAYS, DAY_START, DAY_END, hourLabel, parseDelimitedText,
  bootSession, wireDeptBar, loadFaculty, persistFaculty,
  session, loadFacultyDirectory
} from './shared.js';

let editingFacultyId = null;
const facultyExtOpen = {};

// Loose name-normalization for duplicate detection: case/whitespace/
// punctuation insensitive. Not meant to be bulletproof — just enough to
// flag the common "same person, entered again under another department"
// case for a human to actually decide on (see facSaveBtn/facBulkImportBtn
// below). A false positive just means an extra confirm() the registrar
// dismisses; a false negative just means no warning, same as today.
function normalizeName(s){
  return String(s||'').toLowerCase().replace(/[.,]/g,'').replace(/\s+/g,' ').trim();
}
function namesLikelyMatch(a,b){
  const na = normalizeName(a), nb = normalizeName(b);
  if(!na || !nb) return false;
  if(na === nb) return true;
  // Catches "Juan Dela Cruz" vs "Juan Dela Cruz Jr." style near-matches —
  // guarded by a minimum length so short names don't trigger on substring
  // coincidence (e.g. "Ann" inside "Anna").
  if(na.length>=6 && nb.length>=6 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}
// Finds a same-name faculty member in a DIFFERENT department than the one
// currently being edited (state.faculty is already scoped to the current
// department, so within-department dupes aren't this check's concern).
function findCrossDeptDuplicate(directory, name){
  const currentDept = session.manageDept || session.department;
  return directory.find(f=> f.department!==currentDept && namesLikelyMatch(f.name, name));
}

function hourOptions(){
  let opts = "";
  for(let h=DAY_START; h<DAY_END; h+=0.5){ opts += `<option value="${h}">${hourLabel(h)}</option>`; }
  return opts;
}

function renderExternalPanel(facId){
  const panel = document.getElementById('extPanel_'+facId);
  if(!panel) return;
  const f = byId(state.faculty, facId);
  if(!f) return;
  const list = (f.externalBusy||[]).map(b=>`
    <div class="chip">${b.day} ${timeRangeLabel(b.start,b.duration)} — ${escapeHtml(b.label||'External')}
      <button data-fac="${facId}" data-block="${b.id}" class="rmExtBusy" title="Remove">✕</button>
    </div>`).join("");
  panel.innerHTML = `
    <div>${list}</div>
    <div class="row" style="margin-top:6px;">
      <select class="extDay" data-fac="${facId}" style="width:80px;">${DAYS.map(d=>`<option value="${d}">${d}</option>`).join("")}</select>
      <select class="extStart" data-fac="${facId}" style="width:110px;">${hourOptions()}</select>
      <select class="extDur" data-fac="${facId}" style="width:90px;">
        ${[0.5,1,1.5,2,2.5,3,3.5,4].map(h=>`<option value="${h}">${h} hr${h===1?'':'s'}</option>`).join("")}
      </select>
      <input type="text" class="extLabel" data-fac="${facId}" placeholder="e.g. College of Engineering" style="flex:1; min-width:140px;">
      <button class="btn btn-sm btn-teal addExtBusy" data-fac="${facId}">Add</button>
    </div>
  `;
}

function renderFacultyTable(){
  const tbody = document.getElementById('facultyTableBody');
  tbody.innerHTML = "";
  document.getElementById('facultyEmpty').classList.toggle('hidden', state.faculty.length>0);
  state.faculty.forEach(f=>{
    const tr = document.createElement('tr');
    const qualsHtml = (f.qualifications||[]).map(q=>escapeHtml(q)).join("<br>") || "<span class='muted'>—</span>";
    const desigsHtml = (f.designations||[]).map(d=>escapeHtml(d)).join("<br>") || "<span class='muted'>—</span>";
    const extCount = (f.externalBusy||[]).length;
    tr.innerHTML = `
      <td><strong>${escapeHtml(f.name)}</strong></td>
      <td>${escapeHtml(f.rank||"")}</td>
      <td style="font-size:12.5px;">${qualsHtml}</td>
      <td style="font-size:12.5px;">${desigsHtml}</td>
      <td>
        <div class="toggle-row">
          <label class="switch"><input type="checkbox" class="extToggle" data-id="${f.id}" ${extCount||facultyExtOpen[f.id]?'checked':''}><span class="slider"></span></label>
          <span class="muted" style="font-size:12px;">${extCount} block${extCount===1?'':'s'}</span>
        </div>
        <div class="ext-panel" id="extPanel_${f.id}" style="${(extCount||facultyExtOpen[f.id])?'':'display:none;'} margin-top:8px;"></div>
      </td>
      <td>
        <button class="btn btn-sm editFac" data-id="${f.id}">Edit</button>
        <button class="btn btn-sm btn-danger delFac" data-id="${f.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
    if(extCount || facultyExtOpen[f.id]) renderExternalPanel(f.id);
  });
}

document.getElementById('facultyTableBody').addEventListener('click', function(e){
  const editBtn = e.target.closest('.editFac');
  const delBtn = e.target.closest('.delFac');
  const addExt = e.target.closest('.addExtBusy');
  const rmExt = e.target.closest('.rmExtBusy');
  if(editBtn){ startEditFaculty(editBtn.dataset.id); }
  if(delBtn){
    if(confirm("Delete this faculty member? If they're already assigned to a section/subject or placed in the schedule, ask the registrar to update or clear that on the Assign Instructors page afterward.")){
      state.faculty = state.faculty.filter(f=>f.id!==delBtn.dataset.id);
      persistFaculty(); renderFacultyTable();
    }
  }
  if(addExt){
    const facId = addExt.dataset.fac;
    const day = document.querySelector(`.extDay[data-fac="${facId}"]`).value;
    const start = parseFloat(document.querySelector(`.extStart[data-fac="${facId}"]`).value);
    const duration = parseFloat(document.querySelector(`.extDur[data-fac="${facId}"]`).value);
    const label = document.querySelector(`.extLabel[data-fac="${facId}"]`).value.trim();
    const f = byId(state.faculty, facId);
    f.externalBusy = f.externalBusy || [];
    f.externalBusy.push({id: uid('ext'), day, start, duration, label: label||"External commitment"});
    facultyExtOpen[facId] = true;
    persistFaculty(); renderFacultyTable();
  }
  if(rmExt){
    const f = byId(state.faculty, rmExt.dataset.fac);
    f.externalBusy = (f.externalBusy||[]).filter(b=>b.id!==rmExt.dataset.block);
    persistFaculty(); renderFacultyTable();
  }
});

document.getElementById('facultyTableBody').addEventListener('change', function(e){
  if(e.target.classList.contains('extToggle')){
    const id = e.target.dataset.id;
    facultyExtOpen[id] = e.target.checked;
    const panel = document.getElementById('extPanel_'+id);
    if(panel) panel.style.display = e.target.checked ? '' : 'none';
    if(e.target.checked) renderExternalPanel(id);
  }
});

function startEditFaculty(id){
  const f = byId(state.faculty,id);
  if(!f) return;
  editingFacultyId = id;
  document.getElementById('facName').value = f.name;
  document.getElementById('facRank').value = f.rank;
  document.getElementById('facQuals').value = (f.qualifications||[]).join("\n");
  document.getElementById('facDesigs').value = (f.designations||[]).join("\n");
  document.getElementById('facultyFormTitle').textContent = "Edit Faculty";
  document.getElementById('facSaveBtn').textContent = "Save Changes";
  document.getElementById('facCancelBtn').style.display = '';
  window.scrollTo({top:0, behavior:'smooth'});
}
function resetFacultyForm(){
  editingFacultyId = null;
  document.getElementById('facName').value = '';
  document.getElementById('facRank').value = 'Instructor I';
  document.getElementById('facQuals').value = '';
  document.getElementById('facDesigs').value = '';
  document.getElementById('facultyFormTitle').textContent = "Add Faculty";
  document.getElementById('facSaveBtn').textContent = "Add Faculty";
  document.getElementById('facCancelBtn').style.display = 'none';
}
document.getElementById('facCancelBtn').addEventListener('click', resetFacultyForm);
document.getElementById('facSaveBtn').addEventListener('click', async function(){
  const name = document.getElementById('facName').value.trim();
  if(!name){ alert("Please enter the faculty name."); return; }
  const rank = document.getElementById('facRank').value;
  const qualifications = document.getElementById('facQuals').value.split("\n").map(s=>s.trim()).filter(Boolean);
  const designations = document.getElementById('facDesigs').value.split("\n").map(s=>s.trim()).filter(Boolean);

  if(!editingFacultyId){
    // Only worth checking when ADDING someone new — renaming an existing
    // record isn't "did we just create a duplicate" moment. If the
    // directory fetch itself fails for any reason, just skip the check
    // rather than block adding faculty over it.
    let directory = [];
    try{ directory = await loadFacultyDirectory(); }catch(e){}
    const dupe = findCrossDeptDuplicate(directory, name);
    if(dupe){
      const proceed = confirm(
        `A faculty member named "${dupe.name}" already exists in ${dupe.department}.\n\n`+
        `If this is the SAME person, click Cancel — then ask the registrar to assign them to this department's sections from the Assign Instructors page instead (it already lists every department's faculty together). Two separate records for the same person means the schedule can double-book their time without warning.\n\n`+
        `Click OK only if this is actually a DIFFERENT person who happens to share that name.`
      );
      if(!proceed) return;
    }
  }

  if(editingFacultyId){
    const f = byId(state.faculty, editingFacultyId);
    Object.assign(f, {name, rank, qualifications, designations});
  } else {
    state.faculty.push({id: uid('fac'), name, rank, qualifications, designations, externalBusy:[]});
  }
  persistFaculty();
  resetFacultyForm();
  renderFacultyTable();
});

document.getElementById('facBulkImportBtn').addEventListener('click', async function(){
  const text = document.getElementById('facBulkText').value;
  if(!text.trim()){ alert("Paste some rows first."); return; }
  const rows = parseDelimitedText(text);

  // Same cross-department duplicate check as the single Add Faculty form
  // above, but batched into one confirm() so importing many rows doesn't
  // pop a dialog per row.
  let directory = [];
  try{ directory = await loadFacultyDirectory(); }catch(e){}
  const dupeNotes = [];
  rows.forEach(cols=>{
    const name = (cols[0]||'').trim();
    if(!name) return;
    const dupe = findCrossDeptDuplicate(directory, name);
    if(dupe) dupeNotes.push(`"${name}" looks like "${dupe.name}" already in ${dupe.department}`);
  });
  if(dupeNotes.length){
    const proceed = confirm(
      `${dupeNotes.length} row(s) look like they might already exist in another department:\n\n`+
      dupeNotes.join("\n")+
      `\n\nIf any of these are the SAME person, click Cancel and remove that row — assign them to this department's sections from Assign Instructors instead of adding a duplicate record.\n\n`+
      `Click OK to import all rows anyway.`
    );
    if(!proceed) return;
  }

  let count = 0;
  rows.forEach(cols=>{
    const name = (cols[0]||'').trim();
    if(!name) return;
    const rank = (cols[1]||'').trim() || 'Instructor I';
    const qualifications = (cols[2]||'').split(';').map(s=>s.trim()).filter(Boolean);
    const designations = (cols[3]||'').split(';').map(s=>s.trim()).filter(Boolean);
    state.faculty.push({id: uid('fac'), name, rank, qualifications, designations, externalBusy:[]});
    count++;
  });
  persistFaculty();
  document.getElementById('facBulkText').value = '';
  renderFacultyTable();
  alert(count + " faculty member" + (count===1?"":"s") + " imported.");
});

async function reload(){
  await loadFaculty();
  renderFacultyTable();
}

(async function boot(){
  const ok = await bootSession('faculty');
  if(!ok) return;
  wireDeptBar(reload);
  await reload();
})();
