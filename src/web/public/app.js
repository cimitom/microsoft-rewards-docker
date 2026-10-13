// 全局状态
let currentStatus = null;
let currentConfig = null;
let eventSource = null;

document.addEventListener('DOMContentLoaded', () => {
  initUIEvents();
  fetchStatus();
  fetchConfig();
  initLogStream();
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
});

function initUIEvents() {
  // 立即运行 & 停止
  document.getElementById('btn-run').addEventListener('click', runTasks);
  document.getElementById('btn-stop').addEventListener('click', stopTasks);

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
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在检测 Cookie...</span>';
    // 先暂存到后台
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: { cookie } })
    });
    const testRes = await fetch('/api/auth/test', { method: 'POST' }).then(r => r.json());
    if (testRes.success && testRes.data?.cookie?.valid) {
      resultDiv.innerHTML = `<span style="color:#34D399;">✅ ${testRes.data.cookie.message}</span>`;
    } else {
      resultDiv.innerHTML = `<span style="color:#EF4444;">❌ ${testRes.data?.cookie?.message || 'Cookie 检测无效'}</span>`;
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
    const progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

    card.innerHTML = `
      <div class="task-top">
        <div class="task-info">
          <div class="task-icon">${t.icon || '📌'}</div>
          <div>
            <div class="task-name">${t.name}</div>
            <div class="task-subtext">${isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行')}</div>
          </div>
        </div>
        <div class="pts-badge">+${t.points || 0} 积分</div>
      </div>
      <div class="progress-wrap">
        <div class="progress-labels">
          <span>进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}</span>
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
    schedule: {
      enabled: document.getElementById('cfg-sched-enabled').checked,
      cron: document.getElementById('cfg-sched-cron').value.trim()
    },
    notify: {
      wework: document.getElementById('cfg-notify-wework').value.trim(),
      dingding: document.getElementById('cfg-notify-dingding').value.trim(),
      feishu: document.getElementById('cfg-notify-feishu').value.trim(),
      bark: document.getElementById('cfg-notify-bark').value.trim(),
      pushme: document.getElementById('cfg-notify-pushme').value.trim()
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
  const idMap = {
    wework: 'cfg-notify-wework',
    dingding: 'cfg-notify-dingding',
    feishu: 'cfg-notify-feishu',
    bark: 'cfg-notify-bark',
    pushme: 'cfg-notify-pushme'
  };
  const val = document.getElementById(idMap[channel])?.value.trim();
  if (!val) return alert('请先输入配置的值');

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
