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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer() {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 1. 获取当前状态
  app.get('/api/status', (req, res) => {
    res.json({
      success: true,
      data: taskManager.getStatus()
    });
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

  // 4. 手动立即执行
  app.post('/api/tasks/run', async (req, res) => {
    if (taskManager.running) {
      return res.json({ success: false, message: '任务正在运行中' });
    }
    // 异步执行，不阻塞 HTTP 响应
    taskManager.runAll(true);
    res.json({ success: true, message: '全自动化任务已启动' });
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
    const { urlOrCode } = req.body;
    if (!urlOrCode) {
      return res.status(400).json({ success: false, message: '请提供跳转链接或授权码' });
    }
    try {
      const result = await authManager.exchangeCodeForToken(urlOrCode);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 8. 测试账户状态
  app.post('/api/auth/test', async (req, res) => {
    try {
      const result = await authManager.testAccount();
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

  return app;
}

export default createServer;
