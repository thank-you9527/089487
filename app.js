const logContainer = document.getElementById('logContainer');
const logsDiv = document.getElementById('logs');
const sendBtn = document.getElementById('sendBtn');
const commandInput = document.getElementById('commandInput');
const searchToggle = document.getElementById('searchToggle');
const searchInput = document.getElementById('searchInput');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const logoutBtn = document.getElementById('logoutBtn');
const profileBtn = document.getElementById('profileBtn');
const currentUser = localStorage.getItem('currentUser');

let logs = JSON.parse(localStorage.getItem('logs') || '[]');
let loadedCount = 10; // 每次顯示的筆數

async function ensureCharacter() {
  if (!currentUser) return;
  const res = await fetch(`/api/character?username=${encodeURIComponent(currentUser)}`);
  if (res.status === 404) {
    let name = '';
    while (true) {
      name = prompt('請輸入角色名稱（最多10字）：');
      if (!name) return;
      if (/^[A-Za-z0-9\u4E00-\u9FFF.,•，。_]{1,10}$/.test(name)) break;
    }
    await fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser, name })
    });
  }
}

function addLog(text) {
  const entry = { date: new Date().toISOString(), text };
  logs.push(entry);
  localStorage.setItem('logs', JSON.stringify(logs));
  renderLogs();
}

function renderLogs() {
  logsDiv.innerHTML = '';
  const start = Math.max(0, logs.length - loadedCount);
  logs.slice(start).forEach((l) => {
    const p = document.createElement('p');
    p.textContent = `[${new Date(l.date).toLocaleString()}] ${l.text}`;
    logsDiv.appendChild(p);
  });
  logContainer.scrollTop = logContainer.scrollHeight;
}

function initialMessage() {
  const visited = localStorage.getItem('visited');
  if (!visited) {
    addLog('歡迎您來到遊戲的世界，輸入help以查看指令！');
    localStorage.setItem('visited', 'true');
  } else {
    renderLogs();
    addLog('歡迎您回到遊戲的世界，繼續冒險吧！');
  }
}

sendBtn.addEventListener('click', async () => {
  const text = commandInput.value.trim();
  if (!text) return;
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser, command: text })
  });
  const data = await res.json();
  (data.logs || []).forEach((l) => addLog(l));
  commandInput.value = '';
});

searchToggle.addEventListener('click', () => {
  if (searchInput.classList.contains('hidden')) {
    searchInput.classList.remove('hidden');
    searchInput.focus();
  } else {
    const keyword = searchInput.value.trim();
    if (keyword) {
      const result = logs.filter((l) => l.text.includes(keyword));
      logsDiv.innerHTML = '';
      result.forEach((l) => {
        const p = document.createElement('p');
        p.textContent = `[${new Date(l.date).toLocaleString()}] ${l.text}`;
        logsDiv.appendChild(p);
      });
    } else {
      searchInput.classList.add('hidden');
      renderLogs();
    }
  }
});

logContainer.addEventListener('scroll', () => {
  if (logContainer.scrollTop === 0 && loadedCount < logs.length) {
    loadedCount += 10;
    renderLogs();
    logContainer.scrollTop = 1; // 防止連續觸發
  }
});

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('show');
});

profileBtn.addEventListener('click', () => {
  window.location.href = 'player.html';
});

logoutBtn.addEventListener('click', () => {
  if (confirm('是否登出？')) {
    localStorage.clear();
    location.reload();
  }
});

ensureCharacter().then(initialMessage);
