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
  } else {
    let message = '登入失敗，請再試一次。';
    if (res.status === 409) {
      message = '此帳號已在其他地方登入。';
    } else {
      const data = await res.json().catch(() => ({}));
      if (data && data.error === 'invalid credentials') {
        message = '帳號或密碼錯誤。';
      }
    }
    errorMsg.textContent = message;
    errorMsg.classList.remove('hidden');
  }
});
