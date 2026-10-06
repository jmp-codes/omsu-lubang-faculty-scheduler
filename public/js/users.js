import { bootSession, requireRegistrar, escapeHtml, apiFetch, session } from './shared.js';

let users = [];

function renderUsersTable(){
  const tbody = document.getElementById('usersTableBody');
  tbody.innerHTML = "";
  document.getElementById('usersEmpty').classList.toggle('hidden', users.length>0);
  users.forEach(u=>{
    const tr = document.createElement('tr');
    const roleLabel = u.role === 'registrar' ? 'Registrar' : u.role.replace('chair-','') + ' Program Chair';
    const isSelf = u.email === session.email;
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}${isSelf ? ' <span class="muted" style="font-size:12px;">(you)</span>' : ''}</td>
      <td>${escapeHtml(roleLabel)}</td>
      <td>${isSelf ? '' : `<button class="btn btn-sm btn-danger delUserBtn" data-email="${escapeHtml(u.email)}">Delete</button>`}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function reload(){
  users = await apiFetch('/api/users');
  renderUsersTable();
}

document.getElementById('userSaveBtn').addEventListener('click', async function(){
  const email = document.getElementById('userEmail').value.trim();
  const password = document.getElementById('userPassword').value;
  const role = document.getElementById('userRole').value;
  if(!email || !email.includes('@')){ alert("Please enter a valid email."); return; }
  if(password.length < 8){ alert("Password must be at least 8 characters."); return; }
  try{
    await apiFetch('/api/users', {method:'POST', body: JSON.stringify({email, password, role})});
    document.getElementById('userEmail').value = '';
    document.getElementById('userPassword').value = '';
    await reload();
  }catch(err){
    alert("Could not create the account: " + err.message);
  }
});

document.getElementById('usersTableBody').addEventListener('click', async function(e){
  const delBtn = e.target.closest('.delUserBtn');
  if(!delBtn) return;
  const email = delBtn.dataset.email;
  if(!confirm(`Delete the account for ${email}? They won't be able to log in anymore.`)) return;
  try{
    await apiFetch('/api/users?email='+encodeURIComponent(email), {method:'DELETE'});
    await reload();
  }catch(err){
    alert("Could not delete the account: " + err.message);
  }
});

(async function boot(){
  const ok = await bootSession('users');
  if(!ok) return;
  if(!requireRegistrar()) return;
  await reload();
})();
