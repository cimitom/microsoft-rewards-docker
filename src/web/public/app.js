// 全局状态
let currentStatus = null;
let currentConfig = null;
let eventSource = null;
let currentHistoryDays = 7;
let currentTheme = localStorage.getItem('ms_rewards_theme') || 'auto';
let selectedAccountId = 'all'; // 'all' 或具体账号 id (如 'acc_1')
let editingAccountIdInModal = null;

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initUIEvents();
  startCountdownTimer();
  fetchStatus();
  fetchBrowserStatus();
  fetchConfig();
  fetchHistory(7);
  initLogStream();
  // 首次打开自动触发官网真实完成度同步（解决新部署到 NAS 时任务全显为 0 的问题）
  fetch('/api/status/sync', { method: 'POST' }).then(() => fetchStatus()).catch(() => {});
  setInterval(fetchStatus, 4000); // 4秒轮询一次任务状态
  setInterval(fetchBrowserStatus, 2500); // 2.5秒轮询无头浏览器状态
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

  // 顶部一键同步微软官网真实状态
  document.getElementById('btn-sync-status')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-status');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 同步中...';
    try {
      const res = await fetch('/api/status/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId !== 'all' ? selectedAccountId : null })
      }).then(r => r.json());
      if (res.success && res.data) {
        currentStatus = res.data;
        renderDashboard(res.data);
      }
    } catch (e) {
      alert(`同步失败: ${e.message}`);
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 单次安全测试搜索按钮 (真实按键输入，不触发冷冻)
  document.getElementById('btn-trigger-single-search')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-trigger-single-search');
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<span>⏳</span> 搜索验证中...';
    try {
      const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1');
      const res = await fetch('/api/tasks/single-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetId })
      }).then(r => r.json());
      if (res.success) {
        alert(`🎉 单次测试搜索成功！\n${res.data.message}\n已完成拟人按键输入与积分同步。`);
        fetchStatus();
      } else {
        alert(`搜索测试失败: ${res.message}`);
      }
    } catch (e) {
      alert(`请求出错: ${e.message}`);
    } finally {
      btn.innerHTML = origHtml;
    }
  });

  // 时段开始时间联动计算结束时间 (+4h)
  document.getElementById('cfg-account-starthour')?.addEventListener('input', (e) => {
    let sh = parseInt(e.target.value, 10);
    if (isNaN(sh)) sh = 6;
    sh = Math.max(0, Math.min(23, sh));
    const eh = (sh + 4) % 24;
    const endElem = document.getElementById('cfg-account-endhour');
    if (endElem) endElem.value = `${String(eh).padStart(2, '0')}:00`;
  });

  // 测试词库来源按钮
  document.getElementById('btn-test-search-api')?.addEventListener('click', handleTestSearchApi);
  document.getElementById('btn-close-words-modal')?.addEventListener('click', () => closeModal('search-words-modal'));
  document.getElementById('btn-close-words-modal-btn')?.addEventListener('click', () => closeModal('search-words-modal'));

  // 新建账号弹窗相关
  document.getElementById('btn-add-account-card')?.addEventListener('click', () => openModal('account-quick-add-modal'));
  document.getElementById('btn-close-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-cancel-quick-add')?.addEventListener('click', () => closeModal('account-quick-add-modal'));
  document.getElementById('btn-save-quick-add')?.addEventListener('click', handleQuickAddAccount);

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

  // 配置中心：切换账号编辑
  document.getElementById('cfg-account-select')?.addEventListener('change', (e) => {
    editingAccountIdInModal = e.target.value;
    loadAccountIntoForm(editingAccountIdInModal);
  });
  document.getElementById('btn-modal-add-acc')?.addEventListener('click', () => {
    closeModal('settings-modal');
    openModal('account-quick-add-modal');
  });
  document.getElementById('btn-modal-del-acc')?.addEventListener('click', handleDeleteCurrentAccountInModal);

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
        body: JSON.stringify({ urlOrCode: input, accountId: selectedAccountId !== 'all' ? selectedAccountId : 'acc_1' })
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
        body: JSON.stringify({ cookie, accountId: selectedAccountId !== 'all' ? selectedAccountId : 'acc_1' })
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
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/exchange-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urlOrCode: input, accountId: targetId })
    }).then(r => r.json());
    if (res.success) {
      alert('Token 换取并保存成功！');
      fetchConfig();
      fetchStatus();
    } else {
      alert(`换取失败: ${res.message}`);
    }
  });

  // 配置中心：测试当前账号 (详细展示 Cookie、Code、Token 是否可用)
  document.getElementById('btn-test-account')?.addEventListener('click', async () => {
    const resultDiv = document.getElementById('test-account-result');
    resultDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在全面测试当前账号凭据可用性...</span>';
    const targetId = editingAccountIdInModal || 'acc_1';
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (res.success) {
      const c = res.data.cookie;
      const code = res.data.code;
      const t = res.data.token;
      const net = res.data.network;
      resultDiv.innerHTML = `
        <div style="background:var(--card-inner); padding:10px 14px; border-radius:10px; border:1px solid var(--border-color); display:flex; flex-direction:column; gap:8px; margin-top:8px;">
          <div><strong>1. 必应网页端 Cookie:</strong> ${c?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(c?.message || '')})</small></div>
          <div><strong>2. 授权码链接 Code:</strong> ${code?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 待配置</span>'} <small style="color:var(--text-sub);">(${escapeHtml(code?.message || '')})</small></div>
          <div><strong>3. 移动端 OAuth Token:</strong> ${t?.valid ? '<span style="color:#34D399; font-weight:700;">✅ 可用</span>' : '<span style="color:#F87171; font-weight:700;">❌ 不可用或失效</span>'} <small style="color:var(--text-sub);">(${escapeHtml(t?.message || '')})</small></div>
          <div><strong>4. 网络出口与 IP 地区:</strong> ${net?.regionPass ? '<span style="color:#34D399; font-weight:700;">✅ 中国大陆 (安全通过)</span>' : '<span style="color:#F59E0B; font-weight:700;">⚠️ 非大陆出口</span>'} <small style="color:var(--text-sub);">(${escapeHtml(net?.ipInfo || '')})</small></div>
        </div>
      `;
      fetchStatus();
    } else {
      resultDiv.innerHTML = `<span style="color:#F87171;">测试出错: ${escapeHtml(res.message || '')}</span>`;
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

// 快速新建账号提交
async function handleQuickAddAccount() {
  const name = document.getElementById('quick-add-name')?.value.trim();
  const cookie = document.getElementById('quick-add-cookie')?.value.trim();
  const authCodeUrl = document.getElementById('quick-add-authcode')?.value.trim();

  if (!name && !cookie) {
    return alert('请至少填写账号备注名称或粘贴 Cookie');
  }

  const res = await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name || '新账号',
      cookie,
      authCodeUrl,
      enabled: true
    })
  }).then(r => r.json());

  if (res.success) {
    alert('账号添加成功！');
    closeModal('account-quick-add-modal');
    // 清空表单
    document.getElementById('quick-add-name').value = '';
    document.getElementById('quick-add-cookie').value = '';
    document.getElementById('quick-add-authcode').value = '';
    // 自动切到新添加的账号
    selectedAccountId = res.data.id;
    fetchStatus();
    fetchConfig();
  } else {
    alert(`创建失败: ${res.message}`);
  }
}

// 配置中心中删除当前账号
async function handleDeleteCurrentAccountInModal() {
  if (!editingAccountIdInModal) return;
  if (!confirm('确定要删除当前选中的这个账号吗？')) return;

  const res = await fetch(`/api/accounts/${editingAccountIdInModal}`, { method: 'DELETE' }).then(r => r.json());
  if (res.success) {
    alert('账号已删除');
    selectedAccountId = 'all';
    fetchConfig();
    fetchStatus();
    closeModal('settings-modal');
  } else {
    alert(res.message);
  }
}

// 获取状态并渲染大屏
async function fetchStatus() {
  try {
    const res = await fetch(`/api/status?accountId=${selectedAccountId}`).then(r => r.json());
    if (res.success && res.data) {
      currentStatus = res.data;
      renderDashboard(res.data);
    }
  } catch (e) {
    console.error('获取状态失败:', e);
  }
}

// 获取并渲染无头浏览器实时状态监控数据
async function fetchBrowserStatus() {
  try {
    const res = await fetch('/api/browser/status').then(r => r.json());
    if (res.success && res.data) {
      renderBrowserMonitor(res.data);
    }
  } catch {}
}

function renderBrowserMonitor(b) {
  const pill = document.getElementById('browser-pill-status');
  const pillText = document.getElementById('browser-pill-text');
  const bmAccount = document.getElementById('bm-account');
  const bmQuery = document.getElementById('bm-query');
  const bmRound = document.getElementById('bm-round');
  const bmCountdown = document.getElementById('bm-countdown');
  const bmMem = document.getElementById('bm-mem');
  const bmAction = document.getElementById('bm-action-text');

  if (!pill) return;

  const isRunning = b.status !== 'idle' && b.status !== 'stopped';
  pill.className = `browser-status-pill ${isRunning ? 'status-running' : 'status-idle'}`;

  const statusMap = {
    idle: '空闲休眠中 (0 MB)',
    starting: '正在启动 Chromium...',
    navigating: '打开 Bing 页面中...',
    typing: '正在模拟真人键盘打字...',
    dwelling: '等待页面渲染与滚动...',
    waiting: '拟人呼吸休眠中...',
    stopped: '已停止'
  };

  pillText.innerText = statusMap[b.status] || (isRunning ? '运行中' : '空闲休眠中');
  bmAccount.innerText = b.activeAccountName || '--';
  bmQuery.innerText = b.currentQuery || '--';
  bmRound.innerText = b.totalTarget > 0 ? `${b.searchCount} / ${b.totalTarget}` : '0 / 0';
  bmCountdown.innerText = b.nextSearchIn > 0 ? `${b.nextSearchIn} 秒` : '--';
  bmMem.innerText = isRunning ? `${b.memoryMB || 180} MB` : '0 MB';
  bmAction.innerText = b.lastAction || '浏览器当前处于空闲休眠状态 (0 内存占用)';
}

// 渲染多账号切换胶囊栏
function renderAccountSelectorBar(summary) {
  const bar = document.getElementById('account-selector-bar');
  if (!bar || !summary) return;

  const accounts = summary.accountsList || [];
  let html = '';

  // 1. 全部账号汇总胶囊
  const isAllActive = selectedAccountId === 'all';
  html += `
    <button class="account-chip ${isAllActive ? 'active' : ''}" data-acc-id="all">
      <span class="chip-icon">🌐</span>
      <span class="chip-name">全部账号汇总</span>
      <span class="chip-badge">${summary.totalAccounts || 1} 个账号</span>
    </button>
  `;

  // 2. 各独立账号胶囊
  accounts.forEach(acc => {
    const isActive = selectedAccountId === acc.id;
    html += `
      <button class="account-chip ${isActive ? 'active' : ''}" data-acc-id="${acc.id}">
        <span class="chip-icon">${acc.enabled ? '👤' : '⏸️'}</span>
        <span class="chip-name">${escapeHtml(acc.name)}</span>
        <span class="chip-sub">${(acc.balance || 0).toLocaleString()} 分</span>
      </button>
    `;
  });

  // 3. 添加账号按钮
  html += `
    <button class="account-chip chip-add" id="btn-add-account-chip">
      <span>➕</span> 添加账号
    </button>
  `;

  bar.innerHTML = html;

  // 绑定切换事件
  bar.querySelectorAll('.account-chip[data-acc-id]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedAccountId = chip.getAttribute('data-acc-id');
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });
  });

  bar.querySelector('#btn-add-account-chip')?.addEventListener('click', () => {
    openModal('account-quick-add-modal');
  });
}

// 渲染大屏
function renderDashboard(data) {
  const { running, summary, stats, timeline } = data;

  // 1. 渲染顶部多账号切换胶囊
  if (summary) {
    renderAccountSelectorBar(summary);
  }

  // 2. 系统运行状态
  const statusBadge = document.getElementById('system-status-badge');
  const statusText = document.getElementById('status-text');
  const btnRun = document.getElementById('btn-run');
  const btnStop = document.getElementById('btn-stop');

  if (running) {
    statusBadge.className = 'status-pill status-running';
    statusText.innerText = '正在执行打卡巡检...';
    btnRun.style.display = 'none';
    btnStop.style.display = 'inline-flex';
  } else {
    statusBadge.className = 'status-pill status-idle';
    statusText.innerText = '后台定时就绪中';
    btnRun.style.display = 'inline-flex';
    btnStop.style.display = 'none';
  }

  // 3. Hero 5 大卡片数据渲染
  const isAllMode = selectedAccountId === 'all';
  const displayEarned = isAllMode ? (summary?.totalEarned || 0) : (stats.earned || 0);
  const displayBalance = isAllMode ? (summary?.totalBalance || 0) : (stats.balance || 0);
  const displayStreak = isAllMode ? (summary?.maxStreak || 0) : (stats.streakDays || 0);
  const displayPercent = isAllMode ? (summary?.overallPercent || 0) : Math.round((Object.values(stats.tasks || {}).filter(t => t.done || (t.max > 0 && t.progress >= t.max)).length / Math.max(1, Object.keys(stats.tasks || {}).length)) * 100);
  const stamps = isAllMode ? (summary?.stamps || { progress: 8, max: 12 }) : (stats.stamps || { progress: 8, max: 12 });

  const doneTasksCount = isAllMode
    ? (summary?.doneTasksCount || 0)
    : Object.values(stats.tasks || {}).filter(t => t.done || (t.max > 0 && t.progress >= t.max)).length;
  const totalTasksCount = isAllMode
    ? (summary?.totalTasksCount || 6)
    : Math.max(1, Object.keys(stats.tasks || {}).length);

  document.getElementById('stat-earned').innerText = `+${displayEarned}`;
  document.getElementById('stat-balance').innerText = displayBalance.toLocaleString();
  document.getElementById('stat-percent').innerText = `${displayPercent}%`;
  document.getElementById('stat-done-count').innerText = `${doneTasksCount} / ${totalTasksCount} 项任务完成`;
  document.getElementById('stat-streak').innerText = `${displayStreak} 天`;

  const statStamps = document.getElementById('stat-stamps');
  const statStampsDesc = document.getElementById('stat-stamps-desc');
  if (statStamps) {
    statStamps.innerText = `${stamps.progress || 8} / ${stamps.max || 12}`;
  }
  if (statStampsDesc) {
    const diff = Math.max(0, (stamps.max || 12) - (stamps.progress || 8));
    statStampsDesc.innerText = diff > 0 ? `差 ${diff} 个集满 1,000 分大奖` : '1,000 奖励印章已集满！';
  }

  // 运行按钮提示
  const btnRunIcon = btnRun.querySelector('.icon') || btnRun;
  btnRun.innerHTML = isAllMode ? '<span>▶️</span> 立即执行全部账号' : `<span>▶️</span> 运行当前账号 [${escapeHtml(stats.name || '')}]`;

  // 4. 汇总视图 vs 单账号视图渲染
  const overviewCard = document.getElementById('accounts-overview-card');
  const taskListTitle = document.getElementById('task-list-title');

  if (isAllMode) {
    // 显示各账号概览卡片矩阵
    if (overviewCard) {
      overviewCard.style.display = 'flex';
      renderAccountsOverviewGrid(summary?.accountsList || []);
    }
    if (taskListTitle) {
      taskListTitle.innerText = `今日全账号综合任务明细`;
    }
  } else {
    // 隐藏多账号概览矩阵，聚焦单账号详细任务
    if (overviewCard) {
      overviewCard.style.display = 'none';
    }
    if (taskListTitle) {
      taskListTitle.innerText = `账号 [${escapeHtml(stats.name || '')}] 今日自动化任务进度清单`;
    }
  }

  // 5. 渲染任务网格
  const taskGrid = document.getElementById('task-grid');
  taskGrid.innerHTML = '';
  const tasksList = Object.entries(stats.tasks || {});

  for (const [key, t] of tasksList) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const isDone = t.done || (t.max > 0 && t.progress >= t.max);
    
    let subtext = isDone ? '状态: ✅ 已完成' : (running ? '状态: ⏳ 进行中' : '状态: 待执行');
    let pointsBadge = `+${t.points || 0} 积分`;
    let progressLabel = `进度: ${t.progress || 0} / ${t.max || 1} ${t.unit || ''}`;
    let progPercent = t.max > 0 ? Math.min(100, Math.round((t.progress / t.max) * 100)) : (isDone ? 100 : 0);

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

  // 6. 渲染时间轴
  const timelineList = document.getElementById('timeline-list');
  if (timeline && timeline.length > 0) {
    timelineList.innerHTML = timeline.map(item => `
      <div class="timeline-item">
        <span class="timeline-time">${item.time}</span>
        <span class="timeline-tag">[${escapeHtml(item.tag)}]</span>
        <span>${escapeHtml(item.text)}</span>
      </div>
    `).join('');
  }
}

// 渲染多账号概览矩阵卡片 (在“全部账号汇总”视图中展示)
function renderAccountsOverviewGrid(accounts) {
  const grid = document.getElementById('accounts-grid');
  if (!grid) return;
  grid.innerHTML = '';

  accounts.forEach(acc => {
    const card = document.createElement('div');
    card.className = 'account-overview-card';
    card.innerHTML = `
      <div class="acc-card-top">
        <div class="acc-card-title">
          <span>👤</span>
          <span>${escapeHtml(acc.name)}</span>
        </div>
        <div class="acc-card-badges">
          <span class="badge-mini" style="background:${acc.enabled ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color:${acc.enabled ? '#34D399' : '#F87171'};">
            ${acc.enabled ? '已启用' : '已停用'}
          </span>
          <span class="badge-mini" style="background:rgba(56,189,248,0.15); color:#38BDF8;">
            ${acc.hasCookie ? 'Cookie就绪' : '未配Cookie'}
          </span>
        </div>
      </div>

      <div class="acc-card-stats">
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">今日已增</span>
          <span class="acc-stat-num" style="color:#34D399;">+${acc.earned || 0}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">当前总分</span>
          <span class="acc-stat-num">${(acc.balance || 0).toLocaleString()}</span>
        </div>
        <div class="acc-stat-box">
          <span class="acc-stat-lbl">连续签到</span>
          <span class="acc-stat-num" style="color:#F59E0B;">${acc.streakDays || 0}天</span>
        </div>
      </div>

      <div class="progress-wrap">
        <div class="progress-labels">
          <span>任务达成率: ${acc.doneTasks || 0}/${acc.totalTasks || 6} 项</span>
          <span>${acc.percent || 0}%</span>
        </div>
        <div class="progress-bar-track">
          <div class="progress-bar-fill" style="width: ${acc.percent || 0}%;"></div>
        </div>
      </div>

      <div class="acc-card-actions">
        <button class="btn btn-primary btn-sm btn-run-single" title="立即运行此账号打卡">▶️ 运行</button>
        <button class="btn btn-secondary btn-sm btn-toggle-single" title="${acc.enabled ? '暂停此账号自动巡检' : '继续此账号自动巡检'}">
          ${acc.enabled ? '⏸️ 暂停' : '▶️ 继续'}
        </button>
        <button class="btn btn-secondary btn-sm btn-test-single-search" title="单独搜索一次 (拟人键盘输入，安全验证)">🔍 单次测搜</button>
        <button class="btn btn-secondary btn-sm btn-test-single" title="测试该账号登录状态">📋 诊断</button>
        <button class="btn btn-secondary btn-sm btn-view-acc">详情 ➜</button>
      </div>
    `;

    // 绑定卡片上的各快捷按钮
    card.querySelector('.btn-test-single-search')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target;
      const origText = btn.innerText;
      btn.innerText = '⏳ 测搜中...';
      try {
        const res = await fetch('/api/tasks/single-search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountId: acc.id })
        }).then(r => r.json());
        if (res.success) {
          alert(`🎉 账号 [${acc.name}] 单次测试搜索成功！\n${res.data.message}\n已完成拟人键盘输入与积分同步。`);
          fetchStatus();
        } else {
          alert(`测搜失败: ${res.message}`);
        }
      } catch (err) {
        alert(`请求出错: ${err.message}`);
      } finally {
        btn.innerText = origText;
      }
    });

    card.querySelector('.btn-run-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch('/api/tasks/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: acc.id })
      }).then(r => r.json());
      if (res.success) fetchStatus();
      else alert(res.message);
    });

    card.querySelector('.btn-toggle-single')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/accounts/${acc.id}/toggle`, { method: 'POST' }).then(r => r.json());
      if (res.success) {
        fetchStatus();
        fetchConfig();
      }
    });

    card.querySelector('.btn-test-single')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      openModal('diag-modal');
      runAccountDiagnosis();
    });

    card.querySelector('.btn-view-acc')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    card.addEventListener('click', () => {
      selectedAccountId = acc.id;
      fetchStatus();
      fetchHistory(currentHistoryDays);
    });

    grid.appendChild(card);
  });
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
    div.innerHTML = `<span class="log-time">[${log.time}]</span> <span>${log.icon}</span> ${log.tag ? `<strong>[${escapeHtml(log.tag)}]</strong> ` : ''}${escapeHtml(log.message)}`;
    terminal.appendChild(div);
    if (chkAutoScroll.checked) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function runTasks() {
  const reqBody = selectedAccountId !== 'all' ? { accountId: selectedAccountId } : {};
  const res = await fetch('/api/tasks/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
  }).then(r => r.json());
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
  const accounts = c.accounts || [];

  // 1. 填充多账号下拉框
  const accSelect = document.getElementById('cfg-account-select');
  if (accSelect) {
    accSelect.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${editingAccountIdInModal === a.id ? 'selected' : ''}>
        ${escapeHtml(a.name || a.id)}
      </option>
    `).join('');
    if (!editingAccountIdInModal && accounts.length > 0) {
      editingAccountIdInModal = accounts[0].id;
    }
  }

  loadAccountIntoForm(editingAccountIdInModal);

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
  document.getElementById('cfg-search-engine').value = c.tasks?.searchEngineMode || 'browser';
  document.getElementById('cfg-search-api').value = c.tasks?.searchApi || 'baidu.official';
  // 主题
  const themeVal = c.ui?.theme || localStorage.getItem('ms_rewards_theme') || 'auto';
  const themeSelect = document.getElementById('cfg-ui-theme');
  if (themeSelect) themeSelect.value = themeVal;
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

function loadAccountIntoForm(accId) {
  if (!currentConfig || !Array.isArray(currentConfig.accounts)) return;
  const acc = currentConfig.accounts.find(a => a.id === accId) || currentConfig.accounts[0];
  if (!acc) return;

  editingAccountIdInModal = acc.id;
  document.getElementById('cfg-account-name').value = acc.name || '';
  document.getElementById('cfg-account-enabled').checked = acc.enabled !== false;
  document.getElementById('cfg-cookie').value = acc.cookie || '';
  document.getElementById('cfg-authcode').value = acc.authCodeUrl || '';
  document.getElementById('cfg-refresh-token').value = acc.refreshToken ? '********' : '';

  // 拟人化错峰时段
  const slot = acc.timeSlot || { startHour: 6, endHour: 10, randomDelayMin: 60, durationHours: 2 };
  const sh = slot.startHour ?? 6;
  const eh = slot.endHour ?? ((sh + 4) % 24);
  const shInput = document.getElementById('cfg-account-starthour');
  if (shInput) shInput.value = sh;
  const ehInput = document.getElementById('cfg-account-endhour');
  if (ehInput) ehInput.value = `${String(eh).padStart(2, '0')}:00`;
}

async function saveSettingsFromModal() {
  const currentAccId = editingAccountIdInModal || 'acc_1';
  const currentAccounts = currentConfig?.accounts || [];
  const idx = currentAccounts.findIndex(a => a.id === currentAccId);

  const sh = parseInt(document.getElementById('cfg-account-starthour')?.value, 10) || 6;
  const updatedAccountData = {
    id: currentAccId,
    name: document.getElementById('cfg-account-name').value.trim() || '账号',
    enabled: document.getElementById('cfg-account-enabled').checked,
    cookie: document.getElementById('cfg-cookie').value.trim(),
    authCodeUrl: document.getElementById('cfg-authcode').value.trim(),
    timeSlot: {
      startHour: sh,
      endHour: (sh + 4) % 24,
      randomDelayMin: 60,
      durationHours: 2
    }
  };

  if (idx !== -1) {
    currentAccounts[idx] = { ...currentAccounts[idx], ...updatedAccountData };
  } else {
    currentAccounts.push(updatedAccountData);
  }

  const selectedTheme = document.getElementById('cfg-ui-theme')?.value || 'auto';
  setTheme(selectedTheme);

  const updateData = {
    accounts: currentAccounts,
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
      searchEngineMode: document.getElementById('cfg-search-engine')?.value || 'browser',
      searchApi: document.getElementById('cfg-search-api')?.value || 'baidu.official'
    },
    ui: {
      theme: selectedTheme
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
    fetchStatus();
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
    const targetId = selectedAccountId !== 'all' ? selectedAccountId : (currentConfig?.accounts?.[0]?.id || 'acc_1');
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: targetId })
    }).then(r => r.json());
    if (!res.success) throw new Error(res.message || '诊断接口异常');

    const data = res.data;
    const cookie = data.cookie || {};
    const token = data.token || {};
    const net = data.network || {};
    const accName = data.accountName || '当前账号';

    // 1. 综合 Banner
    const banner = document.getElementById('diag-banner');
    const bIcon = document.getElementById('diag-banner-icon');
    const bTitle = document.getElementById('diag-banner-title');
    const bSub = document.getElementById('diag-banner-sub');

    if (data.allValid && net.regionPass) {
      banner.className = 'diag-banner ok';
      bIcon.innerText = '🟢';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 登录完全正常 (双端在线)`;
      bSub.innerText = '当前 Docker 环境已完美就绪，所有任务通道与网络环境均处于最佳状态！';
    } else if (data.overallValid) {
      banner.className = 'diag-banner partial';
      bIcon.innerText = '🟡';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 部分登录有效`;
      bSub.innerText = '部分通道已连接，但仍有项未就绪（如网页端或移动端单边未登录），请根据下方提示补充。';
    } else {
      banner.className = 'diag-banner failed';
      bIcon.innerText = '🔴';
      bTitle.innerText = `账号 [${escapeHtml(accName)}] 尚未成功在 Docker 中登录`;
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
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(cookie.message || '')}</div>
      `;
    } else {
      pillCookie.className = 'diag-status-pill pill-err';
      pillCookie.innerText = '未登录 / 失效';
      detailCookie.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(cookie.message || 'Cookie 缺失或已失效')}</div>
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
        <div style="margin-top:4px; color:#E2E8F0;">${escapeHtml(token.message || '')}</div>
      `;
    } else {
      pillToken.className = 'diag-status-pill pill-err';
      pillToken.innerText = '未授权 / 失效';
      detailToken.innerHTML = `
        <div style="color:#F87171;">状态：❌ ${escapeHtml(token.message || '未获取到移动端 OAuth 授权')}</div>
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
        <div style="margin-top:4px; font-size:11.5px; color:#94A3B8;">${escapeHtml(net.ipInfo || '')}</div>
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
      tipsBox.innerHTML = `💡 <strong>检测完毕：</strong>账号 [${escapeHtml(accName)}] 在 Docker 中运行环境完美，点击「▶️ 立即执行」即可开始打卡！`;
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

// 测试词库来源并展示明细
async function handleTestSearchApi() {
  const selectElem = document.getElementById('cfg-search-api');
  const selectedMode = selectElem?.value || 'offline';
  const statusDiv = document.getElementById('words-modal-status');
  const tagsDiv = document.getElementById('words-modal-tags');
  
  openModal('search-words-modal');
  statusDiv.innerHTML = '<span style="color:#38BDF8;">⏳ 正在请求并测试所选词库接口...</span>';
  tagsDiv.innerHTML = '';

  try {
    const res = await fetch('/api/tasks/test-search-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchApi: selectedMode })
    }).then(r => r.json());

    if (res.success && Array.isArray(res.sample)) {
      statusDiv.innerHTML = `<span style="color:#34D399; font-weight:700;">✅ [${escapeHtml(res.name)}] 接口通畅！成功抓取 ${res.count} 条热词，前 ${res.sample.length} 条明细预览：</span>`;
      tagsDiv.innerHTML = res.sample.map((w, i) => `
        <span style="font-size:12px; padding:4px 9px; background:var(--card-bg); border:1px solid var(--border-color); border-radius:6px; color:var(--text-main);">
          ${i + 1}. ${escapeHtml(w)}
        </span>
      `).join('');
    } else {
      statusDiv.innerHTML = `<span style="color:#F87171; font-weight:700;">❌ [${escapeHtml(res.name || selectedMode)}] 获取失败: ${escapeHtml(res.message || '未知错误')}</span>`;
      tagsDiv.innerHTML = '<span style="color:var(--text-muted); font-size:12px;">未能获取到有效词条，建议切换回「本地离线智能词库（最稳定）」。</span>';
    }
  } catch (e) {
    statusDiv.innerHTML = `<span style="color:#F87171;">❌ 请求异常: ${escapeHtml(e.message)}</span>`;
  }
}
