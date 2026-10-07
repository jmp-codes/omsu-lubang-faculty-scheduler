import {
  state, session, expectedBlockIds, computeMissing,
  bootSession, loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadSharedData
} from './shared.js';

// Only the registrar/chair-shared pages (Rooms/Assign/Schedule) load
// state.schedule at all — see boot() below — so this banner only makes
// sense, and is only shown, for a registrar. A chair without
// session.isRegistrar never has state.schedule populated here, so there's
// nothing reliable to warn them about from this page.
function renderStatusBanner(){
  const mount = document.getElementById('homeStatusBanner');
  if(!mount) return;
  if(!session.isRegistrar){ mount.innerHTML = ''; return; }
  if(state.schedule.length === 0){ mount.innerHTML = ''; return; }
  const missing = computeMissing().length;
  if(missing === 0){ mount.innerHTML = ''; return; }
  mount.innerHTML = `<div class="warn-box">
    <strong>${missing} session${missing===1?'':'s'} still unscheduled.</strong>
    Head to <a href="schedule.html" style="color:#ffd7dc; text-decoration:underline;">Generate Schedule</a> to place ${missing===1?'it':'them'} manually.
  </div>`;
}

function renderCards(){
  const grid = document.getElementById('homeGrid');
  const cards = [
    {href:'faculty.html', title:'Faculty', n:state.faculty.length, d:'faculty members'},
    {href:'subjects.html', title:'Subjects', n:state.subjects.length, d:'subjects'},
    {href:'sections.html', title:'Sections', n:state.sections.length, d:'sections'}
  ];
  if(session.isRegistrar){
    cards.push(
      {href:'rooms.html', title:'Rooms', n:state.rooms.length, d:'rooms'},
      {href:'assign.html', title:'Assign Instructors', n:Object.keys(state.assignments).length, d:'assignments made'},
      {href:'schedule.html', title:'Generate Schedule', n:state.schedule.length, d:`sessions placed · ${computeMissing().length} unscheduled`}
    );
  }
  grid.innerHTML = cards.map(c=>`
    <a class="home-card" href="${c.href}">
      <h3>${c.title}</h3>
      <div class="n">${c.n}</div>
      <div class="d">${c.d}</div>
    </a>
  `).join("");
}

(async function boot(){
  const ok = await bootSession('home');
  if(!ok) return;
  await loadFacultyAll();
  await loadSubjectsAll();
  await loadSectionsAll();
  if(session.isRegistrar) await loadSharedData();
  renderStatusBanner();
  renderCards();
})();
