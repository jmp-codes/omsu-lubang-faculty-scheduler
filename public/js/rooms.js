import {
  state, uid, el, escapeHtml, roomById, sectionById, parseDelimitedText,
  session, DEPARTMENTS,
  bootSession, loadSharedData, loadSectionsAll, persistSharedData, toast
} from './shared.js';

let editingRoomId = null;
let roomSearchQuery = '';

// A room with no department (Shared/Any Department) is editable only by
// the registrar — the whole point of tagging rooms by department is to
// stop one chair from quietly reconfiguring a room other departments rely
// on, so an un-tagged room defaults to "registrar decides", not "anyone
// may edit it" (which was the de facto behavior before this feature).
function canEditRoom(r){
  if(!r) return false;
  return session.isRegistrar || r.department === session.department;
}

function populateRoomDeptSelect(){
  const field = document.getElementById('roomDeptField');
  if(!field) return;
  if(!session.isRegistrar){ field.style.display = 'none'; return; }
  field.style.display = '';
  const sel = document.getElementById('roomDept');
  sel.innerHTML = `<option value="">Shared / Any Department</option>` +
    DEPARTMENTS.map(d=>`<option value="${d}">${escapeHtml(d)}</option>`).join("");
}

function renderRoomsTable(){
  const tbody = document.getElementById('roomsTableBody');
  tbody.innerHTML = "";
  // A chair only sees their own department's rooms plus Shared ones — the
  // registrar still sees every room, same as every other shared page.
  const scopedRooms = session.isRegistrar ? state.rooms
    : state.rooms.filter(r=> !r.department || r.department===session.department);
  document.getElementById('roomsEmpty').classList.toggle('hidden', scopedRooms.length>0);
  const q = roomSearchQuery.trim().toLowerCase();
  const visibleRooms = scopedRooms.filter(r=> !q || r.name.toLowerCase().includes(q));
  const searchEmpty = document.getElementById('roomsSearchEmpty');
  if(searchEmpty) searchEmpty.classList.toggle('hidden', !(q && visibleRooms.length===0 && scopedRooms.length>0));
  visibleRooms.forEach(r=>{
    const editableHere = canEditRoom(r);
    const deptLabel = r.department ? escapeHtml(r.department) : '<span class="muted">Shared</span>';
    const actions = editableHere
      ? `<button class="btn btn-sm editRoom" data-id="${r.id}">Edit</button> <button class="btn btn-sm btn-danger delRoom" data-id="${r.id}">Delete</button>`
      : `<span class="muted" style="font-size:12px;">${escapeHtml(r.department||'')} only</span>`;
    const tr = el(`<tr>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td><span class="badge ${r.type==='lab'?'badge-lab':'badge-lecture'}">${r.type==='lab'?'Laboratory':'Lecture Room'}</span></td>
      <td>${deptLabel}</td>
      <td>${r.capacity ? r.capacity : '<span class="muted">—</span>'}</td>
      <td>${actions}</td>
    </tr>`);
    tbody.appendChild(tr);
    // Home-section assignment only makes sense for lecture rooms — labs
    // are always shared across whichever sections need that subject.
    if(r.type === 'lecture'){
      const homeIds = r.homeSectionIds || [];
      const chipsHtml = homeIds.map(sid=>{
        const sec = sectionById(sid);
        if(!sec) return "";
        const rmBtn = editableHere ? ` <button class="rmHomeSec" data-room="${r.id}" data-sec="${sid}">✕</button>` : '';
        return `<span class="chip">${escapeHtml(sec.name)}${sec.department?` <span class="muted" style="font-size:11px;">(${escapeHtml(sec.department)})</span>`:''}${rmBtn}</span>`;
      }).join("") || "<span class='muted' style='font-size:12px;'>No home sections yet — any section may land here.</span>";
      let addControls = '';
      if(editableHere){
        // A department-owned room may only take home sections from that
        // same department; a Shared room may take any section.
        const availableSections = state.sections.filter(s=> !homeIds.includes(s.id) && (!r.department || s.department===r.department));
        addControls = `<div class="row" style="margin-top:8px;">
          <select class="addHomeSecSelect" data-room="${r.id}" style="min-width:200px;">
            <option value="">— add a home section —</option>
            ${availableSections.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}${s.department?' ('+escapeHtml(s.department)+')':''}</option>`).join("")}
          </select>
          <button class="btn btn-sm btn-teal addHomeSecBtn" data-room="${r.id}">Add</button>
        </div>`;
      }
      const sub = el(`<tr class="room-home-row">
        <td colspan="5" style="padding-top:2px; padding-bottom:12px;">
          <div class="subj-chips">${chipsHtml}</div>
          ${addControls}
        </td>
      </tr>`);
      tbody.appendChild(sub);
    }
  });
}
document.getElementById('roomSearchInput').addEventListener('input', function(e){
  roomSearchQuery = e.target.value;
  renderRoomsTable();
});

document.getElementById('roomsTableBody').addEventListener('click', function(e){
  const editBtn = e.target.closest('.editRoom');
  const delBtn = e.target.closest('.delRoom');
  const rmHomeBtn = e.target.closest('.rmHomeSec');
  const addHomeBtn = e.target.closest('.addHomeSecBtn');
  if(editBtn){
    const r = roomById(editBtn.dataset.id);
    if(!canEditRoom(r)){ toast("You can only edit rooms belonging to your department.", 'error'); return; }
    startEditRoom(editBtn.dataset.id);
  }
  if(delBtn){
    const r = roomById(delBtn.dataset.id);
    if(!canEditRoom(r)){ toast("You can only delete rooms belonging to your department.", 'error'); return; }
    if(confirm("Delete this room?")){
      state.rooms = state.rooms.filter(x=>x.id!==delBtn.dataset.id);
      state.schedule = state.schedule.filter(b=>b.roomId!==delBtn.dataset.id);
      persistSharedData(); renderRoomsTable();
    }
  }
  if(rmHomeBtn){
    const room = roomById(rmHomeBtn.dataset.room);
    if(room && canEditRoom(room)){
      room.homeSectionIds = (room.homeSectionIds||[]).filter(id=>id!==rmHomeBtn.dataset.sec);
      persistSharedData(); renderRoomsTable();
    }
  }
  if(addHomeBtn){
    const room = roomById(addHomeBtn.dataset.room);
    if(room && canEditRoom(room)){
      const sel = document.querySelector(`.addHomeSecSelect[data-room="${addHomeBtn.dataset.room}"]`);
      if(sel && sel.value){
        room.homeSectionIds = room.homeSectionIds || [];
        if(!room.homeSectionIds.includes(sel.value)) room.homeSectionIds.push(sel.value);
        persistSharedData(); renderRoomsTable();
      }
    }
  }
});
function startEditRoom(id){
  const r = roomById(id); if(!r) return;
  editingRoomId = id;
  document.getElementById('roomName').value = r.name;
  document.getElementById('roomType').value = r.type;
  document.getElementById('roomCapacity').value = r.capacity||'';
  if(session.isRegistrar) document.getElementById('roomDept').value = r.department || '';
  document.getElementById('roomFormTitle').textContent = "Edit Room";
  document.getElementById('roomSaveBtn').textContent = "Save Changes";
  document.getElementById('roomCancelBtn').style.display = '';
}
function resetRoomForm(){
  editingRoomId = null;
  document.getElementById('roomName').value='';
  document.getElementById('roomType').value='lecture';
  document.getElementById('roomCapacity').value='';
  if(session.isRegistrar) document.getElementById('roomDept').value = '';
  document.getElementById('roomFormTitle').textContent = "Add Room";
  document.getElementById('roomSaveBtn').textContent = "Add Room";
  document.getElementById('roomCancelBtn').style.display = 'none';
}
document.getElementById('roomCancelBtn').addEventListener('click', resetRoomForm);
document.getElementById('roomSaveBtn').addEventListener('click', function(){
  const name = document.getElementById('roomName').value.trim();
  if(!name){ toast("Please enter a room name.", 'error'); return; }
  const type = document.getElementById('roomType').value;
  const capacity = parseInt(document.getElementById('roomCapacity').value,10) || 0;
  // A chair's room is always tagged to their own department — only the
  // registrar gets to choose Shared or a specific department.
  const department = session.isRegistrar ? (document.getElementById('roomDept').value || null) : session.department;
  if(editingRoomId){
    const r = roomById(editingRoomId);
    if(!canEditRoom(r)){ toast("You can only edit rooms belonging to your department.", 'error'); return; }
    Object.assign(r, {name,type,capacity,department});
  } else {
    state.rooms.push({id: uid('room'), name, type, capacity, department});
  }
  persistSharedData();
  resetRoomForm();
  renderRoomsTable();
});

document.getElementById('roomBulkImportBtn').addEventListener('click', function(){
  const text = document.getElementById('roomBulkText').value;
  if(!text.trim()){ toast("Paste some rows first.", 'error'); return; }
  const rows = parseDelimitedText(text);
  let count = 0;
  rows.forEach(cols=>{
    const name = (cols[0]||'').trim();
    if(!name) return;
    const type = (cols[1]||'').trim().toLowerCase() === 'lab' ? 'lab' : 'lecture';
    const capacity = parseInt(cols[2],10) || 0;
    // A chair's bulk-imported rooms always land in their own department;
    // only the registrar's optional 4th column can pick a department (an
    // unrecognized or blank value just stays Shared).
    let department = session.isRegistrar ? null : session.department;
    if(session.isRegistrar){
      const raw = (cols[3]||'').trim().toUpperCase();
      const match = DEPARTMENTS.find(d=>d.toUpperCase()===raw);
      if(match) department = match;
    }
    state.rooms.push({id: uid('room'), name, type, capacity, department});
    count++;
  });
  persistSharedData();
  document.getElementById('roomBulkText').value = '';
  renderRoomsTable();
  toast(count + " room" + (count===1?"":"s") + " imported.", 'success');
});

(async function boot(){
  const ok = await bootSession('rooms');
  if(!ok) return;
  populateRoomDeptSelect();
  // Sections (from every department) are needed here so a Shared lecture
  // room's home-section picker can list them and show their names/
  // departments; a department-owned room's own picker is filtered down to
  // just that department further above.
  await Promise.all([loadSharedData(), loadSectionsAll()]);
  renderRoomsTable();
})();
