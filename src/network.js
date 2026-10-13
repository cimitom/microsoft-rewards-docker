import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import configManager from './config.js';

class NetworkClient {
  constructor() {
    this.cookieJar = new Map();
    this.initDefaultCookies();
  }

  initDefaultCookies() {
    const cfg = configManager.get();
    if (cfg.account?.cookie) {
      this.parseAndStoreCookies(cfg.account.cookie, 'rewards.bing.com');
      this.parseAndStoreCookies(cfg.account.cookie, 'bing.com');
    }
  }

  parseAndStoreCookies(cookieStr, domain = 'bing.com') {
    if (!cookieStr || typeof cookieStr !== 'string') return;
    const parts = cookieStr.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        this.setCookie(key, val, domain);
      }
    }
  }

  setCookie(key, value, domain = 'bing.com') {
    if (key === '_EDGE_S') return; // 原脚本明确需清除此 cookie
    this.cookieJar.set(`${domain}:${key}`, value);
    this.cookieJar.set(`*:${key}`, value);
  }

  deleteCookie(key, domain = 'bing.com') {
    this.cookieJar.delete(`${domain}:${key}`);
    this.cookieJar.delete(`*:${key}`);
  }

  getCookieString(targetUrl) {
    let hostname = '';
    try {
      hostname = new URL(targetUrl).hostname;
    } catch {
      hostname = 'bing.com';
    }

    const cfg = configManager.get();
    const cookies = new Map();

    // 先导入用户配置的原始 Cookie
    if (cfg.account?.cookie) {
      const parts = cfg.account.cookie.split(';');
      for (const p of parts) {
        const t = p.trim();
        const eq = t.indexOf('=');
        if (eq > 0) {
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim();
          if (k !== '_EDGE_S') {
            cookies.set(k, v);
          }
        }
      }
    }

    // 再注入运行时动态积累的 Cookie
    for (const [dk, v] of this.cookieJar.entries()) {
      const [dom, k] = dk.split(':');
      if (dom === '*' || hostname.endsWith(dom) || dom.endsWith(hostname)) {
        if (k !== '_EDGE_S') {
          cookies.set(k, v);
        }
      }
    }

    return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  getAgent() {
    const cfg = configManager.get();
    if (!cfg.network?.useProxy || !cfg.network?.proxyUrl) {
      return null;
    }

    const proxyUrl = cfg.network.proxyUrl.trim();
    if (!proxyUrl) return null;

    try {
      if (proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks5h://')) {
        return new SocksProxyAgent(proxyUrl);
      } else {
        return new HttpsProxyAgent(proxyUrl);
      }
    } catch (e) {
      console.error('[Network] 代理配置解析失败:', e.message);
      return null;
    }
  }

  /**
   * 核心网络请求方法，兼容原脚本 Utils.xhr
   */
  async request(options) {
    const {
      url,
      method = 'GET',
      headers = {},
      data,
      timeout = 20000,
      followRedirects = true,
      cookieOverride = null,
      responseType = 'text'
    } = options;

    const agent = this.getAgent();
    const finalHeaders = { ...headers };

    // 自动添加 Cookie
    const cookieHeader = cookieOverride !== null ? cookieOverride : this.getCookieString(url);
    if (cookieHeader && !finalHeaders['cookie'] && !finalHeaders['Cookie']) {
      finalHeaders['cookie'] = cookieHeader;
    }

    const axiosConfig = {
      url,
      method,
      headers: finalHeaders,
      data,
      timeout,
      responseType,
      validateStatus: (status) => {
        if (!followRedirects) {
          return (status >= 200 && status < 400);
        }
        return status >= 200 && status < 300;
      }
    };

    if (agent) {
      axiosConfig.httpAgent = agent;
      axiosConfig.httpsAgent = agent;
    }

    if (!followRedirects) {
      axiosConfig.maxRedirects = 0;
    }

    try {
      const response = await axios(axiosConfig);

      // 处理 Set-Cookie
      if (response.headers['set-cookie']) {
        let domain = 'bing.com';
        try { domain = new URL(url).hostname; } catch {}
        const setCookies = Array.isArray(response.headers['set-cookie'])
          ? response.headers['set-cookie']
          : [response.headers['set-cookie']];
        for (const sc of setCookies) {
          const cookiePart = sc.split(';')[0];
          const eq = cookiePart.indexOf('=');
          if (eq > 0) {
            const k = cookiePart.slice(0, eq).trim();
            const v = cookiePart.slice(eq + 1).trim();
            this.setCookie(k, v, domain);
          }
        }
      }

      // 如果是重定向响应，返回 Location
      if ([301, 302, 307, 308].includes(response.status)) {
        return response.headers.location || true;
      }

      return response.data;
    } catch (error) {
      if (error.response && [301, 302, 307, 308].includes(error.response.status)) {
        return error.response.headers.location || true;
      }
      const status = error.response ? `HTTP ${error.response.status}` : (error.code || error.message);
      throw new Error(`${status}`);
    }
  }

  xhr(options) {
    return this.request(options);
  }
}

export const networkClient = new NetworkClient();
export default networkClient;
