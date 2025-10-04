const userRegex = /^[A-Za-z0-9!@#$%^&*]{5,20}$/;
const passRegex = /^[A-Za-z0-9!@#$%^&*]{8,20}$/;
let captchaId = '';

async function drawCaptcha() {
  const canvas = document.getElementById('captchaCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const res = await fetch('/api/captcha');
  const data = await res.json();
  captchaId = data.id;
  ctx.font = '24px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(data.text, 10, canvas.height / 2);
}

document.addEventListener('DOMContentLoaded', () => {
  drawCaptcha();
});

const registerBtn = document.getElementById('registerBtn');
const errorMsg = document.getElementById('regError');

registerBtn.addEventListener('click', async () => {
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value.trim();
  const captcha = document.getElementById('regCaptcha').value.trim().toUpperCase();

  errorMsg.classList.add('hidden');
  errorMsg.textContent = '';

  if (!userRegex.test(username) || !passRegex.test(password)) {
    errorMsg.textContent = '帳號或密碼格式不符要求。';
    errorMsg.classList.remove('hidden');
    drawCaptcha();
    return;
  }

  const payload = { username, password };
  if (captchaId) payload.captchaId = captchaId;
  if (captcha) payload.captcha = captcha;

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (res.ok) {
    window.location.href = 'login.html';
    return;
  }

  const data = await res.json().catch(() => ({}));
  let message = '註冊失敗，請再試一次。';
  if (data?.error === 'invalid captcha') {
    message = '驗證碼錯誤，請再試一次。';
  } else if (data?.error === 'username-taken') {
    message = '此帳號已被使用。';
  } else if (data?.error === 'invalid input') {
    message = '帳號或密碼格式不符要求。';
  }
  errorMsg.textContent = message;
  errorMsg.classList.remove('hidden');
  drawCaptcha();
});
