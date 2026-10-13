// 全局状态
let currentStatus = null;
let currentConfig = null;
let eventSource = null;
let currentHistoryDays = 7;
let currentTheme = localStorage.getItem('ms_rewards_theme') || 'auto';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUIEvents();
  startCountdownTimer();
  fetchStatus();
  fetchConfig();
  fetchHistory(7);
  initLogStream();
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
});

// 初始化日夜模式与跟随系统
function initTheme() {
  applyTheme(currentTheme);

  // 监听操作系统深色/浅色模式切换
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme === 'auto') {
      applyTheme('auto');
    }
  });

  // 顶部胶囊切换事件
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTheme = btn.getAttribute('data-theme-val');
      setTheme(targetTheme);
    });
  });

  // 配置中心下拉框切换事件
  document.getElementById('cfg-ui-theme')?.addEventListener('change', (e) => {
    setTheme(e.target.value);
  });
}

function setTheme(theme, syncServer = true) {
  currentTheme = theme;
  localStorage.setItem('ms_rewards_theme', theme);
  applyTheme(theme);
  const selectElem = document.getElementById('cfg-ui-theme');
  if (selectElem) selectElem.value = theme;
  if (syncServer) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: { theme } })
    }).catch(() => {});
  }
}

function applyTheme(theme) {
  let isDark = true;
  if (theme === 'dark') {
    isDark = true;
  } else if (theme === 'light') {
    isDark = false;
  } else {
    // auto: 跟随系统
    isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

  // 更新顶部胶囊按钮状态
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme-val') === theme);
  });
}

// 启动每日刷新剩余时间倒计时 (距离次日 00:00:00)
function startCountdownTimer() {
  function updateTimer() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const diff = Math.max(0, midnight.getTime() - now.getTime());
    const hours = String(Math.floor(diff / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
    const timerElem = document.getElementById('countdown-timer');
    if (timerElem) {
      timerElem.innerText = `${hours}:${minutes}:${seconds}`;
    }
  }
  updateTimer();
  setInterval(updateTimer, 1000);
}

function initUIEvents() {
  // 立即运行 & 停止
  document.getElementById('btn-run').addEventListener('click', runTasks);
  document.getElementById('btn-stop').addEventListener('click', stopTasks);

  // 历史记录天数切换
  document.getElementById('btn-history-7')?.addEventListener('click', () => switchHistoryDays(7));
  document.getElementById('btn-history-30')?.addEventListener('click', () => switchHistoryDays(30));

  // 顶部快捷测试账号登录
  document.getElementById('btn-check-account').addEventListener('click', () => {
    openModal('diag-modal');
    runAccountDiagnosis();
  });
  document.getElementById('btn-close-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-confirm-diag').addEventListener('click', () => closeModal('diag-modal'));
  document.getElementById('btn-retest-diag').addEventListener('click', runAccountDiagnosis);

  // 向导 Modal
  document.getElementById('btn-guide').addEventListener('click', () => openModal('guide-modal'));
  document.getElementById('btn-close-guide').addEventListener('click', () => closeModal('guide-modal'));
  document.getElementById('btn-finish-guide').addEventListener('click', () => closeModal('guide-modal'));

  // 配置中心 Modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    populateSettingsForm();
    openModal('settings-modal');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-cancel-settings').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromModal);

  // 向导换取 Token
  document.getElementById('guide-btn-exchange').addEventListener('click', async () => {
    const input = document.getElementById('guide-code-input').value.trim();
    const resultDiv = document.getElementById('guide-token-result');
    if (!input) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先填入地址栏跳转后的完整 URL</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在换取并验证 Token...</span>';
    try {
      const res = await fetch('/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urlOrCode: input })
      }).then(r => r.json());
      if (res.success) {
        resultDiv.innerHTML = '<span style="color:#34D399;">✅ Token 换取成功！已自动持久化保存</span>';
        fetchConfig();
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 换取失败: ${res.message}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 请求异常: ${e.message}</span>`;
    }
  });

  // 向导测试 Cookie
  document.getElementById('guide-btn-test-cookie').addEventListener('click', async () => {
    const cookie = document.getElementById('guide-cookie-input').value.trim();
    const resultDiv = document.getElementById('guide-cookie-result');
    if (!cookie) {
      resultDiv.innerHTML = '<span style="color:#EF4444;">请先粘贴 Cookie</span>';
      return;
    }
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求微软官网验证 Cookie...</span>';
    try {
      const testRes = await fetch('/api/auth/test-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie })
      }).then(r => r.json());
      if (testRes.success && testRes.data?.valid) {
        resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${testRes.data.message}（已自动保存）</span>`;
        fetchStatus();
        fetchConfig();
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ ${testRes.data?.message || testRes.message || 'Cookie 检测无效'}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 检测请求出错: ${e.message}</span>`;
    }
  });

  // 向导测试代理与 IP
  document.getElementById('guide-btn-test-proxy').addEventListener('click', async () => {
    const useProxy = document.getElementById('guide-use-proxy').checked;
    const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
    const resultDiv = document.getElementById('guide-proxy-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在检测网络连通性与出口归属...</span>';
    try {
      const res = await fetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useProxy, proxyUrl })
      }).then(r => r.json());
      if (res.success) {
        if (res.regionPass) {
          resultDiv.innerHTML = `<span style="color:#34D399;">✅ 地区检测通过！当前出口位于：中国大陆 (${res.region})<br>${res.ipInfo}</span>`;
        } else {
          resultDiv.innerHTML = `<span style="color:#F59E0B;">⚠️ 警告：当前出口为非大陆地区 (${res.region})！若开启国区保护任务将被自动暂停。<br>${res.ipInfo}</span>`;
        }
      } else {
        resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试失败: ${res.message}</span>`;
      }
    } catch (e) {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ 测试异常: ${e.message}</span>`;
    }
  });

  // 清空日志
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    document.getElementById('terminal-logs').innerHTML = '';
  });

  // 配置中心：一键换取/刷新 Token
  document.getElementById('btn-exchange-token')?.addEventListener('click', async () => {
    const input = document.getElementById('cfg-authcode').value.trim();
    if (!input) return alert('请先填入包含 code 的链接或授权码');
    const res = await fetch('/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlOrCode: input })
    }).then(r => r.json());
    if (res.success) {
      alert('Token 换取并保存成功！');
      fetchConfig();
    } else {
      alert(`换取失败: ${res.message}`);
    }
  });

  // 配置中心：一键测试账户有效性
  document.getElementById('btn-test-account')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('test-account-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在全面检测账户...</span>';
    const res = await fetch('/api/auth/test', { method: 'POST' }).then(r => r.json());
    if (res.success) {
      const c = res.data.cookie;
      const t = res.data.token;
      resultDiv.innerHTML = `
        <div>Cookie 状态: ${c.valid ? '✅ ' + c.message : '❌ ' + c.message}</div>
        <div>OAuth Token: ${t.valid ? '✅ ' + t.message : '❌ ' + t.message}</div>
      `;
    }
  });

  // 配置中心：测试网络代理
  document.getElementById('btn-test-proxy-settings')?.addEventListener('click', async () => {
    const useProxy = document.getElementById('cfg-use-proxy').checked;
    const proxyUrl = document.getElementById('cfg-proxy-url').value.trim();
    const resultDiv = document.getElementById('test-proxy-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在测试网络与代理...</span>';
    const res = await fetch('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy, proxyUrl })
    }).then(r => r.json());
    if (res.success) {
      resultDiv.innerHTML = `<div>地区检测: ${res.regionPass ? '✅ 通过 (' + res.region + ')' : '⚠️ 报警 (' + res.region + ')'}</div><div>${res.ipInfo}</div>`;
    } else {
      resultDiv.innerHTML = `<div style="color:#EF4444;">测试失败: ${res.message}</div>`;
    }
  });

  // 配置中心 Tabs 切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // 向导 Steps 切换
  document.querySelectorAll('.step-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const step = item.getAttribute('data-step');
      switchStep(step);
    });
  });
}

function switchStep(stepNum) {
  document.querySelectorAll('.step-nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.step-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.step-nav-item[data-step="${stepNum}"]`)?.classList.add('active');
  document.getElementById(`step-${stepNum}`)?.classList.add('active');
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

// 获取状态并渲染大屏
async function fetchStatus() {
  try {
    const res = await fetch('/api/status').then(r => r.json());
    if (res.success && res.data) {
      currentStatus = res.data;
      renderDashboard(res.data);
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}

// 渲染大屏
function renderDashboard(data) {
  const { running, stats, timeline } = data;

  // 1. 系统运行状态
  const statusBadge = document.getElementById('system-status-badge');
  const statusText = document.getElementById('status-text');
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');

  if (running) {
    statusBadge.className = 'status-pill status-running';
    statusText.innerText = '正在执行全套自动化任务...';
    btnRun.style.display = 'none';
    btnStop.style.display = 'inline-flex';
  } else {
    statusBadge.className = 'status-pill status-idle';
    statusText.innerText = '后台定时就绪中';
    btnRun.style.display = 'inline-flex';
    btnStop.style.display = 'none';
  }

  // 2. Hero 卡片
  document.getElementById('stat-earned').innerText = `+${stats.earned || 0}`;
  document.getElementById('stat-balance').innerText = (stats.balance || 0).toLocaleString();
  document.getElementById('stat-streak').innerText = `${stats.streakDays || 0} 天`;

  // 渲染印章进度 (如 8 / 12)
  const stamps = stats.stamps || { progress: 8, max: 12 };
  const statStamps = document.getElementById('stat-stamps');
  const statStampsDesc = document.getElementById('stat-stamps-desc');
  if (statStamps) {
    statStamps.innerText = `${stamps.progress || 8} / ${stamps.max || 12}`;
  }
  if (statStampsDesc) {
    const diff = Math.max(0, (stamps.max || 12) - (stamps.progress || 8));
    statStampsDesc.innerText = diff > 0 ? `还差 ${diff} 个集满 1,000 积分大奖` : '1,000 奖励印章已集满！';
  }

  const tasksList = Object.entries(stats.tasks || {});
  const totalTasks = tasksList.length;
  const doneTasks = tasksList.filter(([_, t]) => t.done || (t.max > 0 && t.progress >= t.max)).length;
  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  document.getElementById('stat-percent').innerText = `${percent}%`;
  document.getElementById('stat-done-count').innerText = `${doneTasks} / ${totalTasks} 项任务完成`;

  if (stats.lastUpdate) {
    document.getElementById('last-update-time').innerText = `最后数据同步: ${new Date(stats.lastUpdate).toLocaleTimeString('zh-CN')}`;
  }

  // 3. 渲染任务网格
  const taskGrid = document.getElementById('task-grid');
  taskGrid.innerHTML = '';

  for (const [key, t] of tasksList) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const isDone = t.done || (t.max > 0 && t.progress >= t.max);
    
    let subtext = isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行');
    let pointsBadge = `+${t.points || 0} 积分`;
    let progressLabel = `进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}`;
    let progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

    // 针对桌面专属任务做专门定制展示
    if (key === 'desktopApp') {
      const p = t.progress || 3;
      const m = t.max || 8;
      progPercent = Math.round((p / m) * 100);
      subtext = `${t.expiresText || '到期日期 5 天后'} · 每周打孔卡`;
      progressLabel = `进度: ${p} / ${m} 个任务`;
      pointsBadge = `+${t.points || 20} 积分`;
    }

    card.innerHTML = `
      <div class="task-top">
        <div class="task-info">
          <div class="task-icon">${t.icon || '📌'}</div>
          <div>
            <div class="task-name">${t.name}</div>
            <div class="task-subtext">${subtext}</div>
          </div>
        </div>
        <div class="pts-badge">${pointsBadge}</div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>${progressLabel}</span>
          <span>${progPercent}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${progPercent}%;"></div>
        </div>
      </div>
    `;
    taskGrid.appendChild(card);
  }

  // 4. 渲染时间轴
  const timelineList = document.getElementById('timeline-list');
  if (timeline && timeline.length > 0) {
    timelineList.innerHTML = timeline.map(item => `
      <div class="timeline-item">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-tag">[${item.tag}]</span>
        <span>${item.text}</span>
      </div>
    `).join('');
  }
}

// 建立 SSE 实时日志流
function initLogStream() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/logs/stream');

  const terminal = document.getElementById('terminal-logs');
  const chkAutoScroll = document.getElementById('chk-auto-scroll');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        terminal.innerHTML = '';
        data.logs.forEach(log => appendLog(log));
      } else if (data.type === 'log') {
        appendLog(data.entry);
      }
    } catch (e) {
      console.error('解析日志流失败:', e);
    }
  };

  function appendLog(log) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = `<span class="log-time">[${log.time}]</span> <span>${log.icon}</span> ${log.tag ? `<strong>[${log.tag}]</strong> ` : ''}${escapeHtml(log.message)}`;
    terminal.appendChild(div);
    if (chkAutoScroll.checked) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function runTasks() {
  const res = await fetch('/api/tasks/run', { method: 'POST' }).then(r => r.json());
  if (res.success) {
    fetchStatus();
  } else {
    alert(res.message);
  }
}

async function stopTasks() {
  await fetch('/api/tasks/stop', { method: 'POST' });
  fetchStatus();
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config').then(r => r.json());
    if (res.success) {
      currentConfig = res.data;
      if (res.data.ui?.theme && !localStorage.getItem('ms_rewards_theme')) {
        setTheme(res.data.ui.theme, false);
      }
      const cronHint = document.getElementById('cron-hint');
      if (cronHint) {
        cronHint.innerText = `定时巡检: ${res.data.schedule?.enabled ? res.data.schedule?.cron : '已停用'}`;
      }
    }
  } catch (e) {
    console.error('获取配置失败:', e);
  }
}

function populateSettingsForm() {
  if (!currentConfig) return;
  const c = currentConfig;
  // 主题
  const themeVal = c.ui?.theme || localStorage.getItem('ms_rewards_theme') || 'auto';
  const themeSelect = document.getElementById('cfg-ui-theme');
  if (themeSelect) themeSelect.value = themeVal;

  // 账户
  document.getElementById('cfg-cookie').value = c.account?.cookie || '';
  document.getElementById('cfg-authcode').value = c.account?.authCodeUrl || '';
  document.getElementById('cfg-refresh-token').value = c.account?.refreshToken ? '********' : '';
  // 网络
  document.getElementById('cfg-use-proxy').checked = !!c.network?.useProxy;
  document.getElementById('cfg-proxy-url').value = c.network?.proxyUrl || '';
  document.getElementById('cfg-lock-region').checked = c.network?.lockRegion !== false;
  // 任务
  document.getElementById('cfg-task-sign').checked = c.tasks?.sign !== false;
  document.getElementById('cfg-task-read').checked = c.tasks?.read !== false;
  document.getElementById('cfg-task-search').checked = c.tasks?.search !== false;
  document.getElementById('cfg-task-promos').checked = c.tasks?.promos !== false;
  document.getElementById('cfg-task-dailyset').checked = c.tasks?.dailySet !== false;
  document.getElementById('cfg-task-desktop').checked = c.tasks?.desktopApp !== false;
  document.getElementById('cfg-task-keep').checked = c.tasks?.keepRunning !== false;
  document.getElementById('cfg-search-span').value = c.tasks?.searchSpan || 30;
  document.getElementById('cfg-search-api').value = c.tasks?.searchApi || 'offline';
  // 调度
  document.getElementById('cfg-sched-enabled').checked = c.schedule?.enabled !== false;
  document.getElementById('cfg-sched-cron').value = c.schedule?.cron || '*/25 * * * *';
  // 通知
  document.getElementById('cfg-notify-wework').value = c.notify?.wework || '';
  document.getElementById('cfg-notify-dingding').value = c.notify?.dingding || '';
  document.getElementById('cfg-notify-feishu').value = c.notify?.feishu || '';
  document.getElementById('cfg-notify-bark').value = c.notify?.bark || '';
  document.getElementById('cfg-notify-pushme').value = c.notify?.pushme || '';
  document.getElementById('cfg-notify-tg-token').value = c.notify?.telegram?.botToken || '';
  document.getElementById('cfg-notify-tg-chat').value = c.notify?.telegram?.chatId || '';
}

async function saveSettingsFromModal() {
  const updateData = {
    account: {
      cookie: document.getElementById('cfg-cookie').value.trim(),
      authCodeUrl: document.getElementById('cfg-authcode').value.trim()
    },
    network: {
      useProxy: document.getElementById('cfg-use-proxy').checked,
      proxyUrl: document.getElementById('cfg-proxy-url').value.trim(),
      lockRegion: document.getElementById('cfg-lock-region').checked
    },
    tasks: {
      sign: document.getElementById('cfg-task-sign').checked,
      read: document.getElementById('cfg-task-read').checked,
      search: document.getElementById('cfg-task-search').checked,
      promos: document.getElementById('cfg-task-promos').checked,
      dailySet: document.getElementById('cfg-task-dailyset').checked,
      desktopApp: document.getElementById('cfg-task-desktop').checked,
      keepRunning: document.getElementById('cfg-task-keep').checked,
      searchSpan: Number(document.getElementById('cfg-search-span').value) || 30,
      searchApi: document.getElementById('cfg-search-api').value
    },
    ui: {
      theme: document.getElementById('cfg-ui-theme')?.value || 'auto'
    },
    schedule: {
      enabled: document.getElementById('cfg-sched-enabled').checked,
      cron: document.getElementById('cfg-sched-cron').value.trim()
    },
    notify: {
      wework: document.getElementById('cfg-notify-wework').value.trim(),
      dingding: document.getElementById('cfg-notify-dingding').value.trim(),
      feishu: document.getElementById('cfg-notify-feishu').value.trim(),
      bark: document.getElementById('cfg-notify-bark').value.trim(),
      pushme: document.getElementById('cfg-notify-pushme').value.trim(),
      telegram: {
        botToken: document.getElementById('cfg-notify-tg-token').value.trim(),
        chatId: document.getElementById('cfg-notify-tg-chat').value.trim()
      }
    }
  };

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateData)
  }).then(r => r.json());

  if (res.success) {
    alert('配置已成功保存并即时生效！');
    closeModal('settings-modal');
    fetchConfig();
  } else {
    alert(`保存失败: ${res.message}`);
  }
}

async function saveGuideSettings() {
  const useProxy = document.getElementById('guide-use-proxy').checked;
  const proxyUrl = document.getElementById('guide-proxy-url').value.trim();
  const lockRegion = document.getElementById('guide-lock-region').checked;

  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      network: { useProxy, proxyUrl, lockRegion }
    })
  });

  switchStep(4);
}

window.testNotifyChannel = async function(channel) {
  let val = '';
  if (channel === 'telegram') {
    const botToken = document.getElementById('cfg-notify-tg-token')?.value.trim();
    const chatId = document.getElementById('cfg-notify-tg-chat')?.value.trim();
    if (!botToken || !chatId) return alert('请先输入 Telegram Bot Token 和 Chat ID');
    val = JSON.stringify({ botToken, chatId });
  } else {
    const idMap = {
      wework: 'cfg-notify-wework',
      dingding: 'cfg-notify-dingding',
      feishu: 'cfg-notify-feishu',
      bark: 'cfg-notify-bark',
      pushme: 'cfg-notify-pushme'
    };
    val = document.getElementById(idMap[channel])?.value.trim();
    if (!val) return alert('请先输入配置的值');
  }

  try {
    const res = await fetch('/api/notify/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, value: val })
    }).then(r => r.json());
    if (res.success) {
      alert(`「${channel}」测试消息发送成功，请查收！`);
    } else {
      alert(`测试发送失败: ${res.message}`);
    }
  } catch (e) {
    alert(`测试异常: ${e.message}`);
  }
};

// 全面运行账号登录状态体检
async function runAccountDiagnosis() {
  const loading = document.getElementById('diag-loading');
  const content = document.getElementById('diag-content');
  loading.style.display = 'block';
  content.style.display = 'none';

  try {
    const res = await fetch('/api/auth/test', { method: 'POST' }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '诊断接口异常');

    const data = res.data;
    const cookie = data.cookie || {};
    const token = data.token || {};
    const net = data.network || {};

    // 1. 综合 Banner
    const banner = document.getElementById('diag-banner');
    const bIcon = document.getElementById('diag-banner-icon');
    const bTitle = document.getElementById('diag-banner-title');
    const bSub = document.getElementById('diag-banner-sub');

    if (data.allValid && net.regionPass) {
      banner.className = 'diag-banner ok';
      bIcon.innerText = '🟢';
      bTitle.innerText = '账号登录完全正常 (双端在线)';
      bSub.innerText = '当前 Docker 环境已完美就绪，所有任务通道与网络环境均处于最佳状态！';
    } else if (data.overallValid) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = '账号部分登录有效';
      bSub.innerText = '部分通道已连接，但仍有项未就绪（如网页端或移动端单边未登录），请根据下方提示补充。';
    } else {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = '账号尚未成功在 Docker 中登录';
      bSub.innerText = '未检测到有效的微软登录凭据，请点击右上角「新手配置向导」进行绑定。';
    }

    // 2. 网页端 Cookie 卡片
    const pillCookie = document.getElementById('diag-pill-cookie');
    const detailCookie = document.getElementById('diag-detail-cookie');
    if (cookie.valid) {
      pillCookie.className = 'diag-status-pill pill-ok';
      pillCookie.innerText = '已登录正常';
      detailCookie.innerHTML = `
        <div>状态：✅ 身份认证有效，可执行 PC 搜索、每日活动集与桌面专属任务</div>
        <div style="margin-top:4px; color:#E2E8F0;">${cookie.message || ''}</div>
      `;
    } else {
      pillCookie.className = 'diag-status-pill pill-err';
      pillCookie.innerText = '未登录 / 失效';
      detailCookie.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${cookie.message || 'Cookie 缺失或已失效'}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：在电脑登录 rewards.bing.com，按 F12 复制完整 Cookie 粘贴到配置中心。</div>
      `;
    }

    // 3. 移动端 Token 卡片
    const pillToken = document.getElementById('diag-pill-token');
    const detailToken = document.getElementById('diag-detail-token');
    if (token.valid) {
      pillToken.className = 'diag-status-pill pill-ok';
      pillToken.innerText = '已授权正常';
      detailToken.innerHTML = `
        <div>状态：✅ OAuth Token 活跃，可执行 App 静默签到与新闻资讯阅读 (30分)</div>
        <div style="margin-top:4px; color:#E2E8F0;">${token.message || ''}</div>
      `;
    } else {
      pillToken.className = 'diag-status-pill pill-err';
      pillToken.innerText = '未授权 / 失效';
      detailToken.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${token.message || '未获取到移动端 OAuth 授权'}</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：点击「新手配置向导」第一步，打开官方链接授权并粘贴跳转 URL。</div>
      `;
    }

    // 4. 网络卡片
    const pillNet = document.getElementById('diag-pill-network');
    const detailNet = document.getElementById('diag-detail-network');
    if (net.regionPass) {
      pillNet.className = 'diag-status-pill pill-ok';
      pillNet.innerText = '中国大陆 (安全)';
      detailNet.innerHTML = `
        <div>状态：✅ 出口 IP 符合微软国区要求 (${net.region})，防风控检测通过</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${net.ipInfo || ''}</div>
      `;
    } else {
      pillNet.className = 'diag-status-pill pill-err';
      pillNet.innerText = `非大陆地区 (${net.region || '未知'})`;
      detailNet.innerHTML = `
        <div style="color:#F87171;">状态：⚠️ 出口位于非大陆地区，若开启国区保护将被自动停止打卡防风控。</div>
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">建议：如果是境外 VPS，请在配置中心设置走国内 HTTP/SOCKS5 代理。</div>
      `;
    }

    // 5. 数据概览明细
    document.getElementById('diag-val-balance').innerText = data.balance ? `${data.balance.toLocaleString()} 积分` : '--';
    document.getElementById('diag-val-search').innerText = cookie.pcSearch || '--';
    document.getElementById('diag-val-read').innerText = token.readProgress || '--';

    // 6. 建议区
    const tipsBox = document.getElementById('diag-tips');
    if (data.allValid) {
      tipsBox.innerHTML = '💡 <strong>检测完毕：</strong>您的微软账号在 Docker 中运行环境完美，点击「▶️ 立即执行」即可开始打卡！';
    } else {
      tipsBox.innerHTML = '💡 <strong>下一步建议：</strong>请点击右上角「💡 新手配置向导」，根据缺失的项（Cookie 或 Token）补充配置即可。';
    }

    loading.style.display = 'none';
    content.style.display = 'block';

    // 同步刷新大屏
    fetchStatus();
  } catch (e) {
    loading.style.display = 'none';
    content.style.display = 'block';
    document.getElementById('diag-banner-title').innerText = '诊断请求失败';
    document.getElementById('diag-banner-sub').innerText = e.message;
  }
}

// 切换历史记录天数 (7 日 / 30 日)
function switchHistoryDays(days) {
  currentHistoryDays = days;
  document.getElementById('btn-history-7')?.classList.toggle('active', days === 7);
  document.getElementById('btn-history-30')?.classList.toggle('active', days === 30);
  fetchHistory(days);
}

// 拉取历史记录数据
async function fetchHistory(days = 7) {
  try {
    const res = await fetch(`/api/history?days=${days}`).then(r => r.json());
    if (res.success && Array.isArray(res.data)) {
      renderHistoryChart(res.data, days);
    }
  } catch (e) {
    console.error('获取历史记录失败:', e);
  }
}

// 渲染历史柱形图与 Hover Tooltip
function renderHistoryChart(dataList, days) {
  const container = document.getElementById('history-chart-container');
  const tooltip = document.getElementById('history-tooltip');
  if (!container || !tooltip) return;

  container.innerHTML = '';
  if (dataList.length === 0) return;

  // 计算最大值，方便归一化高度
  const maxEarned = Math.max(...dataList.map(d => d.earned || 0), 160);

  dataList.forEach((item, index) => {
    const isToday = index === dataList.length - 1;
    const heightPercent = Math.max(12, Math.min(100, Math.round((item.earned / maxEarned) * 100)));

    const col = document.createElement('div');
    col.className = `chart-col ${isToday ? 'today' : ''}`;

    col.innerHTML = `
      <div class="chart-val-hint">+${item.earned}</div>
      <div class="chart-bar-wrap">
        <div class="chart-bar" style="height: ${heightPercent}%;"></div>
      </div>
      <div class="chart-date-label">${days === 30 ? (index % 4 === 0 || isToday ? item.dayLabel : '') : item.dayLabel}</div>
    `;

    // Hover 交互
    const showTooltip = (e) => {
      document.getElementById('tt-date').innerText = `${item.date} (${item.weekday})`;
      document.getElementById('tt-earned').innerText = `+${item.earned} 积分`;
      
      const bdList = document.getElementById('tt-breakdown');
      if (item.breakdown && item.breakdown.length > 0) {
        bdList.innerHTML = item.breakdown.map(b => `
          <div class="tooltip-item">
            <span>${b.icon || '📌'} ${b.name}</span>
            <span style="font-weight: 600; color: #34D399;">+${b.points}</span>
          </div>
        `).join('');
      } else {
        bdList.innerHTML = '<div style="color:#64748B;">打卡任务已满额到账</div>';
      }

      document.getElementById('tt-balance').innerText = `当日结余: ${(item.balance || 0).toLocaleString()} 积分`;

      const barEl = col.querySelector('.chart-bar') || col;
      const rect = barEl.getBoundingClientRect();
      const centerX = Math.max(120, Math.min(window.innerWidth - 120, rect.left + rect.width / 2));
      const topY = Math.max(160, rect.top);
      tooltip.style.left = `${centerX}px`;
      tooltip.style.top = `${topY}px`;
      tooltip.style.display = 'block';
    };

    col.addEventListener('mouseenter', showTooltip);
    col.addEventListener('mousemove', showTooltip);
    col.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
    });

    container.appendChild(col);
  });
}
