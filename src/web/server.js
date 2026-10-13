import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import configManager from '../config.js';
import logger from '../logger.js';
import taskManager from '../core/taskManager.js';
import authManager from '../core/auth.js';
import notifier from '../core/notifier.js';
import scheduler from '../scheduler.js';
import rewardsApi from '../core/api.js';
import historyManager from '../core/history.js';
import browserManager from '../core/browser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CURRENT_VERSION = '1.4.5';

let lastCpuInfo = os.cpus().map(c => c.times);
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cpus.length; i++) {
    const prev = lastCpuInfo[i] || { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const cur = cpus[i].times;
    const prevTotal = Object.values(prev).reduce((a, b) => a + b, 0);
    const curTotal = Object.values(cur).reduce((a, b) => a + b, 0);
    total += (curTotal - prevTotal);
    idle += (cur.idle - prev.idle);
  }
  lastCpuInfo = cpus.map(c => c.times);
  const usage = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 100))) : 2;
  return usage;
}

let lastPingMs = 28;
let lastPingTime = 0;
async function getNetworkPing() {
  if (Date.now() - lastPingTime < 8000) return lastPingMs;
  const start = Date.now();
  try {
    await fetch('https://cn.bing.com/favicon.ico', { method: 'HEAD', signal: AbortSignal.timeout(2500) });
    lastPingMs = Math.max(5, Date.now() - start);
    lastPingTime = Date.now();
  } catch {
    lastPingMs = Math.max(5, Date.now() - start);
  }
  return lastPingMs;
}

export function createServer() {
  const app = express();

  // 健康检查（免认证）：Docker HEALTHCHECK 用它，否则开启密码后会因 401 被判为不健康
  app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  // 访问控制：当配置了 server.authPassword 时启用 HTTP Basic 认证。
  // 注意：/api/config 会返回全部账号的 Cookie 与 Token，未设密码时任何能访问该端口的人
  // 都能拿到账号凭据，强烈建议设置密码（尤其是把端口暴露到内网之外时）。
  app.use((req, res, next) => {
    const password = configManager.get()?.server?.authPassword;
    if (!password) return next();

    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
        const sep = decoded.indexOf(':');
        const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
        if (pass === password) return next();
      } catch {}
    }

    res.set('WWW-Authenticate', 'Basic realm="Microsoft Rewards", charset="UTF-8"');
    res.status(401).send('需要认证：请在配置中设置 server.authPassword 后使用该密码访问');
  });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 0. 系统硬件与网络实时监控指标
  app.get('/api/system/metrics', async (req, res) => {
    try {
      const cpuPercent = getCpuUsage();
      const ping = await getNetworkPing();
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const usedMemBytes = totalMemBytes - freeMemBytes;
      const memUsage = process.memoryUsage();
      const procMemMB = Math.round(memUsage.rss / (1024 * 1024));
      const heapUsedMB = Math.round(memUsage.heapUsed / (1024 * 1024));
      const heapTotalMB = Math.round(memUsage.heapTotal / (1024 * 1024));
      const totalMemGB = (totalMemBytes / (1024 * 1024 * 1024)).toFixed(1);
      const usedMemGB = (usedMemBytes / (1024 * 1024 * 1024)).toFixed(1);
      const memPercent = Math.round((usedMemBytes / totalMemBytes) * 100);

      const uptimeSec = Math.floor(process.uptime());
      const uptimeStr = uptimeSec > 3600
        ? `${Math.floor(uptimeSec / 3600)}小时 ${Math.floor((uptimeSec % 3600) / 60)}分`
        : `${Math.floor(uptimeSec / 60)}分 ${uptimeSec % 60}秒`;

      res.json({
        success: true,
        data: {
          cpu: `${cpuPercent}%`,
          procMem: `${procMemMB} MB`,
          sysMem: `${usedMemGB}G/${totalMemGB}G`,
          memPercent,
          ping: `${ping} ms`,
          containerDetails: {
            processRss: `${procMemMB} MB`,
            heap: `${heapUsedMB} MB / ${heapTotalMB} MB`,
            systemMemory: `${usedMemGB} GB / ${totalMemGB} GB (${memPercent}%)`,
            uptime: uptimeStr,
            platform: `${os.type()} ${os.arch()}`,
            nodeVersion: process.version
          }
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 0.5 检查版本更新
  let cachedRelease = null;
  let cachedReleaseTime = 0;
  app.get('/api/system/check-update', async (req, res) => {
    try {
      if (!cachedRelease || Date.now() - cachedReleaseTime > 10 * 60 * 1000) {
        const ghRes = await fetch('https://api.github.com/repos/wangheqiang530/microsoft-rewards-docker/releases/latest', {
          headers: { 'User-Agent': 'microsoft-rewards-docker' },
          signal: AbortSignal.timeout(3500)
        }).then(r => r.json());
        if (ghRes && ghRes.tag_name) {
          cachedRelease = ghRes;
          cachedReleaseTime = Date.now();
        }
      }

      const currentVersion = CURRENT_VERSION;
      const latestTag = cachedRelease?.tag_name?.replace(/^v/, '') || currentVersion;
      const hasUpdate = latestTag !== currentVersion && latestTag > currentVersion;

      res.json({
        success: true,
        data: {
          currentVersion,
          latestVersion: latestTag,
          hasUpdate,
          releaseUrl: cachedRelease?.html_url || 'https://github.com/wangheqiang530/microsoft-rewards-docker/releases/latest',
          releaseTitle: cachedRelease?.name || `v${latestTag}`,
          releaseNotes: cachedRelease?.body || ''
        }
      });
    } catch {
      res.json({
        success: true,
        data: {
          currentVersion: CURRENT_VERSION,
          latestVersion: CURRENT_VERSION,
          hasUpdate: false,
          releaseUrl: 'https://github.com/wangheqiang530/microsoft-rewards-docker/releases'
        }
      });
    }
  });

  // 1. 获取当前状态（支持按账号过滤）
  app.get('/api/status', (req, res) => {
    const accountId = req.query.accountId || 'all';
    res.json({
      success: true,
      data: taskManager.getStatus(accountId)
    });
  });

  // 1.2 主动从微软官网同步真实完成进度
  app.post('/api/status/sync', async (req, res) => {
    try {
      const accountId = req.body?.accountId || null;
      if (accountId && accountId !== 'all') {
        const accCfg = configManager.resolveAccount(accountId);
        if (!accCfg) {
          return res.status(404).json({ success: false, message: '账号未找到' });
        }
        await taskManager.syncAccountOfficialStatus(accCfg);
      } else {
        await taskManager.syncAllOfficialStatus();
      }
      res.json({ success: true, data: taskManager.getStatus(accountId || 'all') });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 1.5 多账号管理接口 (包含 order 排序)
  app.get('/api/accounts', (req, res) => {
    const accounts = configManager.getAccounts().map(a => ({
      id: a.id,
      name: a.name,
      order: a.order !== undefined ? Number(a.order) : 999,
      enabled: a.enabled !== false,
      hasCookie: !!a.cookie,
      hasToken: !!a.refreshToken,
      tokenTime: a.tokenTime || 0,
      timeSlot: a.timeSlot
    }));
    res.json({ success: true, data: accounts });
  });

  app.post('/api/accounts', (req, res) => {
    try {
      const saved = configManager.upsertAccount(req.body);
      taskManager.ensureAccountStats(saved.id);
      res.json({ success: true, data: saved });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 一键切换账号启用/停用 (继续/暂停)
  app.post('/api/accounts/:id/toggle', (req, res) => {
    try {
      // 必须精确匹配：getAccount() 在 id 不存在时会回退到第一个账号，
      // 那样「暂停某个不存在的账号」会误操作到主账号上
      const acc = configManager.resolveAccount(req.params.id);
      if (!acc) return res.status(404).json({ success: false, message: '账号未找到' });
      const newEnabled = !acc.enabled;
      configManager.upsertAccount({ id: acc.id, enabled: newEnabled });
      res.json({ success: true, enabled: newEnabled, message: newEnabled ? '账号已继续自动巡检' : '账号已暂停巡检' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/accounts/:id', (req, res) => {
    try {
      configManager.deleteAccount(req.params.id);
      // 同步清理该账号的统计与账单，避免留下孤儿数据
      taskManager.removeAccountStats(req.params.id);
      res.json({ success: true, message: '账号已删除' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 测试词库来源获取明细
  app.post('/api/tasks/test-search-api', async (req, res) => {
    try {
      const mode = req.body?.searchApi || 'offline';
      const result = await rewardsApi.fetchSearchWordList(mode);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 获取无头浏览器实时状态监控数据
  app.get('/api/browser/status', (req, res) => {
    res.json({
      success: true,
      data: browserManager.getStatus()
    });
  });

  // 单独安全测试搜索一次（验证按键与加分，完全避免冷却限制）
  app.post('/api/tasks/single-search', async (req, res) => {
    try {
      const accountId = req.body?.accountId || null;
      const result = await taskManager.runSingleTestSearch(accountId);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 2. 获取配置
  app.get('/api/config', (req, res) => {
    const cfg = configManager.get();
    res.json({
      success: true,
      data: cfg
    });
  });

  // 3. 更新配置
  app.post('/api/config', (req, res) => {
    try {
      const updated = configManager.update(req.body);
      scheduler.restart();
      logger.log('⚙️', '配置已更新并已生效');
      res.json({ success: true, data: updated });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 4. 手动立即执行（支持指定单账号或全部账号）
  app.post('/api/tasks/run', async (req, res) => {
    if (taskManager.running) {
      return res.json({ success: false, message: '任务正在运行中' });
    }
    const targetAccountId = req.body?.accountId || null;
    taskManager.runAll(true, targetAccountId);
    res.json({
      success: true,
      message: targetAccountId ? `已启动账号 [${targetAccountId}] 的任务` : '全账号自动化任务已启动'
    });
  });

  // 5. 中断停止
  app.post('/api/tasks/stop', (req, res) => {
    taskManager.stop();
    res.json({ success: true, message: '已发出停止指令' });
  });

  // 6. 实时日志流 (SSE)
  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // 先发送最近日志历史
    const initialLogs = logger.getLogs();
    res.write(`data: ${JSON.stringify({ type: 'history', logs: initialLogs })}\n\n`);

    const logListener = (entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    };

    const timelineListener = (item) => {
      res.write(`data: ${JSON.stringify({ type: 'timeline', item })}\n\n`);
    };

    logger.on('log', logListener);
    logger.on('timeline', timelineListener);

    req.on('close', () => {
      logger.off('log', logListener);
      logger.off('timeline', timelineListener);
    });
  });

  // 7. 小白一键换取 Token
  app.post('/api/auth/exchange-code', async (req, res) => {
    const { urlOrCode, accountId, name, order } = req.body;
    if (!urlOrCode) {
      return res.status(400).json({ success: false, message: '请提供跳转链接或授权码' });
    }
    try {
      // name/order 用于「配置向导」新建账号时带上名称与序号
      const result = await authManager.exchangeCodeForToken(urlOrCode, accountId, { name, order });
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 7.5 单独测试并保存 Cookie
  app.post('/api/auth/test-cookie', async (req, res) => {
    const { cookie, accountId } = req.body;
    if (!cookie) {
      return res.status(400).json({ success: false, message: '请提供 Cookie' });
    }
    try {
      // 只做校验，不落库：以前这里会 upsertAccount，导致「测试 Cookie」按钮
      // 凭空创建出一个名为「账号 (xxx)」的账号。真正的保存由向导最后一步统一提交。
      const status = await authManager.checkCookieStatus(cookie, accountId);
      const existing = configManager.findAccount(accountId);
      if (status.valid && existing) {
        const accStats = taskManager.ensureAccountStats(existing.id);
        if (status.balance > 0) accStats.balance = status.balance;
        if (status.streakDays > 0) accStats.streakDays = status.streakDays;
        if (status.stamps) accStats.stamps = status.stamps;
        taskManager.saveStats();
      }
      res.json({ success: true, data: status });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 8. 全面测试账户状态并在 Docker 中完成体检
  app.post('/api/auth/test', async (req, res) => {
    const targetAccountId = req.body?.accountId || null;
    try {
      const result = await authManager.testAccount(targetAccountId);
      // 获取当前网络出口信息
      const [ipInfo, regionPass] = await Promise.all([
        rewardsApi.getIPInfo(),
        rewardsApi.checkRegion(0)
      ]);

      result.network = {
        region: rewardsApi.region,
        regionPass,
        ipInfo: ipInfo || '未知'
      };

      // 如果成功获取到积分，同步更新当前账户的总积分
      if (result.balance > 0) {
        const accStats = taskManager.ensureAccountStats(targetAccountId || 'acc_1');
        accStats.balance = result.balance;
        taskManager.saveStats();
      }

      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 9. 测试代理连通性及地区
  app.post('/api/proxy/test', async (req, res) => {
    const { proxyUrl, useProxy } = req.body;
    if (useProxy && proxyUrl) {
      configManager.update({ network: { useProxy, proxyUrl } });
    }
    try {
      const ipInfo = await rewardsApi.getIPInfo();
      const regionPass = await rewardsApi.checkRegion(0);
      res.json({
        success: true,
        region: rewardsApi.region,
        regionPass,
        ipInfo: ipInfo || '未知'
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 10. 测试通知
  app.post('/api/notify/test', async (req, res) => {
    const { channel, value } = req.body;
    if (!channel || !value) {
      return res.status(400).json({ success: false, message: '参数缺失' });
    }
    try {
      await notifier.testChannel(channel, value);
      res.json({ success: true, message: '测试消息发送成功' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 11. 获取历史积分趋势与明细 (支持单账号与全局汇总)
  app.get('/api/history', (req, res) => {
    const days = parseInt(req.query.days, 10) || 7;
    const accountId = req.query.accountId || 'all';
    const history = historyManager.getHistory(days, accountId, taskManager.stats);
    res.json({ success: true, data: history });
  });

  return app;
}

export default createServer;
