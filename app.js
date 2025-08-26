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
const logManageBtn = document.getElementById('logManageBtn');
const sidebarMain = document.getElementById('sidebarMain');
const logManager = document.getElementById('logManager');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const exportLogsBtn = document.getElementById('exportLogsBtn');
const backBtn = document.getElementById('backBtn');
const downloadBtn = document.getElementById('downloadBtn');
const currentUser = localStorage.getItem('currentUser');
const token = localStorage.getItem('authToken');
const logKey = currentUser ? `logs_${currentUser}` : 'logs';
let logs = JSON.parse(localStorage.getItem(logKey) || '[]');
let loadedCount = 10; // 每次顯示的筆數

async function ensureCharacter() {
  if (!token) return;
  const res = await fetch('/api/character', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (res.status === 404) {
    let name = '';
    while (true) {
      name = prompt('請輸入角色名稱（最多10字）：');
      if (!name) return;
      if (/^[A-Za-z0-9\u4E00-\u9FFF.,•，。_]{1,10}$/.test(name)) break;
    }
    await fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name })
    });
  }
}

function addLog(text) {
  const entry = { date: new Date().toISOString(), text };
  logs.push(entry);
  localStorage.setItem(logKey, JSON.stringify(logs));
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
  const firstVisitKey = `visited_${currentUser}`;
  const firstVisit = !localStorage.getItem(firstVisitKey);
  const returnShown = sessionStorage.getItem('returnShown');
  if (firstVisit) {
    addLog('歡迎您來到遊戲的世界，輸入help以查看指令！');
    localStorage.setItem(firstVisitKey, 'true');
  } else {
    renderLogs();
    if (!returnShown) {
      addLog('歡迎您回到遊戲的世界，繼續冒險吧！');
      sessionStorage.setItem('returnShown', 'true');
    }
  }
}

sendBtn.addEventListener('click', async () => {
  const text = commandInput.value.trim();
  if (!text) return;
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ command: text })
    });
    if (res.ok) {
      const data = await res.json();
      (data.logs || []).forEach((l) => addLog(l));
    } else {
      addLog('指令送出失敗（請確認登入或伺服器狀態）');
    }
  } catch (e) {
    addLog('無法連線到伺服器');
  } finally {
    commandInput.value = '';
  }
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
    sessionStorage.removeItem('returnShown');
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    location.href = 'login.html';
  }
});

logManageBtn.addEventListener('click', () => {
  sidebarMain.classList.add('hidden');
  logManager.classList.remove('hidden');
});

backBtn.addEventListener('click', () => {
  logManager.classList.add('hidden');
  sidebarMain.classList.remove('hidden');
  downloadBtn.classList.add('hidden');
});

clearLogsBtn.addEventListener('click', () => {
  if (confirm('確定清除文字資料？')) {
    localStorage.removeItem(logKey);
    logs = [];
    renderLogs();
  }
});

exportLogsBtn.addEventListener('click', () => {
  const content = logs
    .map((l) => `[${new Date(l.date).toLocaleString()}] ${l.text}`)
    .join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  downloadBtn.classList.remove('hidden');
  downloadBtn.onclick = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentUser || 'logs'}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    downloadBtn.classList.add('hidden');
  };
});

ensureCharacter().then(initialMessage);
