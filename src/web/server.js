import express from 'express';
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

export function createServer() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

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
        const accCfg = configManager.getAccount(accountId);
        await taskManager.syncAccountOfficialStatus(accCfg);
      } else {
        await taskManager.syncAllOfficialStatus();
      }
      res.json({ success: true, data: taskManager.getStatus(accountId || 'all') });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 1.5 多账号管理接口
  app.get('/api/accounts', (req, res) => {
    const accounts = configManager.getAccounts().map(a => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled !== false,
      hasCookie: !!a.cookie,
      hasToken: !!a.refreshToken,
      tokenTime: a.tokenTime || 0
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
      const acc = configManager.getAccount(req.params.id);
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
    const { urlOrCode, accountId } = req.body;
    if (!urlOrCode) {
      return res.status(400).json({ success: false, message: '请提供跳转链接或授权码' });
    }
    try {
      const result = await authManager.exchangeCodeForToken(urlOrCode, accountId);
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
      configManager.upsertAccount({ id: accountId || 'acc_1', cookie });
      const status = await authManager.checkCookieStatus(cookie, accountId);
      if (status.valid) {
        const accStats = taskManager.ensureAccountStats(accountId || 'acc_1');
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

  // 11. 获取历史积分趋势与明细
  app.get('/api/history', (req, res) => {
    const days = parseInt(req.query.days, 10) || 7;
    const history = historyManager.getHistory(days, taskManager.stats);
    res.json({ success: true, data: history });
  });

  return app;
}

export default createServer;
