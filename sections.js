import {
  state, uid, el, escapeHtml, subjectById, sectionById, syncKey,
  YEAR_LABELS, parseDelimitedText,
  bootSession, wireDeptBar, loadSubjects, loadSections, loadSyncPref,
  persistSections, persistSyncPref
} from './shared.js';

// Tracks section cards the user has manually collapsed. renderSectionsList()
// rebuilds every card from scratch after almost every action (add/remove a
// subject, edit year/count, etc.), so without this, a full re-render would
// silently re-expand every card back open each time. A section id that
// isn't in this set renders open — which is also what makes a brand-new
// section (or a duplicate) always appear expanded, even if every other
// card on the page is currently collapsed.
const collapsedSectionIds = new Set();

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
    // Only offered when a year actually has 2+ active curricula at once
    // (e.g. an old curriculum still running for continuing/irregular
    // students alongside a new one) — otherwise there's nothing to choose
    // between and the extra dropdown would just be clutter.
    const curriculaForYear = Array.from(new Set(
      state.subjects.filter(s=>s.year===sec.year && !s.archived && s.curriculum).map(s=>s.curriculum)
    )).sort();
    const isOpen = !collapsedSectionIds.has(sec.id);
    const card = el(`<details class="section-card"${isOpen?' open':''}>
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
        <div class="row" style="margin-top:6px;">
          <select class="addAllSemSelect" data-sec="${sec.id}" style="width:160px;">
            <option value="1st">1st Semester</option>
            <option value="2nd">2nd Semester</option>
            <option value="summer">Summer</option>
          </select>
          ${curriculaForYear.length>1 ? `
          <select class="addAllCurrSelect" data-sec="${sec.id}" style="min-width:160px;" title="Subjects with no curriculum set are treated as shared/general-ed and get added no matter which curriculum you pick here">
            <option value="">All curricula</option>
            ${curriculaForYear.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>` : ''}
          <button class="btn btn-sm addAllSemBtn" data-sec="${sec.id}" title="Adds every non-archived ${YEAR_LABELS[sec.year]} subject offered in the chosen semester (plus any marked 'Both Semesters') that isn't already on this section">Add All Subjects for Semester</button>
        </div>
      </div>
    </details>`);
    // Remembers this card's open/closed state across the next re-render
    // (see collapsedSectionIds above) instead of always snapping back open.
    card.addEventListener('toggle', function(){
      if(card.open) collapsedSectionIds.delete(sec.id);
      else collapsedSectionIds.add(sec.id);
    });
    wrap.appendChild(card);
  });
}

document.getElementById('sectionsList').addEventListener('click', function(e){
  const delBtn = e.target.closest('.delSec');
  const dupBtn = e.target.closest('.dupSec');
  const addBtn = e.target.closest('.addSubjBtn');
  const addAllBtn = e.target.closest('.addAllSemBtn');
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
      collapsedSectionIds.delete(delBtn.dataset.id);
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
  if(addAllBtn){
    const sec = sectionById(addAllBtn.dataset.sec);
    const semSel = document.querySelector(`.addAllSemSelect[data-sec="${addAllBtn.dataset.sec}"]`);
    const currSel = document.querySelector(`.addAllCurrSelect[data-sec="${addAllBtn.dataset.sec}"]`);
    const sem = semSel.value;
    const curriculum = currSel ? currSel.value : '';
    // Same-year, non-archived subjects offered that semester (or "both
    // semesters") that aren't already on this section — lets a chair
    // populate a whole semester's worth of subjects in one click instead
    // of adding them one at a time. When a curriculum is picked (only
    // possible when the year has 2+ curricula in use), subjects tagged
    // with a DIFFERENT curriculum are excluded — but a subject with no
    // curriculum set at all is treated as shared/general-ed and is
    // included regardless of which curriculum is selected.
    const toAdd = state.subjects.filter(s=>
      s.year === sec.year && !s.archived && !sec.subjectIds.includes(s.id) &&
      (s.semester === sem || s.semester === 'both') &&
      (!curriculum || !s.curriculum || s.curriculum === curriculum)
    );
    if(toAdd.length === 0){
      alert("No matching subjects to add — they may already be on this section, or none exist for "+YEAR_LABELS[sec.year]+" in that semester.");
      return;
    }
    toAdd.forEach(s=> sec.subjectIds.push(s.id));
    persistSections(); renderSectionsList(); renderSyncPanel();
    alert(toAdd.length + " subject" + (toAdd.length===1?"":"s") + " added to " + sec.name + ".");
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

// Shared by renderSyncPanel() and the Sync All/Clear All buttons: every
// year+subject combination that 2 or more sections currently have, i.e.
// every row the panel can show a toggle for.
function eligibleSyncGroups(){
  const groups = {};
  state.sections.forEach(sec=>{
    sec.subjectIds.forEach(subjId=>{
      const key = syncKey(sec.year, subjId);
      (groups[key] = groups[key]||{year:sec.year, subjectId:subjId, sections:[]}).sections.push(sec);
    });
  });
  return Object.values(groups).filter(g=>g.sections.length>=2);
}

function renderSyncPanel(){
  const card = document.getElementById('syncPanelCard');
  const body = document.getElementById('syncPanelBody');
  const countEl = document.getElementById('syncPanelCount');
  const eligible = eligibleSyncGroups();
  if(eligible.length===0){ card.style.display='none'; body.innerHTML=''; return; }
  card.style.display='';
  countEl.textContent = eligible.length;
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
function setAllSyncPref(value){
  eligibleSyncGroups().forEach(g=>{ state.syncPref[syncKey(g.year, g.subjectId)] = value; });
  persistSyncPref();
  renderSyncPanel();
}
document.getElementById('syncAllBtn').addEventListener('click', ()=> setAllSyncPref(true));
document.getElementById('syncNoneBtn').addEventListener('click', ()=> setAllSyncPref(false));
// Note: #syncPanelDetails itself is static markup (only its #syncPanelBody
// child gets rebuilt on each render), so the browser keeps whatever
// open/closed state the user leaves it in across re-renders automatically
// — nothing extra to track here.

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
