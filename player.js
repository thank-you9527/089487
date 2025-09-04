document.addEventListener('DOMContentLoaded', async () => {
  const token = localStorage.getItem('authToken');
  if (!token) return;
  const res = await fetch('/api/character', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return;
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
