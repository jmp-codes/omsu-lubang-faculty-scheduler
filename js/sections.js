import {
  state, uid, el, escapeHtml, subjectById, sectionById, syncKey,
  YEAR_LABELS, parseDelimitedText,
  bootSession, wireDeptBar, loadSubjects, loadSections, loadSyncPref,
  persistSections, persistSyncPref
} from './shared.js';

document.getElementById('secSaveBtn').addEventListener('click', function(){
  const name = document.getElementById('secName').value.trim();
  if(!name){ alert("Please enter a section name."); return; }
  const year = parseInt(document.getElementById('secYear').value,10);
  const studentCount = parseInt(document.getElementById('secCount').value,10) || 0;
  state.sections.push({id: uid('sec'), name, year, studentCount, subjectIds:[]});
  persistSections();
  document.getElementById('secName').value='';
  document.getElementById('secCount').value='';
  renderSectionsList();
  renderSyncPanel();
});

document.getElementById('secBulkImportBtn').addEventListener('click', function(){
  const text = document.getElementById('secBulkText').value;
  if(!text.trim()){ alert("Paste some rows first."); return; }
  const rows = parseDelimitedText(text);
  let count = 0;
  const unmatched = new Set();
  rows.forEach(cols=>{
    const name = (cols[0]||'').trim();
    if(!name) return;
    const year = parseInt(cols[1],10) || 1;
    const studentCount = parseInt(cols[2],10) || 0;
    const codes = (cols[3]||'').split(';').map(s=>s.trim()).filter(Boolean);
    const subjectIds = [];
    codes.forEach(code=>{
      const subj = state.subjects.find(s=>s.code.toLowerCase()===code.toLowerCase());
      if(subj) subjectIds.push(subj.id);
      else unmatched.add(code);
    });
    state.sections.push({id: uid('sec'), name, year, studentCount, subjectIds});
    count++;
  });
  persistSections();
  document.getElementById('secBulkText').value = '';
  renderSectionsList();
  renderSyncPanel();
  let msg = count + " section" + (count===1?"":"s") + " imported.";
  if(unmatched.size) msg += "\n\nThese subject codes weren't found and were skipped: " + Array.from(unmatched).join(", ");
  alert(msg);
});

function renderSectionsList(){
  const wrap = document.getElementById('sectionsList');
  wrap.innerHTML = "";
  document.getElementById('sectionsEmpty').classList.toggle('hidden', state.sections.length>0);
  state.sections.forEach(sec=>{
    // Archived subjects (retired curriculum) are hidden from this picker so
    // nobody accidentally adds them to a new section, but one already on a
    // section keeps showing normally above via subjectById() regardless.
    const availableSubjects = state.subjects.filter(s=>!sec.subjectIds.includes(s.id) && !s.archived);
    const card = el(`<details class="section-card" open>
      <summary>
        <div><span class="title">${escapeHtml(sec.name)}</span><span class="meta pill-year" style="margin-left:8px;">${YEAR_LABELS[sec.year]}</span><span class="meta">${sec.studentCount} students</span></div>
        <div class="row" style="flex:none;">
          <button class="btn btn-sm dupSec" data-id="${sec.id}" title="Create a copy of this section with the same year, student count and subjects (instructor assignments are set separately on Assign Instructors)">Duplicate</button>
          <button class="btn btn-sm btn-danger delSec" data-id="${sec.id}">Delete Section</button>
        </div>
      </summary>
      <div class="body">
        <div class="row" style="margin-bottom:10px;">
          <label class="muted" style="font-size:12px;">Year</label>
          <select class="secEditYear" data-id="${sec.id}" style="width:110px;">
            ${[1,2,3,4,5].map(y=>`<option value="${y}" ${y==sec.year?'selected':''}>${YEAR_LABELS[y]}</option>`).join("")}
          </select>
          <label class="muted" style="font-size:12px;">Students</label>
          <input type="number" class="secEditCount" data-id="${sec.id}" value="${sec.studentCount}" style="width:80px;">
        </div>
        <div class="subj-chips">${sec.subjectIds.map(sid=>{
          const s = subjectById(sid);
          if(!s) return "";
          const curTag = s.curriculum ? ` <span class="muted" style="font-size:11px;">(${escapeHtml(s.curriculum)}${s.archived?', archived':''})</span>` : (s.archived ? ` <span class="muted" style="font-size:11px;">(archived)</span>` : '');
          return `<span class="chip"><span class="badge ${s.type==='lab'?'badge-lab':'badge-lecture'}" style="margin-right:4px;">${s.type==='lab'?'Lab':'Lec'}</span>${escapeHtml(s.code)} — ${escapeHtml(s.name)}${curTag} <button class="rmSubjFromSec" data-sec="${sec.id}" data-subj="${sid}">✕</button></span>`;
        }).join("") || "<span class='muted'>No subjects added yet.</span>"}</div>
        <div class="row" style="margin-top:10px;">
          <select class="addSubjSelect" data-sec="${sec.id}" style="min-width:220px;">
            <option value="">— add a subject —</option>
            ${availableSubjects.map(s=>`<option value="${s.id}">${escapeHtml(s.code)} — ${escapeHtml(s.name)} (${YEAR_LABELS[s.year]}${s.curriculum?', '+escapeHtml(s.curriculum):''})</option>`).join("")}
          </select>
          <button class="btn btn-sm btn-teal addSubjBtn" data-sec="${sec.id}">Add Subject</button>
        </div>
      </div>
    </details>`);
    wrap.appendChild(card);
  });
}

document.getElementById('sectionsList').addEventListener('click', function(e){
  const delBtn = e.target.closest('.delSec');
  const dupBtn = e.target.closest('.dupSec');
  const addBtn = e.target.closest('.addSubjBtn');
  const rmBtn = e.target.closest('.rmSubjFromSec');
  if(dupBtn){
    e.preventDefault();
    const src = sectionById(dupBtn.dataset.id);
    if(!src) return;
    const copy = {id: uid('sec'), name: src.name+" (Copy)", year: src.year, studentCount: src.studentCount, subjectIds: src.subjectIds.slice()};
    state.sections.push(copy);
    persistSections();
    renderSectionsList(); renderSyncPanel();
  }
  if(delBtn){
    if(confirm("Delete this section?")){
      state.sections = state.sections.filter(s=>s.id!==delBtn.dataset.id);
      persistSections(); renderSectionsList(); renderSyncPanel();
    }
  }
  if(addBtn){
    const sel = document.querySelector(`.addSubjSelect[data-sec="${addBtn.dataset.sec}"]`);
    if(sel.value){
      const sec = sectionById(addBtn.dataset.sec);
      sec.subjectIds.push(sel.value);
      persistSections(); renderSectionsList(); renderSyncPanel();
    }
  }
  if(rmBtn){
    const sec = sectionById(rmBtn.dataset.sec);
    sec.subjectIds = sec.subjectIds.filter(id=>id!==rmBtn.dataset.subj);
    persistSections(); renderSectionsList(); renderSyncPanel();
  }
});
document.getElementById('sectionsList').addEventListener('change', function(e){
  if(e.target.classList.contains('secEditYear')){
    sectionById(e.target.dataset.id).year = parseInt(e.target.value,10);
    persistSections(); renderSectionsList(); renderSyncPanel();
  }
  if(e.target.classList.contains('secEditCount')){
    sectionById(e.target.dataset.id).studentCount = parseInt(e.target.value,10)||0;
    persistSections();
  }
});

function renderSyncPanel(){
  const card = document.getElementById('syncPanelCard');
  const body = document.getElementById('syncPanelBody');
  const groups = {};
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      const key = syncKey(sec.year, subjId);
      (groups[key] = groups[key]||{year:sec.year, subjectId:subjId, sections:[]}).sections.push(sec);
    });
  });
  const eligible = Object.values(groups).filter(g=>g.sections.length>=2);
  if(eligible.length===0){ card.style.display='none'; body.innerHTML=''; return; }
  card.style.display='';
  body.innerHTML='';
  eligible.sort((a,b)=> a.year-b.year || (subjectById(a.subjectId)?.code||'').localeCompare(subjectById(b.subjectId)?.code||''));
  eligible.forEach(g=>{
    const subj = subjectById(g.subjectId);
    if(!subj) return;
    const key = syncKey(g.year, g.subjectId);
    const checked = !!state.syncPref[key];
    const row = el(`<div class="row" style="justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border-soft);">
      <div><span class="pill-year">${YEAR_LABELS[g.year]}</span> <strong>${escapeHtml(subj.code)}</strong> — ${escapeHtml(subj.name)}
        <div class="muted" style="font-size:12px;">${g.sections.map(s=>escapeHtml(s.name)).join(", ")}</div>
      </div>
      <label class="switch"><input type="checkbox" class="syncToggle" data-key="${key}" ${checked?'checked':''}><span class="slider"></span></label>
    </div>`);
    body.appendChild(row);
  });
}
document.getElementById('syncPanelBody').addEventListener('change', function(e){
  if(e.target.classList.contains('syncToggle')){
    state.syncPref[e.target.dataset.key] = e.target.checked;
    persistSyncPref();
  }
});

async function reload(){
  await loadSubjects();
  await loadSections();
  await loadSyncPref();
  renderSectionsList();
  renderSyncPanel();
}

(async function boot(){
  const ok = await bootSession('sections');
  if(!ok) return;
  wireDeptBar(reload);
  await reload();
})();
