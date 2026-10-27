import fs from 'fs';
import path from 'path';
import { chromium } from 'patchright-core';
import configManager from '../config.js';
import logger from '../logger.js';
import networkClient from '../network.js';
import rewardsApi from './api.js';
import authManager, { AUTH_CONFIG } from './auth.js';
import {
  accountContextLock,
  browserSlotLock,
  firefoxSlotLock
} from './contextLock.js';
import { DATA_DIR, withTimeout } from '../fsUtil.js';
import { findChromiumExecutable } from './chromiumExecutable.js';
import { prepareBrowserProxy } from './localProxyBridge.js';
import {
  buildChromiumArgs,
  buildChromiumEnv,
  inspectDriEnvironment
} from './chromiumRuntime.js';
import {
  PC_USER_AGENT,
  SEC_CH_UA,
  PLATFORM,
  alignPageFingerprint,
  applyWebGLFingerprint
} from './fingerprint.js';
import {
  accountNamesLikelyMatch,
  cookieValue,
  isBalanceMismatch
} from './accountIdentity.js';
import { readBingLoginState } from './browser.js';

const LOGIN_PROFILE_DIR = path.join(DATA_DIR, 'ms-login-profiles');
const DEFAULT_TIMEOUT_MIN = 20;
const OAUTH_CODE_TIMEOUT_MS = 120000;

function safeSessionId(value) {
  return String(value || 'draft').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'draft';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isVncAvailable() {
  return process.env.VNC_ENABLED === '1' || process.env.EPIC_VISIBLE === '1';
}

export function extractOAuthCode(url) {
  const text = String(url || '');
  if (!/[?&]code=/i.test(text)) return '';
  try {
    return new URL(text).searchParams.get('code') || '';
  } catch {
    const match = text.match(/[?&]code=([^&#]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

export function resolveLoginProxy(selection = {}, account = null) {
  const mode = ['inherit', 'direct', 'proxy'].includes(selection?.mode)
    ? selection.mode
    : (['inherit', 'direct', 'proxy'].includes(account?.proxyMode)
      ? account.proxyMode
      : (account?.proxyId ? 'proxy' : 'direct'));
  if (mode === 'direct') {
    return {
      mode: 'direct',
      proxyId: '',
      proxyName: '',
      proxyUrl: '',
      missing: false,
      label: '直连'
    };
  }
  if (mode === 'inherit') {
    const network = configManager.get().network || {};
    if (!network.useProxy) {
      return {
        mode: 'direct',
        proxyId: '',
        proxyName: '',
        proxyUrl: '',
        missing: false,
        label: '直连（全局代理未启用）'
      };
    }
    const proxy = configManager.getDefaultProxy();
    if (!proxy?.url) throw new Error('当前账号跟随全局代理，但全局默认代理未配置');
    return {
      mode: 'proxy',
      proxyId: proxy.id || '',
      proxyName: proxy.name || '',
      proxyUrl: proxy.url,
      missing: false,
      label: `跟随全局代理：${proxy.name || proxy.id || '默认节点'}`
    };
  }
  const proxy = configManager.findProxy(selection.proxyId || account?.proxyId);
  if (!proxy?.url) throw new Error('当前账号选择了指定代理，但代理节点不存在');
  return {
    mode: 'proxy',
    proxyId: proxy.id || '',
    proxyName: proxy.name || '',
    proxyUrl: proxy.url,
    missing: false,
    label: `指定代理：${proxy.name || proxy.id || '代理节点'}`
  };
}

function cookieDomainPriority(domain) {
  const value = String(domain || '').toLowerCase();
  if (value === 'rewards.bing.com') return 0;
  if (value === 'cn.bing.com') return 1;
  if (value === '.bing.com' || value === 'bing.com') return 2;
  return 3;
}

export function serializeBingCookies(cookies = []) {
  const selected = new Map();
  for (const cookie of cookies) {
    const name = String(cookie?.name || '').trim();
    const domain = String(cookie?.domain || '').toLowerCase();
    if (!name || name === '_EDGE_S' || !domain.includes('bing.com')) continue;
    const priority = cookieDomainPriority(domain);
    const previous = selected.get(name);
    if (!previous || priority < previous.priority) {
      selected.set(name, {
        name,
        value: String(cookie.value ?? ''),
        domain,
        priority
      });
    }
  }
  return Array.from(selected.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(item => `${item.name}=${item.value}`)
    .join('; ');
}

async function captureBingCookies(context) {
  const batches = await Promise.all([
    context.cookies('https://rewards.bing.com/dashboard').catch(() => []),
    context.cookies('https://cn.bing.com/').catch(() => [])
  ]);
  return serializeBingCookies(batches.flat());
}

async function waitForOAuthCode(context, page) {
  const seen = new Set();
  let lastError = '';
  const inspect = (value) => {
    const url = String(value || '');
    if (!url || seen.has(url)) return '';
    seen.add(url);
    const code = extractOAuthCode(url);
    if (code) return url;
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get('error')) {
        lastError = parsed.searchParams.get('error_description')
          || parsed.searchParams.get('error')
          || 'OAuth 授权失败';
      }
    } catch {}
    return '';
  };

  const onFrame = frame => {
    if (frame === page.mainFrame()) inspect(frame.url());
  };
  page.on('framenavigated', onFrame);
  await page.goto(AUTH_CONFIG.authorizeUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  }).catch(() => {});

  const deadline = Date.now() + OAUTH_CODE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const urls = [
      page.url(),
      ...context.pages().map(item => item.url())
    ];
    for (const url of urls) {
      if (inspect(url)) {
        page.off('framenavigated', onFrame);
        return url;
      }
    }
    if (lastError) {
      page.off('framenavigated', onFrame);
      throw new Error(lastError);
    }
    await delay(1000);
  }
  page.off('framenavigated', onFrame);
  throw new Error('等待 OAuth 授权码超时，请确认已在 VNC 中完成同意授权');
}

function sameAccount(cookieStatus, tokenStatus) {
  if (!cookieStatus?.valid || !tokenStatus?.valid) return { ok: false, reason: '凭据验证未通过' };
  if (isBalanceMismatch(cookieStatus.balance, tokenStatus.balance)) {
    return {
      ok: false,
      reason: `Token 账号积分(${tokenStatus.balance}) 与网页端(${cookieStatus.balance}) 不一致`
    };
  }
  const nameMatch = accountNamesLikelyMatch(cookieStatus.userName, tokenStatus.userName);
  if (nameMatch === false) {
    return {
      ok: false,
      reason: `Token 用户(${tokenStatus.userName || '未知'}) 与网页端(${cookieStatus.userName || '未知'}) 不一致`
    };
  }
  return { ok: true, reason: '' };
}

class MicrosoftLoginWindowManager {
  constructor() {
    this.context = null;
    this.page = null;
    this.proxyBridge = null;
    this.owner = '';
    this.accountId = '';
    this.draftId = '';
    this.name = '';
    this.order = 0;
    this.proxy = null;
    this.phase = 'closed';
    this.message = '';
    this.error = '';
    this.detectedName = '';
    this.cookieReady = false;
    this.tokenReady = false;
    this.startedAt = 0;
    this.expiresAt = 0;
    this.timer = null;
    this.profileDir = '';
    this.capturing = false;
    this.useGpu = false;
    this.lastResult = null;
  }

  isOpen() {
    return !!this.context;
  }

  async status() {
    if (!this.context) {
      return {
        open: false,
        phase: this.phase,
        message: this.message,
        error: this.error
      };
    }
    if (this.page?.isClosed?.()) {
      await this.close('浏览器页面已关闭').catch(() => {});
      return { open: false, phase: 'closed', message: '登录窗口已关闭' };
    }
    if (this.phase === 'waiting_login' && this.page) {
      const login = await readBingLoginState(this.page);
      let contextHasU = false;
      try {
        const cookies = await this.context.cookies('https://rewards.bing.com/dashboard');
        contextHasU = cookies.some(cookie => cookie.name === '_U');
      } catch {}
      if (login.userName || login.cookieHasU || contextHasU) {
        if (login.userName) this.detectedName = login.userName;
        this.phase = 'logged_in';
        this.message = `已检测到登录${login.userName ? `用户：${login.userName}` : ''}，准备抓取 Cookie 与 Token`;
      }
    }
    return {
      open: this.isOpen(),
      phase: this.phase,
      accountId: this.accountId,
      draftId: this.draftId,
      name: this.name,
      detectedName: this.detectedName,
      proxy: this.proxy ? { mode: this.proxy.mode, label: this.proxy.label } : null,
      cookieReady: this.cookieReady,
      tokenReady: this.tokenReady,
      useGpu: this.useGpu,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      message: this.message,
      error: this.error
    };
  }

  async open(input = {}) {
    if (!isVncAvailable()) {
      throw new Error('当前未启用 VNC，请设置 VNC_ENABLED=1 后重启容器');
    }
    if (this.context) {
      throw new Error('已有微软登录窗口正在运行，请先保存或关闭');
    }
    const cfg = configManager.get();
    if (!cfg.server?.authPassword && !process.env.NOVNC_PASSWORD && process.env.VNC_ALLOW_INSECURE !== '1') {
      throw new Error('为避免局域网内他人接管登录窗口，请先设置 WebUI 访问密码或 NOVNC_PASSWORD');
    }

    const accountId = String(input.accountId || '').trim();
    const draftId = String(input.draftId || accountId || `draft_${Date.now()}`).trim();
    const account = accountId ? configManager.findAccount(accountId) : null;
    if (accountId && !account) throw new Error('账号不存在');
    const proxy = resolveLoginProxy(input.proxy || {}, account);
    const executablePath = findChromiumExecutable();
    if (!executablePath) throw new Error('未检测到 Chromium/Edge 浏览器内核');

    const owner = `ms-login:${safeSessionId(draftId)}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    if (!accountContextLock.tryAcquire(owner)) {
      throw new Error('微软积分任务或账号同步正在执行，请稍后再打开登录窗口');
    }
    if (!browserSlotLock.tryAcquire(owner)) {
      accountContextLock.release(owner);
      throw new Error('微软浏览器正在执行任务，请稍后再打开登录窗口');
    }
    if (!firefoxSlotLock.tryAcquire(owner)) {
      browserSlotLock.release(owner);
      accountContextLock.release(owner);
      throw new Error('Epic 浏览器正在执行任务，请先停止 Epic 任务');
    }

    this.owner = owner;
    this.accountId = accountId;
    this.draftId = draftId;
    this.name = String(input.name || account?.name || '候选账号').trim() || '候选账号';
    this.order = Number(input.order || account?.order || 0) || 0;
    this.proxy = proxy;
    this.phase = 'opening';
    this.message = '正在启动微软登录浏览器...';
    this.error = '';
    this.detectedName = '';
    this.cookieReady = false;
    this.tokenReady = false;
    this.startedAt = Date.now();
    this.lastResult = null;
    this.useGpu = configManager.get().browser?.useGpu === true;
    if (this.useGpu && !inspectDriEnvironment().available) {
      logger.log('🟡', '微软登录窗口请求核显，但容器内未发现 /dev/dri，已回退软件渲染');
      this.useGpu = false;
    }
    this.profileDir = path.join(LOGIN_PROFILE_DIR, `${safeSessionId(draftId)}-${Date.now()}-chromium`);
    fs.rmSync(this.profileDir, { recursive: true, force: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.expiresAt = this.startedAt + this.getTimeoutMinutes() * 60 * 1000;

    try {
      this.proxyBridge = await prepareBrowserProxy(proxy.proxyUrl);
      const launch = (useGpu) => chromium.launchPersistentContext(this.profileDir, {
        executablePath,
        headless: false,
        timeout: 90000,
        viewport: null,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        userAgent: PC_USER_AGENT,
        extraHTTPHeaders: {
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'sec-ch-ua': SEC_CH_UA,
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': PLATFORM.clientHint
        },
        ...(this.proxyBridge?.proxy ? { proxy: this.proxyBridge.proxy } : {}),
        args: buildChromiumArgs({
          useGpu,
          visible: true,
          extraArgs: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
        }),
        env: buildChromiumEnv({ useGpu })
      });

      try {
        this.context = await launch(this.useGpu);
      } catch (gpuError) {
        if (!this.useGpu) throw gpuError;
        logger.log('🟡', `微软登录窗口核显启动失败，自动回退软件渲染: ${String(gpuError.message || gpuError).split('\n')[0]}`);
        this.useGpu = false;
        fs.rmSync(this.profileDir, { recursive: true, force: true });
        fs.mkdirSync(this.profileDir, { recursive: true });
        this.context = await launch(false);
      }

      await applyWebGLFingerprint(this.context);
      this.page = this.context.pages()[0] || await this.context.newPage();
      await alignPageFingerprint(this.context, this.page);
      this.context.on?.('page', newPage => {
        alignPageFingerprint(this.context, newPage).catch(() => {});
      });
      await this.page.goto('https://rewards.bing.com/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      }).catch(error => {
        logger.log('🟡', `微软登录页加载提示: ${String(error.message || error).split('\n')[0]}`);
      });
      this.phase = 'waiting_login';
      this.message = '请在 VNC 中完成微软登录、MFA 或安全验证';
      this.scheduleTimeout();
      logger.log('🖥️', `已打开微软 VNC 登录窗口（${proxy.label}）`, '', this.name);
      return {
        opened: true,
        accountId: this.accountId,
        draftId: this.draftId,
        proxy: { mode: proxy.mode, label: proxy.label },
        expiresAt: this.expiresAt,
        useGpu: this.useGpu,
        message: this.message
      };
    } catch (error) {
      this.error = String(error.message || error).split('\n')[0];
      await this.close(`打开失败：${String(error.message || error).split('\n')[0]}`, { preserveError: true });
      throw error;
    }
  }

  getTimeoutMinutes() {
    const minutes = Number(process.env.MS_LOGIN_TIMEOUT_MIN ?? DEFAULT_TIMEOUT_MIN);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MIN;
  }

  scheduleTimeout() {
    this.clearTimeout();
    const minutes = this.getTimeoutMinutes();
    if (minutes <= 0) return;
    this.timer = setTimeout(() => {
      logger.log('⏱️', `微软 VNC 登录窗口超过 ${minutes} 分钟未完成，自动关闭并释放浏览器`);
      this.close('登录窗口超时，已自动关闭').catch(() => {});
    }, minutes * 60 * 1000);
    this.timer.unref?.();
  }

  clearTimeout() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async capture(input = {}) {
    if (!this.context || !this.page) throw new Error('当前没有打开的微软登录窗口');
    if (this.capturing) throw new Error('正在抓取凭据，请稍候');
    this.capturing = true;
    this.phase = 'capturing';
    this.error = '';
    this.message = '正在确认登录并抓取网页 Cookie...';
    let cookie = '';
    let cookieStatus = null;
    const prevContext = rewardsApi.snapshotAccountContext();
    const prevProxyContext = networkClient.getActiveProxyContext();

    try {
      await this.page.goto('https://rewards.bing.com/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      }).catch(() => {});
      await delay(1200);
      const login = await readBingLoginState(this.page);
      let contextHasU = false;
      try {
        const cookies = await this.context.cookies('https://rewards.bing.com/dashboard');
        contextHasU = cookies.some(cookie => cookie.name === '_U');
      } catch {}
      if (!login.userName && !login.cookieHasU && !contextHasU) {
        this.phase = 'waiting_login';
        this.message = '尚未检测到微软登录，请继续在 VNC 中完成登录';
        return {
          success: false,
          waitingLogin: true,
          message: this.message
        };
      }
      if (login.userName) this.detectedName = login.userName;

      cookie = await captureBingCookies(this.context);
      if (!cookieValue(cookie, '_U')) {
        await this.page.goto('https://cn.bing.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        }).catch(() => {});
        await delay(1500);
        cookie = await captureBingCookies(this.context);
      }
      if (!cookieValue(cookie, '_U')) {
        throw new Error('已登录，但未抓到 _U Cookie。请确认 VNC 页面已进入 rewards.bing.com/dashboard');
      }
      this.cookieReady = true;
      this.message = 'Cookie 已抓取，正在验证网页端身份...';

      const candidate = {
        id: this.draftId,
        name: this.name,
        order: this.order,
        cookie,
        proxyMode: this.proxy.mode === 'proxy' ? 'proxy' : 'direct',
        proxyId: this.proxy.proxyId || ''
      };
      rewardsApi.setCurrentAccount(candidate);
      networkClient.setActiveProxyContext({
        mode: this.proxy.mode,
        proxyId: this.proxy.proxyId || '',
        proxyName: this.proxy.proxyName || '',
        proxyUrl: this.proxy.proxyUrl || '',
        missing: false
      });
      cookieStatus = await authManager.checkCookieStatus(cookie, null);
      if (!cookieStatus.valid) throw new Error(cookieStatus.message || '网页 Cookie 验证失败');
      if (cookieStatus.userName) this.detectedName = cookieStatus.userName;

      this.message = '网页端已验证，正在打开 OAuth 授权并等待 code...';
      const oauthPage = await this.context.newPage();
      await alignPageFingerprint(this.context, oauthPage);
      await oauthPage.bringToFront().catch(() => {});
      let codeUrl = '';
      try {
        codeUrl = await waitForOAuthCode(this.context, oauthPage);
      } finally {
        await oauthPage.close().catch(() => {});
        await this.page.bringToFront().catch(() => {});
      }
      if (!codeUrl) throw new Error('未获取到 OAuth 授权码');

      this.message = '已获取授权码，正在交换移动端 Token...';
      const tokens = await authManager.exchangeCodeForToken(codeUrl, this.draftId, {
        name: this.name,
        order: this.order,
        persist: false
      });
      if (!tokens?.accessToken || !tokens?.refreshToken) {
        throw new Error('Token 交换未返回完整凭据');
      }
      this.tokenReady = true;
      this.message = 'Token 已获取，正在校验 Cookie 与 Token 是否属于同一账号...';
      const tokenStatus = await authManager.checkTokenStatus(this.draftId, {
        accountOverride: {
          ...candidate,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken
        },
        accessToken: tokens.accessToken
      });
      if (!tokenStatus.valid) throw new Error(tokenStatus.message || '移动端 Token 验证失败');
      const match = sameAccount(cookieStatus, tokenStatus);
      if (!match.ok) throw new Error(match.reason);

      const result = {
        success: true,
        accountId: this.accountId,
        draftId: this.draftId,
        name: this.name,
        order: this.order,
        detectedName: this.detectedName || cookieStatus.userName || '',
        cookie,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenTime: Date.now(),
        cookieStatus,
        tokenStatus,
        proxy: { mode: this.proxy.mode, label: this.proxy.label }
      };
      this.lastResult = {
        success: true,
        detectedName: result.detectedName,
        message: 'Cookie 与 Token 已获取'
      };
      this.phase = 'ready';
      this.message = 'Cookie 与 Token 已自动获取并通过账号匹配校验';
      logger.log('🟢', `微软 VNC 登录成功：${this.detectedName || this.name}`, '', this.name);
      return result;
    } catch (error) {
      const message = String(error.message || error).split('\n')[0];
      this.error = message;
      if (cookie && cookieStatus?.valid) {
        const partialResult = {
          partial: true,
          cookie,
          cookieStatus,
          detectedName: this.detectedName || cookieStatus.userName || '',
          message
        };
        this.lastResult = {
          partial: true,
          detectedName: partialResult.detectedName,
          message
        };
        this.phase = 'partial';
        this.message = `Cookie 已获取，但 Token 自动获取失败：${message}`;
        return {
          success: false,
          partial: true,
          message: this.message,
          data: partialResult
        };
      }
      this.phase = 'waiting_login';
      this.message = `自动抓取失败：${message}`;
      throw error;
    } finally {
      this.capturing = false;
      rewardsApi.restoreAccountContext(prevContext);
      networkClient.setActiveProxyContext(prevProxyContext);
      if (this.phase === 'ready') {
        await this.close('凭据已获取，登录窗口已关闭');
      } else if (this.phase === 'partial') {
        await this.close(this.message);
      }
    }
  }

  async close(reason = '', { preserveError = false } = {}) {
    const previousPhase = this.phase;
    const previousMessage = this.message;
    const previousError = this.error;
    this.clearTimeout();
    const context = this.context;
    const bridge = this.proxyBridge;
    const owner = this.owner;
    const profileDir = this.profileDir;
    this.context = null;
    this.page = null;
    this.proxyBridge = null;
    this.owner = '';
    this.profileDir = '';
    try {
      if (context) {
        await withTimeout(Promise.resolve().then(() => context.close()), 15000, '关闭微软 VNC 登录窗口超时').catch(() => {});
      }
    } finally {
      await bridge?.close().catch(() => {});
      if (owner) {
        firefoxSlotLock.release(owner);
        browserSlotLock.release(owner);
        accountContextLock.release(owner);
      }
      if (profileDir) {
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
      this.phase = preserveError && previousPhase === 'opening' ? 'error' : 'closed';
      this.message = reason || previousMessage || '登录窗口已关闭';
      this.error = preserveError ? (this.error || previousError) : '';
      this.accountId = '';
      this.draftId = '';
      this.name = '';
      this.order = 0;
      this.proxy = null;
      this.detectedName = '';
      this.cookieReady = false;
      this.tokenReady = false;
      this.startedAt = 0;
      this.expiresAt = 0;
      this.capturing = false;
    }
    return { closed: true, message: this.message };
  }
}

export const microsoftLoginWindow = new MicrosoftLoginWindowManager();
export default microsoftLoginWindow;

