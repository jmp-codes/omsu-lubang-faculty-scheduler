import {
  state, session, expectedBlockIds, computeMissing,
  bootSession, loadFacultyAll, loadSubjectsAll, loadSectionsAll, loadSharedData
} from './shared.js';

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
  renderCards();
})();
