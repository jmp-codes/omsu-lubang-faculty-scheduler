import {
  state, uid, el, escapeHtml, roomById, parseDelimitedText,
  bootSession, requireRegistrar, loadSharedData, persistSharedData
} from './shared.js';

let editingRoomId = null;

function renderRoomsTable(){
  const tbody = document.getElementById('roomsTableBody');
  tbody.innerHTML = "";
  document.getElementById('roomsEmpty').classList.toggle('hidden', state.rooms.length>0);
  state.rooms.forEach(r=>{
    const tr = el(`<tr>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td><span class="badge ${r.type==='lab'?'badge-lab':'badge-lecture'}">${r.type==='lab'?'Laboratory':'Lecture Room'}</span></td>
      <td>${r.capacity ? r.capacity : '<span class="muted">—</span>'}</td>
      <td><button class="btn btn-sm editRoom" data-id="${r.id}">Edit</button> <button class="btn btn-sm btn-danger delRoom" data-id="${r.id}">Delete</button></td>
    </tr>`);
    tbody.appendChild(tr);
  });
}
document.getElementById('roomsTableBody').addEventListener('click', function(e){
  const editBtn = e.target.closest('.editRoom');
  const delBtn = e.target.closest('.delRoom');
  if(editBtn) startEditRoom(editBtn.dataset.id);
  if(delBtn){
    if(confirm("Delete this room?")){
      state.rooms = state.rooms.filter(r=>r.id!==delBtn.dataset.id);
      state.schedule = state.schedule.filter(b=>b.roomId!==delBtn.dataset.id);
      persistSharedData(); renderRoomsTable();
    }
  }
});
function startEditRoom(id){
  const r = roomById(id); if(!r) return;
  editingRoomId = id;
  document.getElementById('roomName').value = r.name;
  document.getElementById('roomType').value = r.type;
  document.getElementById('roomCapacity').value = r.capacity||'';
  document.getElementById('roomFormTitle').textContent = "Edit Room";
  document.getElementById('roomSaveBtn').textContent = "Save Changes";
  document.getElementById('roomCancelBtn').style.display = '';
}
function resetRoomForm(){
  editingRoomId = null;
  document.getElementById('roomName').value='';
  document.getElementById('roomType').value='lecture';
  document.getElementById('roomCapacity').value='';
  document.getElementById('roomFormTitle').textContent = "Add Room";
  document.getElementById('roomSaveBtn').textContent = "Add Room";
  document.getElementById('roomCancelBtn').style.display = 'none';
}
document.getElementById('roomCancelBtn').addEventListener('click', resetRoomForm);
document.getElementById('roomSaveBtn').addEventListener('click', function(){
  const name = document.getElementById('roomName').value.trim();
  if(!name){ alert("Please enter a room name."); return; }
  const type = document.getElementById('roomType').value;
  const capacity = parseInt(document.getElementById('roomCapacity').value,10) || 0;
  if(editingRoomId){
    Object.assign(roomById(editingRoomId), {name,type,capacity});
  } else {
    state.rooms.push({id: uid('room'), name, type, capacity});
  }
  persistSharedData();
  resetRoomForm();
  renderRoomsTable();
});

document.getElementById('roomBulkImportBtn').addEventListener('click', function(){
  const text = document.getElementById('roomBulkText').value;
  if(!text.trim()){ alert("Paste some rows first."); return; }
  const rows = parseDelimitedText(text);
  let count = 0;
  rows.forEach(cols=>{
    const name = (cols[0]||'').trim();
    if(!name) return;
    const type = (cols[1]||'').trim().toLowerCase() === 'lab' ? 'lab' : 'lecture';
    const capacity = parseInt(cols[2],10) || 0;
    state.rooms.push({id: uid('room'), name, type, capacity});
    count++;
  });
  persistSharedData();
  document.getElementById('roomBulkText').value = '';
  renderRoomsTable();
  alert(count + " room" + (count===1?"":"s") + " imported.");
});

(async function boot(){
  const ok = await bootSession('rooms');
  if(!ok) return;
  if(!requireRegistrar()) return;
  await loadSharedData();
  renderRoomsTable();
})();
