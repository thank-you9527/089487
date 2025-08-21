const userRegex = /^[A-Za-z0-9!@#$%^&*]{5,20}$/;
const passRegex = /^[A-Za-z0-9!@#$%^&*]{8,20}$/;
let captchaText = '';
let captchaId = '';

async function drawCaptcha() {
  const canvas = document.getElementById('captchaCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const res = await fetch('/api/captcha');
  const data = await res.json();
  captchaId = data.id;
  captchaText = data.text;
  ctx.font = '24px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(captchaText, 10, canvas.height / 2);
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

  if (!userRegex.test(username) || !passRegex.test(password) || captcha !== captchaText) {
    errorMsg.classList.remove('hidden');
    drawCaptcha();
    return;
  }
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, captchaId, captcha })
  });
  if (res.ok) {
    window.location.href = 'login.html';
  } else {
    errorMsg.classList.remove('hidden');
    drawCaptcha();
  }
});
