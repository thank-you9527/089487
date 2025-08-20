const loginBtn = document.getElementById('loginBtn');
const createUserBtn = document.getElementById('createUserBtn');
const errorMsg = document.getElementById('loginError');

createUserBtn.addEventListener('click', () => {
  window.location.href = 'register.html';
});

loginBtn.addEventListener('click', async () => {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (res.ok) {
    localStorage.setItem('currentUser', username);
    window.location.href = 'index.html';
  } else {
    errorMsg.classList.remove('hidden');
  }
});
