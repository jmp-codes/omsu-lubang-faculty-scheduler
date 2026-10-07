import {
  state, session, el, escapeHtml, byId, facultyName, subjectById, roomById, sectionById,
  assignKey, syncKey, YEAR_LABELS, DAYS, DAY_NAMES, DAY_START, DAY_END, TIME_STEP, spansLunch, hourLabel, timeRangeLabel,
  yearsInUse, downloadTextFile, toCsv, hasConflict, generateSchedule, expectedBlockIds, computeMissing,
  clearSchedule, revertSchedule, hasDeptScheduleBackup, parseAdminUnits, rescheduleBlockWithCascade,
  bootSession, loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadSyncPrefAll,
  loadSharedData, persistSharedData, describeAvailability, toast
} from './shared.js';

// Every write-side action on this page (Generate/Clear/Revert, manual
// edit/drag-reschedule) is scoped to the registrar's whole campus, or to
// just a chair's own department — null means "whole campus" throughout.
function deptScope(){
  return session.isRegistrar ? null : session.department;
}
function canEditSection(sectionId){
  if(session.isRegistrar) return true;
  const sec = sectionById(sectionId);
  return !!(sec && sec.department === session.department);
}

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

// generateSchedule() returns plain warning sentences, and the same handful
// of sentence shapes repeat verbatim for every affected subject/section —
// a term with a dozen unassigned subjects used to print "X has no
// instructor assigned — skipped." a dozen times in a row. These patterns
// match those exact sentence shapes (see shared.js's warnings.push calls)
// purely to bucket them for display; they don't change what's generated.
let collapsedWarningGroups = new Set();
const WARNING_CATEGORIES = [
  { key:'no-instructor', label:'No instructor assigned',
    match:/^(.+) \((.+)\) has no instructor assigned — skipped\.$/,
    item:(m)=> `${m[1]} — ${m[2]}` },
  { key:'no-split', label:'Could not split 3-hour lecture (no Mon/Wed or Tue/Thu pair free)',
    match:/^Could not split the 3-hour lecture for (.+) \((.+)\) across Mon\/Wed or Tue\/Thu — no valid pair found\.$/,
    item:(m)=> `${m[1]} — ${m[2]}` },
  { key:'no-slot', label:'No free faculty/room/day-time combination found',
    match:/^Could not place (lecture|lab) for (.+) \((.+)\) — no free faculty\/room\/day-time combination found\.$/,
    item:(m)=> `${m[2]} — ${m[3]} (${m[1]==='lab'?'Lab':'Lec'})` },
  { key:'sync-fallback', label:'Same-time scheduling fallback (placed independently instead)',
    match:/^Same-time scheduling for (.+) \((.+)\) wasn't feasible — placing sections independently instead\.$/,
    item:(m)=> `${m[1]} — ${m[2]}` },
];
function renderGenWarnings(warnings){
  const wrap = document.getElementById('genWarnings');
  wrap.innerHTML = '';
  if(warnings.length===0){
    wrap.innerHTML = `<div class="warn-box" style="background:var(--teal-soft); border-color:var(--teal); color:#dbe3ff;">All sessions were scheduled with no conflicts.</div>`;
    return;
  }
  const buckets = new Map();
  const other = [];
  warnings.forEach(w=>{
    const cat = WARNING_CATEGORIES.find(c=>c.match.test(w));
    if(!cat){ other.push(w); return; }
    if(!buckets.has(cat.key)) buckets.set(cat.key, { label: cat.label, items: [] });
    buckets.get(cat.key).items.push(cat.item(w.match(cat.match)));
  });
  const box = el(`<div class="warn-box"><strong>${warnings.length} issue${warnings.length===1?'':'s'} during generation:</strong></div>`);
  const addGroup = (key, label, items)=>{
    const isOpen = !collapsedWarningGroups.has(key);
    const det = el(`<details class="group" style="margin-top:8px;">
      <summary>${escapeHtml(label)} <span class="count">${items.length}</span></summary>
      <div class="group-body"><ul class="miss-list"></ul></div>
    </details>`);
    det.addEventListener('toggle', function(){
      if(det.open) collapsedWarningGroups.delete(key);
      else collapsedWarningGroups.add(key);
    });
    const ul = det.querySelector('.miss-list');
    items.forEach(text=> ul.appendChild(el(`<li>${escapeHtml(text)}</li>`)));
    box.appendChild(det);
    det.open = isOpen;
  };
  WARNING_CATEGORIES.forEach(cat=>{
    const bucket = buckets.get(cat.key);
    if(bucket) addGroup(cat.key, cat.label, bucket.items);
  });
  if(other.length) addGroup('other', 'Other issues', other);
  wrap.appendChild(box);
}

/* ---- Generate / Clear / Revert ---- */
document.getElementById('generateBtn').addEventListener('click', function(){
  if(state.sections.length===0){ toast("Add sections with subjects first.", 'error'); return; }
  const scope = deptScope();
  const warnings = generateSchedule(scope);
  renderScheduleTab();
  renderGenWarnings(warnings);
  if(scope) toast(`Generated ${scope}'s schedule — other departments' sessions weren't touched.`, 'success');
});
document.getElementById('clearScheduleBtn').addEventListener('click', function(){
  const scope = deptScope();
  const msg = scope
    ? `Clear ${scope}'s generated schedule? Other departments' sessions won't be affected.`
    : "Clear the entire generated schedule?";
  if(confirm(msg)){
    clearSchedule(scope);
    document.getElementById('genWarnings').innerHTML = '';
    renderScheduleTab();
  }
});
document.getElementById('revertScheduleBtn').addEventListener('click', function(){
  revertSchedule(deptScope());
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

// Tracks which section groups below have been manually collapsed, so a
// re-render (e.g. after placing one session) doesn't snap every group back
// open — same pattern as subjects.js/assign.js's collapsedYears.
let collapsedMissingSections = new Set();

function renderMissingList(){
  const missing = computeMissing();
  const card = document.getElementById('missingCard');
  const list = document.getElementById('missingList');
  card.style.display = missing.length ? '' : 'none';
  list.innerHTML = '';
  if(missing.length === 0) return;

  // Group by section instead of one long flat list — a term with lots of
  // unscheduled sessions was turning this card into a scroll of 20-30 rows
  // with no structure. Same collapsible <details class="group"> pattern
  // used on the Subjects/Assign Instructors pages.
  const bySection = new Map();
  missing.forEach(m=>{
    if(!bySection.has(m.sec.id)) bySection.set(m.sec.id, { sec: m.sec, items: [] });
    bySection.get(m.sec.id).items.push(m);
  });
  const groups = Array.from(bySection.values()).sort((a,b)=> a.sec.name.localeCompare(b.sec.name));

  groups.forEach(g=>{
    const isOpen = !collapsedMissingSections.has(g.sec.id);
    // Build it closed and set .open as a property below, AFTER it's in the
    // live document — baking `open` into the HTML string here and letting
    // the browser parse it from a detached template can get silently
    // collapsed the moment the node is appended, which is why every group
    // was rendering closed despite isOpen being true on first load.
    const det = el(`<details class="group">
      <summary>${escapeHtml(g.sec.name)} <span class="count">${g.items.length} unscheduled</span></summary>
      <div class="group-body"><ul class="miss-list"></ul></div>
    </details>`);
    det.addEventListener('toggle', function(){
      if(det.open) collapsedMissingSections.delete(g.sec.id);
      else collapsedMissingSections.add(g.sec.id);
    });
    const ul = det.querySelector('.miss-list');
    // A chair can see every department's unscheduled sessions here, for
    // coordination (shared rooms), but can only place/edit their own —
    // same split as the grid below.
    const canEdit = canEditSection(g.sec.id);
    g.items.forEach(m=>{
      const action = canEdit
        ? `<button class="btn btn-sm btn-teal placeManualBtn" data-block="${m.blockId}" data-sec="${m.sec.id}" data-subj="${m.subj.id}" data-seg="${m.segType}" data-hours="${m.hours}">Place manually</button>`
        : `<span class="muted" style="font-size:12px;">${escapeHtml(g.sec.department||'')} only</span>`;
      const li = el(`<li>
        <div><span class="badge ${m.segType==='lab'?'badge-lab':'badge-lecture'}">${m.segType==='lab'?'Lab':'Lec'}</span>
          ${escapeHtml(m.subj.code)} <span class="muted">(${m.hours}h)</span></div>
        ${action}
      </li>`);
      ul.appendChild(li);
    });
    list.appendChild(det);
    det.open = isOpen;
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
  if(currentView==='room'){
    // A chair can only browse rooms they could actually place a class in —
    // their own department's rooms plus Shared ones; the registrar still
    // sees every room.
    const visibleRooms = session.isRegistrar ? state.rooms
      : state.rooms.filter(r=> !r.department || r.department===session.department);
    items = visibleRooms.map(r=>({id:r.id,label:r.name}));
  }
  if(items.length===0){ sel.innerHTML = '<option value="">(none available)</option>'; return; }
  sel.innerHTML = items.map(i=>`<option value="${i.id}">${escapeHtml(i.label)}</option>`).join("");
}
document.getElementById('filterSelect').addEventListener('change', renderScheduleGrid);

document.getElementById('printScheduleBtn').addEventListener('click', function(){
  if(state.schedule.length===0){ toast("Generate a schedule first.", 'error'); return; }
  window.print();
});

document.getElementById('exportCsvBtn').addEventListener('click', function(){
  if(state.schedule.length===0){ toast("Generate a schedule first.", 'error'); return; }
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
  document.getElementById('revertScheduleBtn').disabled = session.isRegistrar
    ? !state.hasScheduleBackup
    : !hasDeptScheduleBackup(session.department);
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
  // Drag-and-drop rescheduling only makes unambiguous sense when the grid
  // is filtered to one section or one faculty member — see the drop
  // handler below for why "By Room" / "Full View" are excluded.
  const draggableView = currentView==='section' || currentView==='faculty';
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
        // A small gold corner dot flags a block whose instructor has a
        // standing availability restriction (see the Availability dropdown
        // on the Faculty page) — a reminder, while scanning the grid, that
        // this placement is pinned to a narrower window than most, with the
        // restriction itself in the native tooltip rather than cluttering
        // the block's visible text.
        const blockFac = block.facultyId ? byId(state.faculty, block.facultyId) : null;
        const availLabel = blockFac ? describeAvailability(blockFac) : '';
        // A chair can see every department's blocks on shared views (By
        // Room/Full View) for coordination, but can only drag/edit their
        // own — other-department blocks get a muted look and a tooltip
        // instead of the drag handle.
        const canEdit = canEditSection(block.sectionId);
        const otherDeptTitle = canEdit ? '' : `Managed by ${sectionById(block.sectionId)?.department||'another department'}`;
        const titleText = [otherDeptTitle, availLabel ? `${facultyName(block.facultyId)}: ${availLabel}` : ''].filter(Boolean).join(' — ');
        const restrictedTitle = titleText ? ` title="${escapeHtml(titleText)}"` : '';
        rows += `<td rowspan="${span}" data-day="${day}" data-start="${h}"><div class="block ${block.type} ${block.manual?'manual':''}${availLabel?' restricted':''}${canEdit?'':' other-dept'}" data-block="${block.blockId}"${draggableView&&canEdit?' draggable="true"':''}${restrictedTitle}>
          <div class="b-title">${escapeHtml(block.subject)}</div>
          <div class="b-sub">${currentView!=='section'?escapeHtml(block.sectionName)+' · ':''}${currentView!=='faculty'?escapeHtml(facultyName(block.facultyId))+' · ':''}${currentView!=='room'?escapeHtml(block.roomName):''}</div>
          <div class="b-sub">${timeRangeLabel(block.start,block.duration)}</div>
        </div></td>`;
      } else if(ext){
        const span = Math.max(1, Math.round(ext.duration / TIME_STEP));
        for(let k=1;k<span;k++) skip[day+"_"+(h+k*TIME_STEP)] = true;
        rows += `<td rowspan="${span}" data-day="${day}" data-start="${h}"><div class="ext-block">${escapeHtml(ext.label)} (${timeRangeLabel(ext.start,ext.duration)})</div></td>`;
      } else {
        rows += `<td data-day="${day}" data-start="${h}"></td>`;
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
      const canEdit = canEditSection(b.sectionId);
      const item = el(`<div class="agenda-item">
        <div class="t">${timeRangeLabel(b.start,b.duration)}</div>
        <div style="flex:1;">
          <span class="badge ${b.type==='lab'?'badge-lab':'badge-lecture'}">${b.type==='lab'?'Lab':'Lec'}</span>
          <strong>${escapeHtml(b.subject)}</strong> — ${escapeHtml(b.sectionName)} · ${escapeHtml(facultyName(b.facultyId))} · ${escapeHtml(b.roomName)}
        </div>
        ${canEdit ? `<button class="btn btn-sm editBlockBtn" data-block="${b.blockId}">Edit</button>` : `<span class="muted" style="font-size:12px;">${escapeHtml(sectionById(b.sectionId)?.department||'')} only</span>`}
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

/* ---- Drag-and-drop rescheduling ---- */
document.getElementById('scheduleView').addEventListener('dragstart', function(e){
  const b = e.target.closest('.block[draggable="true"]');
  if(!b){ e.preventDefault(); return; }
  e.dataTransfer.setData('text/plain', b.dataset.block);
  e.dataTransfer.effectAllowed = 'move';
});

document.getElementById('scheduleView').addEventListener('dragover', function(e){
  if(!e.target.closest('td[data-day]')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});

document.getElementById('scheduleView').addEventListener('drop', function(e){
  const cell = e.target.closest('td[data-day]');
  if(!cell) return;
  e.preventDefault();
  const blockId = e.dataTransfer.getData('text/plain');
  if(!blockId) return;
  const dragged = state.schedule.find(b=>b.blockId===blockId);
  if(dragged && !canEditSection(dragged.sectionId)){
    toast("This session belongs to another department — only its chair or the registrar can move it.", 'error');
    return;
  }
  const result = rescheduleBlockWithCascade(blockId, cell.dataset.day, parseFloat(cell.dataset.start));
  if(!result.ok){
    toast("Couldn't move that class there: " + result.reason, 'error', 6000);
    return;
  }
  renderScheduleTab();
  const bumped = result.shifted.filter(s=>s.blockId!==blockId);
  if(bumped.length){
    toast("Moved. To keep the break rule and avoid overlaps, this also shifted: "
      + bumped.map(s=>`${s.subject} → ${DAY_NAMES[s.day]} ${hourLabel(s.start)}`).join(", "), 'success', 6000);
  } else {
    toast("Moved.", 'success');
  }
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
  // Last line of defense (the grid/agenda/missing-list UI already hides or
  // disables the controls that reach here for a section outside a chair's
  // own department) — covers every entry point into this modal in one spot.
  if(!session.isRegistrar && sec && sec.department !== session.department){
    toast("This session belongs to another department — only its chair or the registrar can make changes to it.", 'error');
    return;
  }
  const subj = subjectById(subjectId);
  // Only offer rooms this section could actually be generated into — its
  // own department's rooms plus Shared ones — so a manual placement can't
  // put a class in a room dedicated to another department.
  const roomOptions = state.rooms.filter(r=>r.type===segType && (!r.department || !sec || r.department===sec.department));
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
    if(!sec || !subj){ toast("That section or subject no longer exists — this session can only be unscheduled.", 'error'); return; }
    const newDay = modal.querySelector('#editDay').value;
    const newStart = parseFloat(modal.querySelector('#editStart').value);
    const newRoomId = modal.querySelector('#editRoom').value;
    const msgBox = modal.querySelector('#editConflictMsg');
    if(!newRoomId){ msgBox.textContent = "Please choose a room."; msgBox.classList.remove('hidden'); return; }
    const testBlock = {day:newDay, start:newStart, duration, sectionId, facultyId, roomId:newRoomId};
    const excludeId = existingBlock ? existingBlock.blockId : opts.blockId;
    const conflict = hasConflict(testBlock, excludeId);
    if(conflict){
      if(conflict.type==='availability'){
        const reason = conflict.with.reason;
        if(reason==='day'){
          msgBox.textContent = `${facultyName(facultyId)} isn't available on ${DAY_NAMES[conflict.with.day]}.`;
        } else if(reason==='morning'){
          msgBox.textContent = `${facultyName(facultyId)} is mornings-only and must be done by ${hourLabel(conflict.with.time)} on ${DAY_NAMES[newDay]}.`;
        } else if(reason==='evening'){
          msgBox.textContent = `${facultyName(facultyId)} isn't available until ${hourLabel(conflict.with.time)} on ${DAY_NAMES[newDay]}.`;
        } else {
          msgBox.textContent = `${facultyName(facultyId)} isn't available on ${DAY_NAMES[newDay]}.`;
        }
        msgBox.classList.remove('hidden');
        return;
      }
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
  await Promise.all([loadFacultyAll(), loadSubjectsAll(), loadSectionsAll(), loadSyncPrefAll(), loadSharedData()]);
  renderYearPrefPanel();
  renderScheduleTab();
})();
