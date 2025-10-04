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
    body: JSON.stringify({ username, password }),
    credentials: 'include'
  });
  if (res.ok) {
    localStorage.setItem('currentUser', username);
    window.location.href = 'index.html';
    return;
  }
  let message = '登入失敗，請再試一次。';
  if (res.status === 401) {
    message = '帳號或密碼錯誤。';
  }
  errorMsg.textContent = message;
  errorMsg.classList.remove('hidden');
});
