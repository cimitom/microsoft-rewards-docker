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
   * 验证网页端 Cookie 是否有效并拉取账号详情
   */
  async checkCookieStatus() {
    const cfg = configManager.get();
    if (!cfg.account?.cookie) {
      return { valid: false, message: '尚未配置网页端 Cookie' };
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
        const userStatus = data.dashboard?.userStatus || {};
        const balance = userStatus.availablePoints ?? data.dashboard?.availablePoints ?? 0;
        const level = userStatus.levelInfo?.activeLevelName || userStatus.levelInfo?.activeLevel || 'Level 2';
        const pcSearchArr = userStatus.counters?.pcSearch || [];
        let pcProgress = 0, pcMax = 0;
        for (const item of pcSearchArr) {
          pcProgress += Number(item.pointProgress || 0);
          pcMax += Number(item.pointProgressMax || item.pointMax || 0);
        }

        return {
          valid: true,
          balance: Number(balance),
          level,
          pcSearch: `${pcProgress}/${pcMax || 60}`,
          message: `网页端已登录 | 积分: ${balance} | 等级: ${level} | 搜索配额: ${pcProgress}/${pcMax || 60}`
        };
      }

      // 备用检测：请求 earn 页面
      const earnHtml = await networkClient.request({
        url: 'https://rewards.bing.com/earn',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
        }
      });
      const clean = String(earnHtml).replace(/\\"/g, '"');
      if (clean.includes('pointsCounters') || clean.includes('activityCards')) {
        const balMatch = clean.match(/"totalPoints":(\d+)/) || clean.match(/"balance":(\d+)/) || clean.match(/"availablePoints":(\d+)/);
        const balance = balMatch ? parseInt(balMatch[1], 10) : 0;
        return {
          valid: true,
          balance,
          level: '正常',
          message: `网页端已登录 | 当前积分: ${balance}`
        };
      }

      return { valid: false, message: 'Cookie 已失效或未登录，请重新从浏览器复制粘贴' };
    } catch (e) {
      return { valid: false, message: `网页端请求失败: ${e.message}` };
    }
  }

  /**
   * 实测移动端 OAuth Token 与 DAPI 接口连通性
   */
  async checkTokenStatus() {
    const cfg = configManager.get();
    if (!cfg.account?.refreshToken && !this.accessToken) {
      return { valid: false, message: '尚未完成移动端授权 (未配置 Token)' };
    }

    const tokenOk = await this.refreshToken();
    if (!tokenOk || !this.accessToken) {
      return { valid: false, message: 'Refresh Token 已过期或失效，请重新授权' };
    }

    try {
      const res = await networkClient.request({
        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560',
          'authorization': `Bearer ${this.accessToken}`,
          'x-rewards-appid': 'SAAndroid/32.6.2110003560',
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        }
      });

      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (data?.response) {
        const balance = Number(data.response.balance || 0);
        const promos = data.response.promotions || [];
        const readTask = promos.find(x => x.attributes?.offerid === 'ENUS_readarticle3_30points');
        const readProg = readTask ? `${readTask.attributes.progress || 0}/${readTask.attributes.max || 30}` : '就绪';
        return {
          valid: true,
          balance,
          readProgress: readProg,
          message: `移动端已登录 | 积分: ${balance} | 阅读进度: ${readProg}`
        };
      }
      return { valid: true, message: '移动端 Token 有效' };
    } catch (e) {
      return { valid: false, message: `移动端 DAPI 接口验证失败: ${e.message}` };
    }
  }

  /**
   * 一键全面诊断测试账户在 Docker 中的登录状态
   */
  async testAccount() {
    logger.log('🔍', '开始检测当前微软账号在 Docker 容器中的登录状态...');
    const [cookieStatus, tokenStatus] = await Promise.all([
      this.checkCookieStatus(),
      this.checkTokenStatus()
    ]);

    const balance = cookieStatus.balance || tokenStatus.balance || 0;
    const allValid = cookieStatus.valid && tokenStatus.valid;
    const partialValid = cookieStatus.valid || tokenStatus.valid;

    if (allValid) {
      logger.log('🟢', `账号登录检测完全通过！网页端与移动端均在线，当前总积分: ${balance}`);
    } else if (partialValid) {
      logger.log('🟡', `账号部分登录有效：网页端(${cookieStatus.valid ? '正常' : '未就绪'}) / 移动端(${tokenStatus.valid ? '正常' : '未就绪'})`);
    } else {
      logger.log('🔴', '账号尚未登录或凭证已失效，请打开「新手配置向导」完成绑定');
    }

    return {
      cookie: cookieStatus,
      token: tokenStatus,
      balance,
      allValid,
      overallValid: partialValid
    };
  }
}

export const authManager = new AuthManager();
export default authManager;
