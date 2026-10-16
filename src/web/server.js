import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import httpProxy from 'http-proxy';
import { fileURLToPath } from 'url';
import configManager, { SECRET_PLACEHOLDER } from '../config.js';
import logger from '../logger.js';
import taskManager from '../core/taskManager.js';
import authManager from '../core/auth.js';
import notifier from '../core/notifier.js';
import scheduler from '../scheduler.js';
import rewardsApi from '../core/api.js';
import historyManager from '../core/history.js';
import browserManager from '../core/browser.js';
import epicManager, { normalizeAutoClaimTime } from '../core/epic.js';
import { accountContextLock } from '../core/contextLock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CURRENT_VERSION = '1.7.5';

let lastCpuInfo = os.cpus().map(c => c.times);

/**
 * HTTP Basic 鉴权判定。Express 中间件与 noVNC 的 WebSocket 升级握手共用同一套规则，
 * 避免出现「页面要密码、WebSocket 不用」的绕过口子。
 */
export function isBasicAuthSatisfied(req) {
  const password = configManager.get()?.server?.authPassword;
  if (!password) return true;

  const header = req.headers?.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    const pass = sep >= 0 ? decoded.slice(sep + 1) : decoded;
    return pass === password;
  } catch {
    return false;
  }
}

// 宿主机整机 CPU 负载率（仅在读不到容器 cgroup 时作为回退值）
function getHostCpuUsage() {
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

// ===== 容器资源监控 =====
// 说明：os.cpus()/os.totalmem() 读到的是「宿主机整机」数据，不是容器自身占用。
// 在 Docker/NAS 里必须读 cgroup，才能得到用户实际关心的容器 CPU 与内存。
// 不同 NAS 的 cgroup 形态差异很大（v1/v2、容器内私有命名空间、宿主机挂载），
// 因此按 /proc/self/cgroup + /proc/self/mountinfo 动态解析容器自身的 cgroup 目录。
// MSR_CGROUP_DIR 仅用于测试时覆盖解析结果。

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

/** 解析 /proc/self/cgroup：v2 统一层级路径 + v1 各 controller 路径 */
function parseSelfCgroup() {
  const text = readTextFile('/proc/self/cgroup') || '';
  const v2Match = text.match(/^0::(.*)$/m);
  const v1 = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\d+:([^:]*):(.*)$/);
    if (!m) continue;
    for (const c of m[1].split(',')) {
      if (c) v1[c] = m[2];
    }
  }
  return { v2: v2Match ? v2Match[1] : null, v1 };
}

/** 解析 /proc/self/mountinfo 中的 cgroup 挂载点 */
function parseCgroupMounts() {
  const text = readTextFile('/proc/self/mountinfo') || '';
  const mounts = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    const sep = parts.indexOf('-');
    if (sep === -1) continue;
    mounts.push({
      root: parts[3] || '/',
      mountPoint: parts[4] || '',
      fstype: parts[sep + 1] || '',
      superOptions: parts[sep + 3] || ''
    });
  }
  return mounts;
}

function joinCgroupPath(mountPoint, mountRoot, cgroupPath) {
  let rel = cgroupPath || '/';
  if (mountRoot && mountRoot !== '/' && rel.startsWith(mountRoot)) {
    rel = rel.slice(mountRoot.length);
  }
  const joined = path.join(mountPoint, rel || '/');
  // 去掉末尾多余的 '/'（path.join('/sys/fs/cgroup', '/') 会得到带尾斜杠的结果）
  return joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
}

/**
 * 返回容器自身 cgroup 目录候选（按优先级）。
 * controller 仅用于 cgroup v1（'memory' / 'cpuacct'）。
 */
function resolveCgroupDirs(controller) {
  const override = process.env.MSR_CGROUP_DIR;
  if (override) {
    // 测试用：直接指定目录，v2/v1 文件都尝试
    return [{ dir: override, version: 2 }, { dir: override, version: 1 }];
  }

  const { v2, v1 } = parseSelfCgroup();
  const mounts = parseCgroupMounts();
  const dirs = [];

  if (v2 !== null) {
    const mount = mounts.find(m => m.fstype === 'cgroup2');
    if (mount) dirs.push({ dir: joinCgroupPath(mount.mountPoint, mount.root, v2), version: 2 });
  }
  const cgPath = v1[controller];
  if (cgPath !== undefined) {
    const mount = mounts.find(m => m.fstype === 'cgroup' && m.superOptions.split(',').includes(controller));
    if (mount) dirs.push({ dir: joinCgroupPath(mount.mountPoint, mount.root, cgPath), version: 1 });
  }
  // 兜底：cgroup 命名空间私有时，/sys/fs/cgroup 根目录就是容器自身
  if (v2 === '/') dirs.push({ dir: '/sys/fs/cgroup', version: 2 });
  if (v1[controller] === '/') dirs.push({ dir: '/sys/fs/cgroup', version: 1 });

  return dirs;
}

/** 容器累计 CPU 时间（微秒），读不到返回 null */
function readContainerCpuUsec() {
  for (const { dir, version } of resolveCgroupDirs('cpuacct')) {
    if (version === 2) {
      // cgroup v2: cpu.stat -> usage_usec
      const stat = readTextFile(path.join(dir, 'cpu.stat'));
      const m = stat && stat.match(/^usage_usec\s+(\d+)/m);
      if (m) return Number(m[1]);
      continue;
    }
    // cgroup v1: cpuacct.usage 单位是纳秒
    const raw = readTextFile(path.join(dir, 'cpuacct.usage'));
    if (raw && /^\d+$/.test(raw)) return Math.floor(Number(raw) / 1000);
  }
  return null;
}

let lastContainerCpu = null;
let lastContainerCpuPercent = 0;

/**
 * 容器 CPU 占用百分比（与 docker stats 口径一致：占单核的百分比，
 * 例如 150% 表示约 1.5 个核心）。首次采样没有基线，返回 0。
 */
function getContainerCpuPercent() {
  const usageUsec = readContainerCpuUsec();
  const now = Date.now();
  if (usageUsec === null) return null;

  if (!lastContainerCpu) {
    lastContainerCpu = { usageUsec, at: now };
    return 0;
  }
  const cpuDelta = usageUsec - lastContainerCpu.usageUsec;
  const wallDeltaUsec = (now - lastContainerCpu.at) * 1000;
  // 采样窗口过短（例如用户手动连点刷新）会让百分比剧烈抖动，直接复用上次结果
  if (wallDeltaUsec < 1000 * 1000) return lastContainerCpuPercent;
  lastContainerCpu = { usageUsec, at: now };
  if (cpuDelta < 0) return lastContainerCpuPercent;
  lastContainerCpuPercent = Math.max(0, Math.min(999, Math.round((cpuDelta / wallDeltaUsec) * 100)));
  return lastContainerCpuPercent;
}

/**
 * 容器内存占用（字节）。与 docker stats 一样扣除 inactive file cache，
 * 否则会把页面缓存也算成占用。读不到 cgroup 时返回 null。
 */
function readContainerMemory() {
  for (const { dir, version } of resolveCgroupDirs('memory')) {
    if (version === 2) {
      const current = readTextFile(path.join(dir, 'memory.current'));
      if (current === null) continue;
      const stat = readTextFile(path.join(dir, 'memory.stat'));
      const limitRaw = readTextFile(path.join(dir, 'memory.max'));
      const inactiveFile = stat ? Number((stat.match(/^inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
      const limit = limitRaw && limitRaw !== 'max' ? Number(limitRaw) : null;
      return {
        usage: Math.max(0, Number(current) - inactiveFile),
        limit: limit && Number.isFinite(limit) ? limit : null,
        source: 'cgroup v2'
      };
    }
    const current = readTextFile(path.join(dir, 'memory.usage_in_bytes'));
    if (current === null) continue;
    const stat = readTextFile(path.join(dir, 'memory.stat'));
    const limitRaw = readTextFile(path.join(dir, 'memory.limit_in_bytes'));
    const inactiveFile = stat ? Number((stat.match(/^total_inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
    const limitNum = limitRaw ? Number(limitRaw) : null;
    return {
      usage: Math.max(0, Number(current) - inactiveFile),
      // v1 的“无限制”是一个极大的数字（约 2^63），需要过滤掉
      limit: limitNum && limitNum < 1e15 ? limitNum : null,
      source: 'cgroup v1'
    };
  }
  return null;
}

/**
 * 兜底方案：累计容器内所有进程的 RSS。
 * 容器 PID 命名空间下 /proc 只包含本容器进程，这样即使读不到 cgroup，
 * 也能得到 node + Chromium 等全部进程的合计占用，而不是只有 Node 一个进程。
 */
function sumContainerProcessRss() {
  const selfCgroup = readTextFile('/proc/self/cgroup') || '';
  let totalBytes = 0;
  let counted = 0;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    // 只统计与本进程同 cgroup 的进程，避免 --pid=host 时把宿主机进程也算进来
    if (readTextFile(`/proc/${name}/cgroup`) !== selfCgroup) continue;
    const status = readTextFile(`/proc/${name}/status`);
    const m = status && status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    if (m) {
      totalBytes += Number(m[1]) * 1024;
      counted++;
    }
  }
  if (counted === 0) return null;
  return { usage: totalBytes, limit: null, source: `进程合计 (${counted} 个进程)` };
}

let lastPingMs = 28;
let lastPingTime = 0;

/**
 * 语义化版本号比较（返回 >0 表示 a 比 b 新）。
 * 不能用字符串直接比较：字符串比较下 "1.4.9" 会大于 "1.4.10"，从而误报有新版本。
 */
function compareVersions(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

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
  app.disable('x-powered-by');

  // 健康检查（免认证）：Docker HEALTHCHECK 用它，否则开启密码后会因 401 被判为不健康
  app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  // 访问控制：当配置了 server.authPassword 时启用 HTTP Basic 认证。
  // 注意：/api/config 会返回全部账号的 Cookie 与 Token，未设密码时任何能访问该端口的人
  // 都能拿到账号凭据，强烈建议设置密码（尤其是把端口暴露到内网之外时）。
  app.use((req, res, next) => {
    if (isBasicAuthSatisfied(req)) return next();

    res.set('WWW-Authenticate', 'Basic realm="Microsoft Rewards", charset="UTF-8"');
    res.status(401).send('需要认证：请在配置中设置 server.authPassword 后使用该密码访问');
  });

  // noVNC 通过现有 5308 端口反向代理，避免依赖宿主机额外映射 6080。
  // 必须注册在认证中间件之后：noVNC 能直接操作已登录 Epic 会话的浏览器，
  // 一旦绕过密码就等于把账号交出去。
  const novncProxy = httpProxy.createProxyServer({
    target: `http://127.0.0.1:${process.env.NOVNC_PORT || 6080}`,
    ws: true,
    changeOrigin: true
  });
  novncProxy.on('error', (err, req, res) => {
    if (res?.writeHead && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`noVNC 代理不可用: ${err.message}`);
    }
  });
  app.locals.novncProxy = novncProxy;
  // 供 src/index.js 在 WebSocket 升级阶段复用同一套鉴权规则。
  app.locals.isBasicAuthSatisfied = isBasicAuthSatisfied;
  // noVNC 静态资源从容器内 /usr/share/novnc 提供（Debian novnc 包默认路径）。
  app.use('/novnc', express.static(process.env.NOVNC_STATIC_DIR || '/usr/share/novnc'));
  // 不使用 app.use('/websockify', ...)：express 会剥掉挂载前缀，这里保留原始 URL 再转发。
  app.use((req, res, next) => {
    const requestUrl = String(req.url || '');
    const isNovncPath = requestUrl.startsWith('/novnc/websockify');
    if (!requestUrl.startsWith('/websockify') && !isNovncPath) return next();
    if (isNovncPath) {
      req.url = req.url.replace(/^\/novnc/, '');
    }
    novncProxy.web(req, res);
  });

  // 配置里可能包含多个账号的完整 Cookie，默认 100KB 很容易在保存时触发 413。
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 0. 系统硬件与网络实时监控指标
  app.get('/api/system/metrics', async (req, res) => {
    try {
      const containerCpu = getContainerCpuPercent();
      const hostCpuPercent = getHostCpuUsage();
      const ping = await getNetworkPing();

      // 宿主机整机内存（仅作参考，NAS 上通常远大于容器占用）
      const totalMemBytes = os.totalmem();
      const freeMemBytes = os.freemem();
      const usedMemBytes = totalMemBytes - freeMemBytes;
      const hostMemPercent = Math.round((usedMemBytes / totalMemBytes) * 100);

      // 容器自身内存（含 Chromium 等子进程），这才是用户想看的数字。
      // 读不到 cgroup 时退而求其次，累计容器内所有进程的 RSS。
      const containerMem = readContainerMemory() || sumContainerProcessRss();
      const memUsage = process.memoryUsage();
      const procMemMB = Math.round(memUsage.rss / (1024 * 1024));
      const heapUsedMB = Math.round(memUsage.heapUsed / (1024 * 1024));
      const heapTotalMB = Math.round(memUsage.heapTotal / (1024 * 1024));
      const totalMemGB = (totalMemBytes / (1024 * 1024 * 1024)).toFixed(1);
      const usedMemGB = (usedMemBytes / (1024 * 1024 * 1024)).toFixed(1);

      const containerMemMB = containerMem ? Math.round(containerMem.usage / (1024 * 1024)) : procMemMB;
      const containerLimitMB = containerMem?.limit ? Math.round(containerMem.limit / (1024 * 1024)) : null;
      const containerMemPercent = containerLimitMB
        ? Math.max(0, Math.min(100, Math.round((containerMemMB / containerLimitMB) * 100)))
        : null;

      // 顶部胶囊优先展示容器指标；读不到 cgroup（例如本机直接跑）时回退到整机/进程指标
      const displayCpuPercent = containerCpu === null ? hostCpuPercent : containerCpu;
      const displayMemMB = containerMem ? containerMemMB : procMemMB;
      const displayMemPercent = containerMemPercent === null ? hostMemPercent : containerMemPercent;

      const uptimeSec = Math.floor(process.uptime());
      const uptimeStr = uptimeSec > 3600
        ? `${Math.floor(uptimeSec / 3600)}小时 ${Math.floor((uptimeSec % 3600) / 60)}分`
        : `${Math.floor(uptimeSec / 60)}分 ${uptimeSec % 60}秒`;

      res.json({
        success: true,
        data: {
          cpu: `${displayCpuPercent}%`,
          cpuIsContainer: containerCpu !== null,
          procMem: `${displayMemMB} MB`,
          memIsContainer: !!containerMem,
          sysMem: `${usedMemGB}G/${totalMemGB}G`,
          memPercent: displayMemPercent,
          ping: `${ping} ms`,
          containerDetails: {
            processRss: `${procMemMB} MB`,
            heap: `${heapUsedMB} MB / ${heapTotalMB} MB`,
            containerMemory: containerMem ? `${containerMemMB} MB` : null,
            containerMemoryLimit: containerLimitMB ? `${containerLimitMB} MB` : '无限制',
            containerMemoryPercent: containerMemPercent,
            containerMemorySource: containerMem?.source || null,
            hostMemory: `${usedMemGB} GB / ${totalMemGB} GB (${hostMemPercent}%)`,
            hostCpu: `${hostCpuPercent}%`,
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
  // 注意：发布流程只推 git tag，不建 GitHub Release，所以不能用 releases/latest。
  // 它返回的是「最近一次发布的 Release」，历史上只到 v1.6.2；于是 v1.6.3~v1.7.2
  // 之间的用户比较出来是「无需更新」，永远收不到升级提示。
  // 这里改为直接读 tags 列表取语义化版本最大值，Release 仅用于补充更新说明。
  let cachedLatest = null;
  let cachedLatestTime = 0;

  const GITHUB_REPO = 'wangheqiang530/microsoft-rewards-docker';

  async function fetchLatestVersionInfo() {
    const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags?per_page=100`, {
      headers: { 'User-Agent': 'microsoft-rewards-docker', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000)
    });
    if (!tagRes.ok) throw new Error(`GitHub tags 接口返回 ${tagRes.status}`);
    const tags = await tagRes.json();
    if (!Array.isArray(tags)) throw new Error('GitHub tags 返回格式异常');

    let latest = null;
    for (const t of tags) {
      const name = String(t?.name || '').trim();
      // 只认 vX.Y.Z 形式的版本标签，过滤掉临时标签
      if (!/^v\d+\.\d+\.\d+$/.test(name)) continue;
      if (!latest || compareVersions(name.replace(/^v/, ''), latest) > 0) {
        latest = name.replace(/^v/, '');
      }
    }
    if (!latest) throw new Error('未在 tags 中找到 vX.Y.Z 形式的版本标签');

    // 更新说明是锦上添花，拿不到不影响版本比较
    let release = null;
    try {
      const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${latest}`, {
        headers: { 'User-Agent': 'microsoft-rewards-docker', 'Accept': 'application/vnd.github+json' },
        signal: AbortSignal.timeout(4000)
      });
      if (relRes.ok) release = await relRes.json();
    } catch {}

    return { latestVersion: latest, release };
  }

  app.get('/api/system/check-update', async (req, res) => {
    const currentVersion = CURRENT_VERSION;
    try {
      if (!cachedLatest || Date.now() - cachedLatestTime > 10 * 60 * 1000) {
        cachedLatest = await fetchLatestVersionInfo();
        cachedLatestTime = Date.now();
      }

      const latestVersion = cachedLatest.latestVersion;
      const release = cachedLatest.release;
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      res.json({
        success: true,
        data: {
          currentVersion,
          latestVersion,
          hasUpdate,
          checkFailed: false,
          releaseUrl: release?.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/v${latestVersion}`,
          releaseTitle: release?.name || `v${latestVersion}`,
          releaseNotes: release?.body || ''
        }
      });
    } catch (e) {
      // 检查失败必须如实上报。以前这里静默回退成「已是最新」，
      // 让「GitHub 被墙 / 限流」和「确实是最新版」两种情况长得一模一样。
      res.json({
        success: true,
        data: {
          currentVersion,
          latestVersion: currentVersion,
          hasUpdate: false,
          checkFailed: true,
          checkError: e.message,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases`
        }
      });
    }
  });

  // 1. 获取当前状态（支持按账号过滤）
  app.get('/api/status', (req, res) => {
    const accountId = req.query.accountId || 'all';
    const data = taskManager.getStatus(accountId);
    // 附带各账号的下次计划启动时间，供卡片展示
    data.schedule = scheduler.getNextRunInfo();
    res.json({
      success: true,
      data
    });
  });

  // 1.2 主动从微软官网同步真实完成进度
  app.post('/api/status/sync', async (req, res) => {
    try {
      const accountId = req.body?.accountId || null;
      // 有任务正在执行时不允许同步：同步会切换全局账号上下文，
      // 把正在跑的任务算到别的账号头上。此时直接返回当前缓存状态。
      const busy = accountContextLock.isBusy();
      let skipped = false;
      if (accountId && accountId !== 'all') {
        const accCfg = configManager.resolveAccount(accountId);
        if (!accCfg) {
          return res.status(404).json({ success: false, message: '账号未找到' });
        }
        skipped = busy;
        if (!busy) await taskManager.syncAccountOfficialStatus(accCfg);
      } else {
        skipped = busy;
        if (!busy) await taskManager.syncAllOfficialStatus();
      }
      res.json({
        success: true,
        skipped,
        message: skipped ? '任务正在执行中，已跳过同步以避免账号上下文串台' : '',
        data: taskManager.getStatus(accountId || 'all')
      });
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
      hasAuthCodeUrl: !!a.authCodeUrl,
      tokenTime: a.tokenTime || 0,
      authDiagnosis: a.authDiagnosis || null,
      timeSlot: a.timeSlot
    }));
    res.json({ success: true, data: accounts });
  });

  app.post('/api/accounts', async (req, res) => {
    try {
      if (req.body?.id && accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能修改该账号凭据' });
      }
      const accountPayload = { ...(req.body || {}) };
      delete accountPayload.tokenAlreadyExchanged;
      let saved = configManager.upsertAccount(accountPayload);
      taskManager.ensureAccountStats(saved.id);
      let tokenExchanged = false;
      if (req.body?.authCodeUrl && String(req.body.authCodeUrl).includes('code=') && req.body?.tokenAlreadyExchanged !== true) {
        try {
          await authManager.exchangeCodeForToken(req.body.authCodeUrl, saved.id, {
            name: saved.name,
            order: saved.order
          });
          saved = configManager.getAccount(saved.id) || saved;
          tokenExchanged = true;
        } catch (eToken) {
          logger.log('🟡', `新建账号 [${saved.name}] 自动换取 Token 提示: ${eToken.message}`);
        }
      }
      res.json({ success: true, data: { id: saved.id, name: saved.name }, tokenExchanged });
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
      const newEnabled = acc.enabled === false;
      configManager.upsertAccount({ id: acc.id, enabled: newEnabled });
      res.json({ success: true, enabled: newEnabled, message: newEnabled ? '账号已继续自动巡检' : '账号已暂停巡检' });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/accounts/:id', (req, res) => {
    try {
      if (taskManager.running || accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，请先停止任务再删除账号' });
      }
      const deleted = configManager.deleteAccount(req.params.id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: '账号不存在' });
      }
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
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '已有任务正在执行，请稍后再试' });
      }
      const accountId = req.body?.accountId || null;
      const result = await taskManager.runSingleTestSearch(accountId);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 任务卡片点击执行：签到、阅读、搜索或打孔卡推进一次
  app.post('/api/tasks/card-action', async (req, res) => {
    try {
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '已有任务正在执行，请稍后再试' });
      }
      const { accountId, taskKey } = req.body || {};
      const result = await taskManager.runTaskAction(accountId, taskKey);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 领取 Dashboard 额外待领积分 (点击卡片触发)
  app.post('/api/tasks/claim-points', async (req, res) => {
    try {
      const accountId = req.body?.accountId || 'all';
      if (accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再领取额外积分' });
      }
      if (process.env.EPIC_DEMO === '1' || process.env.MSR_DEMO === '1') {
        let totalClaimed = 0;
        const accounts = configManager.getAccounts();
        const targets = accountId === 'all' ? accounts : accounts.filter(a => a.id === accountId);
        for (const a of targets) {
          const st = taskManager.ensureAccountStats(a.id);
          const pts = Number(st.claimablePoints || 0);
          if (pts > 0) {
            totalClaimed += pts;
            st.balance = (st.balance || 0) + pts;
            st.earned = (st.earned || 0) + pts;
            st.claimablePoints = 0;
            logger.log('🎁', `成功领取账号 [${a.name}] 待领积分 +${pts} 分！`, '', a.name);
            logger.addTimeline(a.name, `领取额外待领积分 +${pts} 分`);
          }
        }
        taskManager.saveStats();
        return res.json({
          success: true,
          claimed: totalClaimed,
          message: totalClaimed > 0 ? `成功领取 ${totalClaimed} 点额外积分！` : '当前没有待领取的额外积分'
        });
      }

      const claimed = await taskManager.claimPendingPoints(accountId);
      res.json({
        success: true,
        claimed,
        message: claimed > 0 ? `成功领取 ${claimed} 点额外积分！` : '当前没有待领取的额外积分'
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 2. 获取配置
  app.get('/api/config', (req, res) => {
    res.json({
      success: true,
      data: configManager.getPublicConfig()
    });
  });

  // 3. 更新配置
  app.post('/api/config', (req, res) => {
    try {
      if (Array.isArray(req.body?.accounts) && accountContextLock.isBusy()) {
        return res.status(409).json({ success: false, message: '任务正在执行中，暂不能保存账号配置' });
      }
      const updated = configManager.update(req.body);
      scheduler.restart();
      logger.log('⚙️', '配置已更新并已生效');
      res.json({ success: true, data: configManager.getPublicConfig() });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 4. 手动立即执行（支持指定单账号或全部账号）
  app.post('/api/tasks/run', async (req, res) => {
    if (taskManager.running) {
      return res.json({ success: false, message: '任务正在运行中' });
    }
    if (accountContextLock.isBusy()) {
      return res.status(409).json({ success: false, message: '已有同步或账号操作正在执行，请稍后再启动任务' });
    }
    const targetAccountId = req.body?.accountId || null;
    if (targetAccountId) {
      const targetAcc = configManager.resolveAccount(targetAccountId);
      if (!targetAcc) return res.status(404).json({ success: false, message: '账号不存在' });
      if (targetAcc.enabled === false) {
        return res.status(409).json({ success: false, message: '该账号已停用，请先恢复自动巡检' });
      }
      const blockReason = taskManager.getAccountBlockReason(targetAcc);
      if (blockReason) {
        return res.status(409).json({ success: false, message: `账号凭据异常，已拒绝执行：${blockReason}` });
      }
    }
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

  // 5.5 历史日志（读取 data/app.log 末尾，供「全部日志」弹窗）
  app.get('/api/logs/history', (req, res) => {
    const limit = Math.min(1000, Math.max(50, parseInt(req.query.limit, 10) || 300));
    res.json({ success: true, data: logger.getRecentFromFile(limit) });
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
    const { urlOrCode, accountId, name, order, draft } = req.body;
    if (!urlOrCode) {
      return res.status(400).json({ success: false, message: '请提供跳转链接或授权码' });
    }
    if (accountId && accountContextLock.isBusy()) {
      return res.status(409).json({ success: false, message: '任务正在执行中，暂不能更新该账号的移动端凭据' });
    }
    try {
      // name/order 用于「配置向导」新建账号时带上名称与序号
      const result = await authManager.exchangeCodeForToken(urlOrCode, accountId, { name, order, persist: draft !== true });
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
      let cookieToTest = cookie;
      if (cookie === SECRET_PLACEHOLDER) {
        const acc = configManager.resolveAccount(accountId);
        if (!acc?.cookie) {
          return res.status(400).json({ success: false, message: '该账号尚未保存 Cookie' });
        }
        cookieToTest = acc.cookie;
      }
      // 只做校验，不落库：以前这里会 upsertAccount，导致「测试 Cookie」按钮
      // 凭空创建出一个名为「账号 (xxx)」的账号。真正的保存由向导最后一步统一提交。
      const status = await authManager.checkCookieStatus(cookieToTest, accountId);
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

  // 8. 全面测试账户状态并在 Docker 中完成体检（结果落盘，供账号卡片展示）
  async function runAccountDiagnosis(accountId) {
    const targetAccountId = accountId || null;
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

    const diagnosis = configManager.recordAuthDiagnosis(result.accountId, {
      cookieValid: result.cookie?.valid,
      tokenValid: result.token?.valid,
      overallValid: result.overallValid,
      warning: result.warning,
      warningMessage: result.warningMessage,
      balance: result.balance,
      cookieMessage: result.cookie?.message,
      tokenMessage: result.token?.message
    });
    result.diagnosis = diagnosis;

    // 如果成功获取到积分，同步更新当前账户的总积分
    if (result.balance > 0) {
      const accStats = taskManager.ensureAccountStats(result.accountId || 'acc_1');
      accStats.balance = result.balance;
      taskManager.saveStats();
    }
    return result;
  }

  app.post('/api/auth/test', async (req, res) => {
    if (!accountContextLock.tryAcquire('web-diagnosis')) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再体检（避免账号上下文串台）' });
    }
    try {
      const result = await runAccountDiagnosis(req.body?.accountId || null);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      accountContextLock.release('web-diagnosis');
    }
  });

  // 8.5 一键体检全部账号（逐个串行，避免并发触发微软风控）
  app.post('/api/auth/test-all', async (req, res) => {
    if (!accountContextLock.tryAcquire('web-diagnosis')) {
      return res.status(409).json({ success: false, message: '任务正在执行中，请稍后再体检（避免账号上下文串台）' });
    }
    try {
      const accounts = configManager.getAccounts();
      const results = [];
      for (const acc of accounts) {
        try {
          results.push(await runAccountDiagnosis(acc.id));
        } catch (e) {
          results.push({
            accountId: acc.id,
            accountName: acc.name || acc.id,
            cookie: { valid: false, message: e.message },
            token: { valid: false, message: e.message },
            overallValid: false,
            allValid: false,
            balance: 0,
            error: e.message
          });
        }
      }
      const validCount = results.filter(r => r.allValid).length;
      res.json({
        success: true,
        data: {
          results,
          total: results.length,
          validCount
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    } finally {
      accountContextLock.release('web-diagnosis');
    }
  });

  // 9. 测试代理连通性及地区
  app.post('/api/proxy/test', async (req, res) => {
    const { proxyUrl, useProxy } = req.body;
    if (accountContextLock.isBusy()) {
      return res.status(409).json({ success: false, message: '任务正在执行中，暂不能切换代理配置' });
    }
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

  // ===== Epic 免费游戏领取 =====

  app.get('/api/epic/accounts', (req, res) => {
    const accounts = configManager.getEpicAccounts().map(a => {
      const summary = epicManager.summarizeSession(a.storageState);
      return {
        id: a.id,
        name: a.name,
        order: a.order,
        enabled: a.enabled !== false,
        hasSession: summary.cookieCount > 0,
        cookieCount: summary.cookieCount,
        hasEpicSession: summary.hasEpicSession,
        sessionValid: a.sessionValid ?? null,
        handledGameIds: Object.keys(a.handledGames || {}),
        handledGames: a.handledGames || {},
        lastVerifyAt: a.lastVerifyAt || 0,
        lastVerifyMessage: a.lastVerifyMessage || '',
        lastClaimAt: a.lastClaimAt || 0,
        lastClaimMessage: a.lastClaimMessage || ''
      };
    });
    res.json({ success: true, data: accounts });
  });

  app.post('/api/epic/accounts', (req, res) => {
    try {
      const saved = configManager.upsertEpicAccount(req.body || {});
      res.json({ success: true, data: { id: saved.id } });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.delete('/api/epic/accounts/:id', async (req, res) => {
    try {
      const accountId = req.params.id;
      if (epicManager.running || epicManager.checking || epicManager.verifying) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请先停止任务再删除账号' });
      }
      await epicManager.closeLoginWindowForAccount(accountId);
      const ok = configManager.deleteEpicAccount(accountId);
      res.json({ success: ok, message: ok ? '账号已删除' : '账号不存在' });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // 导入会话（Cookie-Editor JSON / storageState / 原始 Cookie 串）
  app.post('/api/epic/accounts/:id/session', (req, res) => {
    try {
      if (epicManager.running || epicManager.verifying || epicManager.checking) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请先点击停止按钮，再更新会话' });
      }
      if (epicManager.isLoginWindowOpen()) {
        return res.status(409).json({ success: false, message: 'Epic 登录窗口已打开，请先保存或关闭登录窗口再导入会话' });
      }
      const acc = configManager.findEpicAccount(req.params.id);
      if (!acc) return res.status(404).json({ success: false, message: '账号不存在' });
      const storageState = epicManager.parseSessionInput(req.body?.session);
      const summary = epicManager.summarizeSession(storageState);
      configManager.updateEpicAccount(acc.id, {
        storageState,
        sessionValid: null,
        lastVerifyAt: 0,
        lastVerifyMessage: '',
        lastSessionImportAt: Date.now()
      });
      logger.log('🎮', `Epic 账号 [${acc.name}] 会话已导入（${summary.cookieCount} 个 Cookie${summary.hasEpicSession ? '，包含 Epic 登录凭据' : '，⚠️ 未检测到 EPIC 登录 Cookie'}）`, '', acc.name);
      res.json({ success: true, data: summary });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window', async (req, res) => {
    try {
      const result = await epicManager.openLoginWindow(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window/save', async (req, res) => {
    try {
      const result = await epicManager.saveLoginWindow(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/login-window/close', async (req, res) => {
    try {
      const result = await epicManager.closeLoginWindowForAccount(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  // 指纹自检：用与领取任务相同的启动参数开一次临时浏览器，回报风控最常看的信号。
  // Epic 的安全检查是服务端黑盒判定，先把「浏览器本身是否露馅」变成可观测的。
  app.get('/api/epic/fingerprint', async (req, res) => {
    try {
      const data = await epicManager.selfCheckFingerprint();
      res.json({ success: true, data });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/accounts/:id/verify', async (req, res) => {
    try {
      const result = await epicManager.verifySession(req.params.id);
      res.json({ success: true, data: result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get('/api/epic/free-games', async (req, res) => {
    try {
      const games = await epicManager.fetchFreeGames();
      res.json({ success: true, data: games });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/claim', async (req, res) => {
    try {
      if (epicManager.running || epicManager.checking || epicManager.verifying) {
        return res.status(409).json({ success: false, message: 'Epic 任务正在运行中，请稍后再试' });
      }
      if (epicManager.isLoginWindowOpen()) {
        return res.status(409).json({ success: false, message: 'Epic 登录窗口已打开，请先保存或关闭登录窗口' });
      }
      const accountId = req.body?.accountId || null;
      const data = accountId ? await epicManager.claimOne(accountId) : await epicManager.claimAll();
      res.json({ success: true, data });
    } catch (e) {
      if (e?.code === 'EPIC_STOPPED') {
        return res.json({ success: true, stopped: true, message: e.message, data: { results: [] } });
      }
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.post('/api/epic/stop', async (req, res) => {
    try {
      const result = await epicManager.stop();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  app.get('/api/epic/status', (req, res) => {
    res.json({
      success: true,
      data: {
        ...epicManager.getState(),
        settings: epicManager.getSettings(),
        demo: process.env.EPIC_DEMO === '1',
        records: configManager.getEpicClaimRecords(20)
      }
    });
  });

  // Epic 全局领取设置
  app.get('/api/epic/settings', (req, res) => {
    res.json({ success: true, data: epicManager.getSettings() });
  });

  app.post('/api/epic/settings', (req, res) => {
    try {
      const b = req.body || {};
      const current = epicManager.getSettings();
      const num = (v, min, max, dft) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return dft;
        return Math.max(min, Math.min(max, n));
      };
      configManager.update({
        epic: {
          enabled: b.enabled === undefined ? current.enabled : b.enabled !== false,
          autoClaimTime: normalizeAutoClaimTime(b.autoClaimTime === undefined ? current.autoClaimTime : b.autoClaimTime),
          checkIntervalMin: num(b.checkIntervalMin, 5, 10080, current.checkIntervalMin),
          retryCount: num(b.retryCount, 0, 5, current.retryCount),
          retryIntervalSec: num(b.retryIntervalSec, 10, 600, current.retryIntervalSec),
          accountGapSec: num(b.accountGapSec, 0, 600, current.accountGapSec)
        }
      });
      scheduler.restart(); // 让新的检查间隔立即生效
      logger.log('🎮', 'Epic 领取设置已更新');
      res.json({ success: true, data: epicManager.getSettings() });
    } catch (e) {
      res.status(400).json({ success: false, message: e.message });
    }
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status || err?.statusCode) || 500;
    res.status(status).json({ success: false, message: err?.message || '服务器内部错误' });
  });

  return app;
}

export default createServer;
