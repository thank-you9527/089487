const qs = (selector, root = document) => root.querySelector(selector);
const on = (el, event, handler) => el && el.addEventListener(event, handler);

const logContainer = qs('#logContainer');
const logsDiv = qs('#logs');
const sendBtn = qs('#sendBtn');
const commandInput = qs('#commandInput');
const searchToggle = qs('#searchToggle');
const searchInput = qs('#searchInput');
const sidebar = qs('#sidebar');
const sidebarToggle = qs('#sidebarToggle');
const logoutBtn = qs('#logoutBtn');
const logManageBtn = qs('#logManageBtn');
const sidebarMain = qs('#sidebarMain');
const clearLogsBtn = qs('#clearLogsBtn');
const exportLogsBtn = qs('#exportLogsBtn');
const downloadBtn = qs('#downloadBtn');
const currentUser = localStorage.getItem('currentUser');
const logKey = currentUser ? `logs_${currentUser}` : 'logs';
const storedLogs = JSON.parse(localStorage.getItem(logKey) || '[]');
let logs = Array.isArray(storedLogs)
  ? storedLogs.map(entry => {
      if (entry && Array.isArray(entry.lines)) {
        return {
          date: entry.date || new Date().toISOString(),
          lines: entry.lines.map(line => String(line ?? ''))
        };
      }
      const text = typeof entry?.text === 'string' ? entry.text : '';
      const legacyLines = text ? String(text).split('\n') : [];
      return {
        date: entry?.date || new Date().toISOString(),
        lines: legacyLines.length > 0 ? legacyLines : ['']
      };
    })
  : [];
let loadedCount = 10; // 每次顯示的筆數
let sessionExpired = false;
let isAuthenticated = false;
const HEARTBEAT_VISIBLE_MS = 60_000;
const HEARTBEAT_HIDDEN_MS = 120_000;
let heartbeatTimer = null;
let heartbeatFailures = 0;
let logoutBeaconSent = false;
let pendingBeaconTimer = null;
let eventSource = null;

function normalizeLines(input) {
  if (Array.isArray(input)) {
    return input.flatMap(line => {
      if (line == null) return [''];
      return String(line)
        .split('\n')
        .map(chunk => chunk);
    });
  }
  if (input == null) return [''];
  return String(input)
    .split('\n')
    .map(chunk => chunk);
}

function appendBlock(lines) {
  const normalized = normalizeLines(lines).map(line => line);
  const entry = { date: new Date().toISOString(), lines: normalized };
  logs.push(entry);
  localStorage.setItem(logKey, JSON.stringify(logs));
  renderLogs();
}

function handleSessionExpired(message = '登入已失效，請重新登入') {
  if (sessionExpired) return;
  sessionExpired = true;
  isAuthenticated = false;
  stopHeartbeat();
  if (eventSource) {
    try {
      eventSource.close();
    } catch (err) {
      // ignore
    }
    eventSource = null;
  }
  alert(message);
  sessionStorage.removeItem('returnShown');
  localStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

async function handleUnauthorizedResponse(res) {
  if (res.status !== 401) return false;
  const data = await res.json().catch(() => ({}));
  const code = data?.error;
  if (code === 'session-timeout') {
    handleSessionExpired('已閒置登出，請重新登入');
  } else if (code === 'session-expired') {
    handleSessionExpired('登入已過期，請重新登入');
  } else if (code === 'session-gone' || code === 'bad-token' || code === 'unauthorized') {
    handleSessionExpired('登入已失效，請重新登入');
  } else {
    handleSessionExpired();
  }
  return true;
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function sendHeartbeat() {
  if (sessionExpired || !isAuthenticated) return false;
  try {
    const res = await fetch('/api/ping', {
      method: 'POST',
      credentials: 'include',
      keepalive: true
    });
    if (await handleUnauthorizedResponse(res)) return false;
    if (!res.ok) throw new Error('heartbeat failed');
    heartbeatFailures = 0;
    return true;
  } catch (err) {
    heartbeatFailures += 1;
    if (heartbeatFailures >= 3) {
      appendBlock('連線異常，請檢查網路或稍後再試。');
      stopHeartbeat();
    }
    return false;
  }
}

function scheduleHeartbeat() {
  if (sessionExpired || !isAuthenticated) return;
  stopHeartbeat();
  const interval = document.hidden ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_VISIBLE_MS;
  heartbeatTimer = setTimeout(async () => {
    await sendHeartbeat();
    if (!sessionExpired && heartbeatFailures < 3) {
      scheduleHeartbeat();
    }
  }, interval);
}

function startHeartbeat() {
  if (!isAuthenticated) return;
  heartbeatFailures = 0;
  stopHeartbeat();
  sendHeartbeat().finally(() => {
    if (!sessionExpired && isAuthenticated && heartbeatFailures < 3) {
      scheduleHeartbeat();
    }
  });
}

function stopEventStream() {
  if (!eventSource) return;
  try {
    eventSource.close();
  } catch (err) {
    // ignore
  }
  eventSource = null;
}

function startEventStream() {
  stopEventStream();
  try {
    eventSource = new EventSource('/api/events', { withCredentials: true });
  } catch (err) {
    console.error('failed to open event stream', err);
    return;
  }
  eventSource.onmessage = evt => {
    if (!evt?.data) return;
    try {
      const payload = JSON.parse(evt.data);
      const candidate = payload?.block ?? payload?.lines ?? payload?.logs;
      if (Array.isArray(candidate)) {
        if (candidate.every(item => Array.isArray(item))) {
          candidate.forEach(block => appendBlock(block));
        } else if (candidate.length > 0) {
          appendBlock(candidate);
        }
      } else if (typeof payload?.message === 'string') {
        appendBlock(payload.message);
      }
    } catch (err) {
      console.error('failed to parse event payload', err);
    }
  };
  eventSource.addEventListener('error', () => {
    // browser will auto-retry; no-op
  });
}

function sendLogoutBeacon() {
  if (sessionExpired || !isAuthenticated) return;
  if (logoutBeaconSent) return;
  logoutBeaconSent = true;
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([], { type: 'application/json' });
      navigator.sendBeacon('/api/logout-beacon', blob);
    } else {
      fetch('/api/logout-beacon', {
        method: 'POST',
        credentials: 'include',
        keepalive: true
      }).catch(() => {});
    }
  } catch (err) {
    fetch('/api/logout-beacon', {
      method: 'POST',
      credentials: 'include',
      keepalive: true
    }).catch(() => {});
  }
  setTimeout(() => {
    logoutBeaconSent = false;
  }, 5000);
}

function scheduleLogoutBeacon() {
  if (pendingBeaconTimer) {
    clearTimeout(pendingBeaconTimer);
    pendingBeaconTimer = null;
  }
  if (sessionExpired || !isAuthenticated) return;
  pendingBeaconTimer = setTimeout(() => {
    pendingBeaconTimer = null;
    sendLogoutBeacon();
  }, 2000);
}

function setupLifecycleHandlers() {
  document.addEventListener('visibilitychange', () => {
    if (sessionExpired || !isAuthenticated) return;
    if (document.visibilityState === 'hidden') {
      scheduleLogoutBeacon();
    } else {
      if (pendingBeaconTimer) {
        clearTimeout(pendingBeaconTimer);
        pendingBeaconTimer = null;
      }
      logoutBeaconSent = false;
    }
    scheduleHeartbeat();
  });

  window.addEventListener('pagehide', () => {
    if (sessionExpired || !isAuthenticated) return;
    sendLogoutBeacon();
  });

  window.addEventListener('beforeunload', () => {
    if (sessionExpired || !isAuthenticated) return;
    sendLogoutBeacon();
  });
}

async function ensureCharacter() {
  const res = await fetch('/api/character', { credentials: 'include' });
  if (await handleUnauthorizedResponse(res)) return false;
  if (res.status === 404) {
    let name = '';
    while (true) {
      name = prompt('請輸入角色名稱（最多10字）：');
      if (!name) return false;
      if (/^[A-Za-z0-9\u4E00-\u9FFF.,•，。_]{1,10}$/.test(name)) break;
    }
    const createRes = await fetch('/api/character', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      credentials: 'include'
    });
    if (await handleUnauthorizedResponse(createRes)) return false;
    if (!createRes.ok) {
      appendBlock('建立角色失敗，請稍後再試。');
      return false;
    }
    isAuthenticated = true;
    return true;
  }
  if (!res.ok) {
    appendBlock('無法讀取角色資料，請稍後再試。');
    return false;
  }
  isAuthenticated = true;
  return true;
}

function createLogFragment(entry) {
  const fragment = document.createDocumentFragment();
  const timestampLine = document.createElement('p');
  timestampLine.className = 'log-timestamp';
  timestampLine.textContent = `[${new Date(entry.date).toLocaleString()}]`;
  fragment.appendChild(timestampLine);

  const lines = Array.isArray(entry.lines)
    ? entry.lines
    : String(entry.text ?? '').split('\n');
  if (lines.length === 0) {
    const emptyLine = document.createElement('p');
    emptyLine.className = 'log-message';
    fragment.appendChild(emptyLine);
  } else {
    lines.forEach((line) => {
      const messageLine = document.createElement('p');
      messageLine.className = 'log-message';
      messageLine.textContent = line;
      fragment.appendChild(messageLine);
    });
  }

  return fragment;
}

function renderLogs() {
  logsDiv.innerHTML = '';
  const start = Math.max(0, logs.length - loadedCount);
  const fragment = document.createDocumentFragment();
  logs.slice(start).forEach((entry) => {
    fragment.appendChild(createLogFragment(entry));
  });
  logsDiv.appendChild(fragment);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function initialMessage() {
  const firstVisitKey = `visited_${currentUser}`;
  const firstVisit = !localStorage.getItem(firstVisitKey);
  const returnShown = sessionStorage.getItem('returnShown');
  if (firstVisit) {
    appendBlock('歡迎您來到遊戲的世界，輸入help以查看指令！');
    localStorage.setItem(firstVisitKey, 'true');
  } else {
    renderLogs();
    if (!returnShown) {
      appendBlock('歡迎您回到遊戲的世界，繼續冒險吧！');
      sessionStorage.setItem('returnShown', 'true');
    }
  }
}

on(sendBtn, 'click', async () => {
  const text = commandInput.value.trim();
  if (!text) return;
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: text }),
      credentials: 'include'
    });
    if (res.status === 401) {
      appendBlock('登入已過期，請重新登入。');
      await handleUnauthorizedResponse(res);
      return;
    }
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retry = data?.retryAfter;
      appendBlock(retry ? `操作太快，請於 ${retry} 秒後再試。` : '操作太快，請稍後再試。');
      return;
    }
    if (!res.ok) {
      const textResp = await res.text().catch(() => '');
      const message = textResp
        ? `伺服器錯誤(${res.status})：${textResp}`
        : `伺服器錯誤(${res.status})：請稍後再試`;
      appendBlock(message);
      return;
    }
    const data = await res.json().catch(() => null);
    if (!data) {
      appendBlock('伺服器回傳格式錯誤，請稍後再試。');
      return;
    }
    if (data.ok === false) {
      const message = typeof data.error === 'string' ? data.error : '指令執行失敗';
      appendBlock(`指令失敗：${message}`);
      return;
    }
    const candidate = data.block ?? data.lines ?? data.logs ?? data.result;
    if (Array.isArray(candidate)) {
      if (candidate.every(item => Array.isArray(item))) {
        candidate.forEach(block => appendBlock(block));
      } else {
        appendBlock(candidate);
      }
    } else if (Array.isArray(data?.blocks)) {
      data.blocks.forEach(block => appendBlock(block));
    } else if (typeof data?.message === 'string') {
      appendBlock(data.message);
    }
  } catch (e) {
    appendBlock('無法連線到伺服器');
  } finally {
    commandInput.value = '';
  }
});

on(searchToggle, 'click', () => {
  if (searchInput.classList.contains('hidden')) {
    searchInput.classList.remove('hidden');
    searchInput.focus();
  } else {
    const keyword = searchInput.value.trim();
    if (keyword) {
      const result = logs.filter((l) => {
        const joined = Array.isArray(l.lines) ? l.lines.join('\n') : String(l.text ?? '');
        return joined.includes(keyword);
      });
      logsDiv.innerHTML = '';
      const fragment = document.createDocumentFragment();
      result.forEach((entry) => {
        fragment.appendChild(createLogFragment(entry));
      });
      logsDiv.appendChild(fragment);
    } else {
      searchInput.classList.add('hidden');
      renderLogs();
    }
  }
});

on(logContainer, 'scroll', () => {
  if (logContainer.scrollTop === 0 && loadedCount < logs.length) {
    loadedCount += 10;
    renderLogs();
    logContainer.scrollTop = 1; // 防止連續觸發
  }
});

on(sidebarToggle, 'click', () => {
  sidebar?.classList.toggle('show');
});

on(logoutBtn, 'click', async () => {
  if (confirm('是否登出？')) {
    try {
      const res = await fetch('/api/logout', { method: 'POST', credentials: 'include' });
      if (res.ok) {
        isAuthenticated = false;
        stopHeartbeat();
        stopEventStream();
        sessionStorage.removeItem('returnShown');
        localStorage.removeItem('currentUser');
        location.href = 'login.html';
      } else {
        await handleUnauthorizedResponse(res);
      }
    } catch (e) {
      appendBlock('登出時發生錯誤，請稍後再試。');
    }
  }
});

on(logManageBtn, 'click', () => {
  if (!sidebarMain) return;
  const opened = sidebarMain.classList.toggle('tools-open');
  if (!opened && downloadBtn) {
    downloadBtn.classList.add('hidden');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !sidebarMain?.classList.contains('tools-open')) return;
  sidebarMain.classList.remove('tools-open');
  downloadBtn?.classList.add('hidden');
});

on(clearLogsBtn, 'click', () => {
  if (confirm('確定清除文字資料？')) {
    localStorage.removeItem(logKey);
    logs = [];
    renderLogs();
  }
});

on(exportLogsBtn, 'click', () => {
  const content = logs
    .map((l) => {
      const header = `[${new Date(l.date).toLocaleString()}]`;
      const body = Array.isArray(l.lines) ? l.lines.join('\n') : String(l.text ?? '');
      return `${header}\n${body}`;
    })
    .join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  if (!downloadBtn) return;
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

setupLifecycleHandlers();
ensureCharacter().then((ok) => {
  if (ok === false) return;
  startHeartbeat();
  startEventStream();
  initialMessage();
});
