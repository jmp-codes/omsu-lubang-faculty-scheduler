import {
  state, el, escapeHtml, byId, facultyName, subjectById, roomById, sectionById,
  assignKey, syncKey, YEAR_LABELS, DAYS, DAY_NAMES, DAY_START, DAY_END, TIME_STEP, spansLunch, hourLabel, timeRangeLabel,
  yearsInUse, downloadTextFile, toCsv, hasConflict, generateSchedule, expectedBlockIds, computeMissing,
  backupSchedule, revertSchedule, parseAdminUnits,
  bootSession, requireRegistrar, loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadSyncPrefAll,
  loadSharedData, persistSharedData
} from './shared.js';

/* ---- Year preference panel ---- */
function renderYearPrefPanel(){
  const wrap = document.getElementById('yearPrefBody');
  wrap.innerHTML = "";
  const years = yearsInUse();
  if(years.length===0){ wrap.innerHTML = "<span class='muted'>Add sections/subjects first.</span>"; return; }
  years.forEach(y=>{
    const pref = state.yearPref[y] || 'none';
    const field = el(`<div class="field" style="min-width:170px;">
      <label>${YEAR_LABELS[y]||('Year '+y)}</label>
      <select class="yearPrefSelect" data-year="${y}">
        <option value="none" ${pref==='none'?'selected':''}>No preference</option>
        <option value="morning" ${pref==='morning'?'selected':''}>Morning</option>
        <option value="afternoon" ${pref==='afternoon'?'selected':''}>Afternoon</option>
      </select>
    </div>`);
    wrap.appendChild(field);
  });
}
document.getElementById('yearPrefBody').addEventListener('change', function(e){
  if(e.target.classList.contains('yearPrefSelect')){
    state.yearPref[e.target.dataset.year] = e.target.value;
    persistSharedData();
  }
});

/* ---- Generate / Clear / Revert ---- */
document.getElementById('generateBtn').addEventListener('click', function(){
  if(state.sections.length===0){ alert("Add sections with subjects first."); return; }
  const warnings = generateSchedule();
  renderScheduleTab();
  const wrap = document.getElementById('genWarnings');
  if(warnings.length){
    wrap.innerHTML = `<div class="warn-box"><strong>${warnings.length} issue${warnings.length===1?'':'s'} during generation:</strong><ul>${warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join("")}</ul></div>`;
  } else {
    wrap.innerHTML = `<div class="warn-box" style="background:var(--teal-soft); border-color:var(--teal); color:#c9fff5;">All sessions were scheduled with no conflicts.</div>`;
  }
});
document.getElementById('clearScheduleBtn').addEventListener('click', function(){
  if(confirm("Clear the entire generated schedule?")){
    backupSchedule();
    state.schedule = [];
    state.manualRemoved = {};
    persistSharedData();
    document.getElementById('genWarnings').innerHTML = '';
    renderScheduleTab();
  }
});
document.getElementById('revertScheduleBtn').addEventListener('click', function(){
  revertSchedule();
  document.getElementById('genWarnings').innerHTML = '';
  renderScheduleTab();
});

/* ---- Faculty load summary ---- */
function renderFacultyLoad(){
  const card = document.getElementById('facultyLoadCard');
  const tbody = document.getElementById('facultyLoadBody');
  if(state.faculty.length===0){ card.style.display='none'; return; }
  card.style.display='';
  tbody.innerHTML = '';
  state.faculty.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(f=>{
    const teachingHrs = state.schedule.filter(b=>b.facultyId===f.id).reduce((s,b)=>s+b.duration,0);
    const externalHrs = (f.externalBusy||[]).reduce((s,b)=>s+b.duration,0);
    const adminUnits = parseAdminUnits(f.designations);
    const totalLoad = teachingHrs + adminUnits;
    const tr = el(`<tr>
      <td><strong>${escapeHtml(f.name)}</strong></td>
      <td>${escapeHtml(f.rank||"")}</td>
      <td>${teachingHrs}</td>
      <td>${externalHrs || '<span class="muted">—</span>'}</td>
      <td>${adminUnits || '<span class="muted">—</span>'}</td>
      <td><strong>${totalLoad}</strong></td>
    </tr>`);
    tbody.appendChild(tr);
  });
}

/* ---- Stats + missing list ---- */
function renderGenStats(){
  const wrap = document.getElementById('genStats');
  const totalOfferings = expectedBlockIds().length;
  const placed = state.schedule.length;
  const missing = computeMissing().length;
  wrap.innerHTML = `
    <div class="stat"><div class="n">${placed}</div><div class="l">Sessions Placed</div></div>
    <div class="stat"><div class="n">${missing}</div><div class="l">Unscheduled</div></div>
    <div class="stat"><div class="n">${totalOfferings}</div><div class="l">Total Expected</div></div>
  `;
}

function renderMissingList(){
  const missing = computeMissing();
  const card = document.getElementById('missingCard');
  const list = document.getElementById('missingList');
  card.style.display = missing.length ? '' : 'none';
  list.innerHTML = '';
  missing.forEach(m=>{
    const li = el(`<li>
      <div><span class="badge ${m.segType==='lab'?'badge-lab':'badge-lecture'}">${m.segType==='lab'?'Lab':'Lec'}</span>
        ${escapeHtml(m.subj.code)} — ${escapeHtml(m.sec.name)} <span class="muted">(${m.hours}h)</span></div>
      <button class="btn btn-sm btn-teal placeManualBtn" data-block="${m.blockId}" data-sec="${m.sec.id}" data-subj="${m.subj.id}" data-seg="${m.segType}" data-hours="${m.hours}">Place manually</button>
    </li>`);
    list.appendChild(li);
  });
}
document.getElementById('missingList').addEventListener('click', function(e){
  const btn = e.target.closest('.placeManualBtn');
  if(!btn) return;
  openEditModal({
    blockId: btn.dataset.block, isNew:true,
    sectionId: btn.dataset.sec, subjectId: btn.dataset.subj,
    segType: btn.dataset.seg, duration: parseFloat(btn.dataset.hours)
  });
});

/* ---- View tabs / filter ---- */
let currentView = 'section';

document.getElementById('viewTabs').addEventListener('click', function(e){
  const btn = e.target.closest('button[data-view]');
  if(!btn) return;
  currentView = btn.dataset.view;
  document.querySelectorAll('#viewTabs button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderScheduleTab();
});

function populateFilterSelect(){
  const sel = document.getElementById('filterSelect');
  sel.innerHTML = '';
  document.getElementById('filterGroup').style.display = currentView==='all' ? 'none' : '';
  let items = [];
  if(currentView==='section') items = state.sections.map(s=>({id:s.id,label:s.name}));
  if(currentView==='faculty') items = state.faculty.map(f=>({id:f.id,label:f.name}));
  if(currentView==='room') items = state.rooms.map(r=>({id:r.id,label:r.name}));
  if(items.length===0){ sel.innerHTML = '<option value="">(none available)</option>'; return; }
  sel.innerHTML = items.map(i=>`<option value="${i.id}">${escapeHtml(i.label)}</option>`).join("");
}
document.getElementById('filterSelect').addEventListener('change', renderScheduleGrid);

document.getElementById('printScheduleBtn').addEventListener('click', function(){
  if(state.schedule.length===0){ alert("Generate a schedule first."); return; }
  window.print();
});

document.getElementById('exportCsvBtn').addEventListener('click', function(){
  if(state.schedule.length===0){ alert("Generate a schedule first."); return; }
  const header = ["Day","Start","End","Type","Section","Subject","Faculty","Room","Synced","Manually Placed"];
  const rows = state.schedule.slice()
    .sort((a,b)=> DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.start-b.start)
    .map(b=>[
      DAY_NAMES[b.day], hourLabel(b.start), hourLabel(b.start+b.duration),
      b.type==='lab'?'Laboratory':'Lecture', b.sectionName, b.subject,
      facultyName(b.facultyId), b.roomName, b.synced?'Yes':'No', b.manual?'Yes':'No'
    ]);
  const csv = toCsv([header, ...rows]);
  const stamp = new Date().toISOString().slice(0,10);
  downloadTextFile("weekly-schedule-"+stamp+".csv", "text/csv", csv);
});

function renderScheduleTab(){
  populateFilterSelect();
  renderGenStats();
  renderMissingList();
  renderScheduleGrid();
  renderFacultyLoad();
  document.getElementById('revertScheduleBtn').disabled = !state.hasScheduleBackup;
}

function renderScheduleGrid(){
  const container = document.getElementById('scheduleView');
  container.innerHTML = '';
  if(state.schedule.length===0){
    container.innerHTML = "<div class='empty-msg'>No schedule generated yet. Click \"Generate Schedule\" above.</div>";
    return;
  }
  if(currentView==='all'){ renderFullAgenda(container); return; }

  const filterId = document.getElementById('filterSelect').value;
  if(!filterId){ container.innerHTML = "<div class='empty-msg'>Nothing to show.</div>"; return; }

  let blocks = state.schedule.filter(b=>{
    if(currentView==='section') return b.sectionId===filterId;
    if(currentView==='faculty') return b.facultyId===filterId;
    if(currentView==='room') return b.roomId===filterId;
    return false;
  });
  let externalBlocks = [];
  if(currentView==='faculty'){
    const fac = byId(state.faculty, filterId);
    externalBlocks = (fac && fac.externalBusy) || [];
  }

  const filterLabel = document.getElementById('filterSelect').selectedOptions[0]
    ? document.getElementById('filterSelect').selectedOptions[0].textContent : '';
  const viewLabel = currentView==='section'?'Section':currentView==='faculty'?'Faculty':'Room';
  const printHeading = el(`<div class="print-only">Weekly Schedule — ${escapeHtml(viewLabel)}: ${escapeHtml(filterLabel)}</div>`);
  container.appendChild(printHeading);

  const wrap = document.createElement('div');
  wrap.className = 'sched-wrap';
  const table = document.createElement('table');
  table.className = 'sched-grid';
  let thead = '<thead><tr><th>Time</th>' + DAYS.map(d=>`<th>${DAY_NAMES[d]}</th>`).join("") + '</tr></thead>';
  let rows = '';
  const skip = {};
  for(let h=DAY_START; h<DAY_END; h+=TIME_STEP){
    rows += `<tr><td class="time-col">${hourLabel(h)}</td>`;
    DAYS.forEach(day=>{
      const key = day+"_"+h;
      if(skip[key]){ return; }
      const block = blocks.find(b=>b.day===day && b.start===h);
      const ext = externalBlocks.find(b=>b.day===day && b.start===h);
      if(block){
        const span = Math.max(1, Math.round(block.duration / TIME_STEP));
        for(let k=1;k<span;k++) skip[day+"_"+(h+k*TIME_STEP)] = true;
        rows += `<td rowspan="${span}"><div class="block ${block.type} ${block.manual?'manual':''}" data-block="${block.blockId}">
          <div class="b-title">${escapeHtml(block.subject)}</div>
          <div class="b-sub">${currentView!=='section'?escapeHtml(block.sectionName)+' · ':''}${currentView!=='faculty'?escapeHtml(facultyName(block.facultyId))+' · ':''}${currentView!=='room'?escapeHtml(block.roomName):''}</div>
          <div class="b-sub">${timeRangeLabel(block.start,block.duration)}</div>
        </div></td>`;
      } else if(ext){
        const span = Math.max(1, Math.round(ext.duration / TIME_STEP));
        for(let k=1;k<span;k++) skip[day+"_"+(h+k*TIME_STEP)] = true;
        rows += `<td rowspan="${span}"><div class="ext-block">${escapeHtml(ext.label)} (${timeRangeLabel(ext.start,ext.duration)})</div></td>`;
      } else {
        rows += `<td></td>`;
      }
    });
    rows += `</tr>`;
  }
  table.innerHTML = thead + '<tbody>' + rows + '</tbody>';
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderFullAgenda(container){
  container.appendChild(el(`<div class="print-only">Weekly Schedule — Full View (All)</div>`));
  DAYS.forEach(day=>{
    const dayBlocks = state.schedule.filter(b=>b.day===day).sort((a,b)=>a.start-b.start);
    if(dayBlocks.length===0) return;
    const dayWrap = document.createElement('div');
    dayWrap.className = 'agenda-day';
    dayWrap.innerHTML = `<h3>${DAY_NAMES[day]}</h3>`;
    dayBlocks.forEach(b=>{
      const item = el(`<div class="agenda-item">
        <div class="t">${timeRangeLabel(b.start,b.duration)}</div>
        <div style="flex:1;">
          <span class="badge ${b.type==='lab'?'badge-lab':'badge-lecture'}">${b.type==='lab'?'Lab':'Lec'}</span>
          <strong>${escapeHtml(b.subject)}</strong> — ${escapeHtml(b.sectionName)} · ${escapeHtml(facultyName(b.facultyId))} · ${escapeHtml(b.roomName)}
        </div>
        <button class="btn btn-sm editBlockBtn" data-block="${b.blockId}">Edit</button>
      </div>`);
      dayWrap.appendChild(item);
    });
    container.appendChild(dayWrap);
  });
}

document.getElementById('scheduleView').addEventListener('click', function(e){
  const b = e.target.closest('.block');
  const editBtn = e.target.closest('.editBlockBtn');
  const blockId = b ? b.dataset.block : (editBtn ? editBtn.dataset.block : null);
  if(!blockId) return;
  const block = state.schedule.find(x=>x.blockId===blockId);
  if(!block) return;
  openEditModal({blockId, isNew:false, block});
});

/* ---- Manual edit modal ---- */
function openEditModal(opts){
  const root = document.getElementById('modalRoot');
  let sectionId, subjectId, segType, duration, existingBlock, facultyId, day, start, roomId;
  if(opts.isNew){
    sectionId = opts.sectionId; subjectId = opts.subjectId; segType = opts.segType; duration = opts.duration;
    facultyId = state.assignments[assignKey(sectionId, subjectId)] || null;
    day = DAYS[0]; start = DAY_START; roomId = '';
    existingBlock = null;
  } else {
    existingBlock = opts.block;
    sectionId = existingBlock.sectionId; subjectId = existingBlock.subjectId; segType = existingBlock.type; duration = existingBlock.duration;
    facultyId = existingBlock.facultyId; day = existingBlock.day; start = existingBlock.start; roomId = existingBlock.roomId;
  }
  const sec = sectionById(sectionId);
  const subj = subjectById(subjectId);
  const roomOptions = state.rooms.filter(r=>r.type===segType);
  const secName = sec ? sec.name : (existingBlock ? existingBlock.sectionName : '(deleted section)');
  const subjLabel = subj ? subj.code+' — '+subj.name : (existingBlock ? existingBlock.subject : '(deleted subject)');

  const modal = el(`<div class="modal-backdrop" id="editModalBackdrop">
    <div class="modal">
      <h3>${existingBlock? 'Edit' : 'Place'} Session</h3>
      <div class="hint" style="margin-bottom:10px;">${escapeHtml(subjLabel)} (${segType==='lab'?'Laboratory':'Lecture'}, ${duration}h) — ${escapeHtml(secName)} — ${escapeHtml(facultyName(facultyId))}</div>
      <div class="form-grid">
        <div class="field"><label>Day</label>
          <select id="editDay">${DAYS.map(d=>`<option value="${d}" ${d===day?'selected':''}>${DAY_NAMES[d]}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Start Time</label>
          <select id="editStart">${(function(){let o='';for(let h=DAY_START; h<=DAY_END-duration; h+=TIME_STEP){ if(h!==start && spansLunch(h,duration)) continue; o+=`<option value="${h}" ${h===start?'selected':''}>${hourLabel(h)}</option>`;} return o;})()}</select>
        </div>
        <div class="field wide"><label>Room</label>
          <select id="editRoom">
            <option value="">— choose room —</option>
            ${roomOptions.map(r=>`<option value="${r.id}" ${r.id===roomId?'selected':''}>${escapeHtml(r.name)}${r.capacity? ' (max '+r.capacity+')':''}</option>`).join("")}
          </select>
        </div>
      </div>
      <div id="editConflictMsg" class="warn-box hidden"></div>
      <div class="actions">
        <div>${existingBlock? '<button class="btn btn-danger" id="unscheduleBtn">Unschedule</button>' : ''}</div>
        <div class="row">
          <button class="btn" id="editCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="editSaveBtn">Save</button>
        </div>
      </div>
    </div>
  </div>`);
  root.innerHTML = '';
  root.appendChild(modal);

  modal.querySelector('#editCancelBtn').addEventListener('click', ()=> root.innerHTML='');
  modal.addEventListener('click', function(e){ if(e.target===modal) root.innerHTML=''; });

  if(existingBlock){
    modal.querySelector('#unscheduleBtn').addEventListener('click', function(){
      state.schedule = state.schedule.filter(b=>b.blockId!==existingBlock.blockId);
      state.manualRemoved[existingBlock.blockId] = true;
      persistSharedData();
      root.innerHTML='';
      renderScheduleTab();
    });
  }

  modal.querySelector('#editSaveBtn').addEventListener('click', function(){
    if(!sec || !subj){ alert("That section or subject no longer exists — this session can only be unscheduled."); return; }
    const newDay = modal.querySelector('#editDay').value;
    const newStart = parseFloat(modal.querySelector('#editStart').value);
    const newRoomId = modal.querySelector('#editRoom').value;
    const msgBox = modal.querySelector('#editConflictMsg');
    if(!newRoomId){ msgBox.textContent = "Please choose a room."; msgBox.classList.remove('hidden'); return; }
    const testBlock = {day:newDay, start:newStart, duration, sectionId, facultyId, roomId:newRoomId};
    const excludeId = existingBlock ? existingBlock.blockId : opts.blockId;
    const conflict = hasConflict(testBlock, excludeId);
    if(conflict){
      let who = conflict.type==='external' ? (conflict.with.label||'external commitment') :
        conflict.type==='faculty' ? 'the same faculty (' + facultyName(facultyId) + ')' :
        conflict.type==='room' ? 'the same room' : 'the same section';
      msgBox.textContent = `Conflict: overlaps with ${who} at ${timeRangeLabel(conflict.with.start, conflict.with.duration)} on ${DAY_NAMES[newDay]}.`;
      msgBox.classList.remove('hidden');
      return;
    }
    const room = roomById(newRoomId);
    const blockId = existingBlock ? existingBlock.blockId : opts.blockId;
    state.schedule = state.schedule.filter(b=>b.blockId!==blockId);
    state.schedule.push({
      blockId, day:newDay, start:newStart, duration, type:segType,
      sectionId, sectionName: sec.name,
      subjectId, subject: subj.code+" — "+subj.name,
      facultyId, roomId:newRoomId, roomName: room.name,
      synced:false, manual:true
    });
    delete state.manualRemoved[blockId];
    persistSharedData();
    root.innerHTML='';
    renderScheduleTab();
  });
}

(async function boot(){
  const ok = await bootSession('schedule');
  if(!ok) return;
  if(!requireRegistrar()) return;
  await Promise.all([loadFacultyAll(), loadSubjectsAll(), loadSectionsAll(), loadSyncPrefAll(), loadSharedData()]);
  renderYearPrefPanel();
  renderScheduleTab();
})();
