import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';

export const AUTH_CONFIG = {
  clientId: '0000000040170455',
  scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  authorizeUrl: 'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
  tokenUrl: 'https://login.live.com/oauth20_token.srf'
};

export class AuthManager {
  constructor() {
    this.accessToken = null;
    this.initFromConfig();
  }

  initFromConfig() {
    const cfg = configManager.get();
    if (cfg.account?.accessToken) {
      this.accessToken = cfg.account.accessToken;
    }
  }

  getAccessToken() {
    return this.accessToken;
  }

  /**
   * 从粘贴的 URL 或 code 字符串中提取 code
   */
  extractCode(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (trimmed.includes('code=')) {
      try {
        const u = new URL(trimmed);
        return u.searchParams.get('code');
      } catch {
        const m = trimmed.match(/[?&]code=([^&#]+)/);
        return m ? decodeURIComponent(m[1]) : null;
      }
    }
    return trimmed;
  }

  /**
   * 通过授权码换取 Token
   */
  async exchangeCodeForToken(codeOrUrl) {
    const code = this.extractCode(codeOrUrl);
    if (!code) {
      throw new Error('无效的授权码或链接，未找到 code 参数');
    }

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      code: code,
      redirect_uri: AUTH_CONFIG.redirectUri,
      grant_type: 'authorization_code'
    });

    try {
      logger.log('🔑', '正在使用授权码换取访问令牌 (Token)...');
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        throw new Error(`${data.error}: ${data.error_description || ''}`);
      }

      if (data.access_token && data.refresh_token) {
        this.accessToken = data.access_token;
        configManager.update({
          account: {
            authCodeUrl: codeOrUrl,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenTime: Date.now()
          }
        });
        logger.log('🟢', '移动端 OAuth Token 换取成功并已持久化保存！');
        return {
          success: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token
        };
      }
      throw new Error('响应中未找到 access_token 或 refresh_token');
    } catch (e) {
      logger.log('🔴', `换取 Token 失败: ${e.message}`);
      throw e;
    }
  }

  /**
   * 使用 Refresh Token 刷新 Access Token
   */
  async refreshToken(force = false) {
    const cfg = configManager.get();
    let refreshToken = cfg.account?.refreshToken;
    const tokenTime = cfg.account?.tokenTime || 0;

    // 检查有效期，如果刚刷过且没有强制要求，且已经有 accessToken，则直接复用
    const diffHours = (Date.now() - tokenTime) / (1000 * 60 * 60);
    if (!force && this.accessToken && diffHours < 12) {
      return true;
    }

    if (!refreshToken) {
      logger.log('🟡', '未配置 Refresh Token，跳过 Token 刷新');
      return false;
    }

    const params = new URLSearchParams({
      client_id: AUTH_CONFIG.clientId,
      refresh_token: refreshToken,
      scope: AUTH_CONFIG.scope,
      grant_type: 'REFRESH_TOKEN'
    });

    try {
      logger.log('🔄', '正在自动续期刷新 OAuth Token...');
      const res = await networkClient.request({
        url: AUTH_CONFIG.tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: params.toString()
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data.error) {
        logger.log('🔴', `刷新 Token 失败: ${data.error} - ${data.error_description || ''}`);
        if (['invalid_grant', 'invalid_request'].includes(data.error)) {
          configManager.update({
            account: { accessToken: '', refreshToken: '', tokenTime: 0 }
          });
          this.accessToken = null;
        }
        return false;
      }

      if (data.access_token && data.refresh_token) {
        this.accessToken = data.access_token;
        configManager.update({
          account: {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            tokenTime: Date.now()
          }
        });
        logger.log('🟢', 'OAuth Token 续期刷新成功！');
        return true;
      }
      return false;
    } catch (e) {
      logger.log('🔴', `刷新 Token 请求异常: ${e.message}`);
      return false;
    }
  }

  /**
   * 验证网页端 Cookie 是否有效
   */
  async checkCookieStatus() {
    const cfg = configManager.get();
    if (!cfg.account?.cookie) {
      return { valid: false, message: '未配置 Cookie' };
    }

    try {
      const res = await networkClient.request({
        url: `https://rewards.bing.com/api/getuserinfo?type=1&X-Requested-With=XMLHttpRequest&_=${Date.now()}`,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
          'referer': 'https://rewards.bing.com/',
          'x-requested-with': 'XMLHttpRequest'
        }
      });

      const text = typeof res === 'string' ? res : JSON.stringify(res);
      if (text.includes('"availablePoints"') || text.includes('"userStatus"')) {
        const data = typeof res === 'string' ? JSON.parse(res) : res;
        const balance = data.dashboard?.userStatus?.availablePoints || data.dashboard?.availablePoints || 0;
        return {
          valid: true,
          balance,
          message: `Cookie 有效，当前积分: ${balance}`
        };
      }

      // 备用检测：请求 earn 页面
      const earnHtml = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
        }
      });
      if (typeof earnHtml === 'string' && (earnHtml.includes('pointsCounters') || earnHtml.includes('activityCards'))) {
        return { valid: true, message: 'Cookie 有效' };
      }

      return { valid: false, message: 'Cookie 貌似已失效或未登录' };
    } catch (e) {
      return { valid: false, message: `Cookie 校验失败: ${e.message}` };
    }
  }

  /**
   * 一键完整测试账户连接
   */
  async testAccount() {
    const cookieStatus = await this.checkCookieStatus();
    let tokenStatus = { valid: false, message: '未获取到 Token' };

    const tokenOk = await this.refreshToken();
    if (tokenOk && this.accessToken) {
      tokenStatus = { valid: true, message: 'Token 有效可用' };
    }

    return {
      cookie: cookieStatus,
      token: tokenStatus,
      overallValid: cookieStatus.valid || tokenStatus.valid
    };
  }
}

export const authManager = new AuthManager();
export default authManager;
