function handleAuthFailure(code) {
  let message = '登入已失效，請重新登入';
  if (code === 'session-timeout') message = '已閒置登出，請重新登入';
  else if (code === 'session-expired') message = '登入已過期，請重新登入';
  alert(message);
  localStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', async () => {
  const res = await fetch('/api/character', { credentials: 'include' });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    handleAuthFailure(data?.error);
    return;
  }
  if (res.status === 404) {
    alert('尚未建立角色，請先返回遊戲頁面創角。');
    window.location.href = 'index.html';
    return;
  }
  if (!res.ok) {
    alert('無法載入角色資訊，請稍後再試。');
    return;
  }
  const c = await res.json();
  const infoDiv = document.getElementById('info');
  const fields = [
    ['名稱', c.name],
    ['日齡', c.dayAge],
    ['等級', c.level],
    ['身份', c.identity],
    ['道德', c.morality],
    ['行動值', c.action],
    ['攻擊力', c.attack],
    ['血量', c.hp],
    ['經驗值', `${c.exp.current}/${c.exp.max}`],
    ['位置', `(${c.position.x},${c.position.y},${c.position.z})`],
    ['簡介', c.bio || '看屁看']
  ];
  fields.forEach(([k, v]) => {
    const p = document.createElement('p');
    p.textContent = `${k}：${v}`;
    infoDiv.appendChild(p);
  });
});
