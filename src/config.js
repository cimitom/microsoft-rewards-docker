import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
  accounts: [
    {
      id: 'acc_1',
      name: '默认账号',
      order: 1,
      enabled: true,
      cookie: '',
      authCodeUrl: '',
      refreshToken: '',
      accessToken: '',
      tokenTime: 0,
      timeSlot: {
        startHour: 6,
        endHour: 10,
        randomDelayMin: 60,
        durationHours: 2
      }
    }
  ],
  account: {
    cookie: '',
    authCodeUrl: '',
    refreshToken: '',
    accessToken: '',
    tokenTime: 0
  },
  network: {
    useProxy: false,
    proxyUrl: '',
    lockRegion: true
  },
  tasks: {
    sign: true,
    read: true,
    search: true,
    promos: true,
    quiz: true,
    desktopApp: true,
    dailySet: true,
    searchSpan: 30,
    searchApi: 'baidu.official', // 'offline' | 'baidu.official' | 'hot.nntool.cc' | 'hot.cnxiaobai.com'
    searchEngineMode: 'browser', // 'browser' (Playwright 真机拟人) | 'http' (轻量HTTP)
    keepRunning: true
  },
  schedule: {
    enabled: true,
    cron: '*/25 * * * *'
  },
  notify: {
    wework: '',
    dingding: '',
    feishu: '',
    pushme: '',
    bark: '',
    telegram: {
      botToken: '',
      chatId: ''
    }
  },
  ui: {
    theme: 'auto'
  },
  server: {
    port: 5308,
    authPassword: ''
  }
};

class ConfigManager {
  constructor() {
    this.config = null;
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  extractUserNameFromCookie(cookie = '') {
    if (!cookie) return '';
    // 尝试从 WLS=C=...&N=%e8%b4%ba%e5%bc%ba 提取用户名
    const wlsMatch = cookie.match(/WLS=[^;]*?N=([^;&]+)/i);
    if (wlsMatch) {
      try {
        return decodeURIComponent(wlsMatch[1]);
      } catch {}
    }
    return '';
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = this.mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
        // 平滑迁移旧版单账号数据到 accounts 列表
        this.migrateLegacyAccount(parsed);
      } else {
        this.config = structuredClone(DEFAULT_CONFIG);
        this.save();
      }
    } catch (e) {
      console.error('[Config] 读取配置文件失败，将使用默认配置:', e.message);
      this.config = structuredClone(DEFAULT_CONFIG);
    }
    return this.config;
  }

  getDefaultTimeSlot(index = 0) {
    const slots = [
      { startHour: 6, endHour: 10 },
      { startHour: 10, endHour: 14 },
      { startHour: 14, endHour: 18 },
      { startHour: 18, endHour: 22 }
    ];
    const s = slots[index % slots.length];
    return {
      startHour: s.startHour,
      endHour: s.endHour,
      randomDelayMin: 60,
      durationHours: 2
    };
  }

  migrateLegacyAccount(parsed) {
    if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
      const legacy = parsed.account || {};
      const extractedName = this.extractUserNameFromCookie(legacy.cookie);
      this.config.accounts = [
        {
          id: 'acc_1',
          name: extractedName ? `主账号 (${extractedName})` : '主账号',
          enabled: true,
          cookie: legacy.cookie || '',
          authCodeUrl: legacy.authCodeUrl || '',
          refreshToken: legacy.refreshToken || '',
          accessToken: legacy.accessToken || '',
          tokenTime: legacy.tokenTime || 0,
          timeSlot: this.getDefaultTimeSlot(0)
        }
      ];
      this.save();
    } else {
      this.config.accounts = parsed.accounts.map((acc, i) => ({
        ...acc,
        timeSlot: acc.timeSlot || this.getDefaultTimeSlot(i)
      }));
    }

    // 同步第一个账号到 config.account 以保持向后兼容
    if (this.config.accounts.length > 0) {
      const first = this.config.accounts[0];
      this.config.account = {
        cookie: first.cookie || '',
        authCodeUrl: first.authCodeUrl || '',
        refreshToken: first.refreshToken || '',
        accessToken: first.accessToken || '',
        tokenTime: first.tokenTime || 0
      };
    }
  }

  save() {
    try {
      this.ensureDataDir();
      // 保持 config.account 与 accounts[0] 同步
      if (Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
        const first = this.config.accounts[0];
        this.config.account = {
          cookie: first.cookie || '',
          authCodeUrl: first.authCodeUrl || '',
          refreshToken: first.refreshToken || '',
          accessToken: first.accessToken || '',
          tokenTime: first.tokenTime || 0
        };
      }
      // 原子写入 + 权限收紧（配置里含明文 Cookie / Refresh Token）
      writeFileAtomic(CONFIG_FILE, JSON.stringify(this.config, null, 2), { encoding: 'utf-8', mode: 0o600 });
      try {
        fs.chmodSync(CONFIG_FILE, 0o600);
      } catch {}
      return true;
    } catch (e) {
      console.error('[Config] 保存配置文件失败:', e.message);
      return false;
    }
  }

  get() {
    if (!this.config) {
      this.load();
    }
    return this.config;
  }

  getAccounts() {
    const cfg = this.get();
    const list = cfg.accounts || [];
    return list.slice().sort((a, b) => {
      const orderA = Number.isFinite(Number(a.order)) ? Number(a.order) : 999;
      const orderB = Number.isFinite(Number(b.order)) ? Number(b.order) : 999;
      return orderA - orderB;
    });
  }

  getAccount(accountId) {
    const accounts = this.getAccounts();
    if (!accountId) return accounts[0] || null;
    return accounts.find(a => a.id === accountId) || accounts[0] || null;
  }

  /**
   * 精确查找账号，找不到返回 null。
   * 注意：getAccount() 在 id 不存在时会回退到第一个账号，写入类操作必须用这个方法，
   * 否则一个不存在的 id 会静默改到第一个账号上（历史 bug：配置向导换 Token 覆盖主账号）。
   */
  findAccount(accountId) {
    if (!accountId) return null;
    return this.getAccounts().find(a => a.id === accountId) || null;
  }

  /**
   * 解析账号：不传 id 时返回第一个账号（兼容单账号调用），
   * 传了 id 则必须精确命中，否则返回 null。
   * 所有「按 id 操作某个账号」的地方都应该用这个，而不是 getAccount()。
   */
  resolveAccount(accountId) {
    if (!accountId) return this.getAccounts()[0] || null;
    return this.findAccount(accountId);
  }

  upsertAccount(accountData) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) cfg.accounts = [];

    const id = accountData.id || `acc_${Date.now()}`;
    const idx = cfg.accounts.findIndex(a => a.id === id);

    // 如果没有填名字但有 cookie，尝试提取名字
    let name = accountData.name;
    if (!name && accountData.cookie) {
      const extracted = this.extractUserNameFromCookie(accountData.cookie);
      name = extracted ? `账号 (${extracted})` : `账号 ${cfg.accounts.length + 1}`;
    }

    if (idx !== -1) {
      const existing = cfg.accounts[idx];
      let timeSlot = accountData.timeSlot || existing.timeSlot || this.getDefaultTimeSlot(idx);
      if (accountData.timeSlot?.startHour !== undefined) {
        const sh = Number(accountData.timeSlot.startHour);
        timeSlot = {
          startHour: sh,
          endHour: (sh + 4) % 24,
          randomDelayMin: Number(accountData.timeSlot.randomDelayMin) || 60,
          durationHours: Number(accountData.timeSlot.durationHours) || 2
        };
      }
      const order = accountData.order !== undefined ? Number(accountData.order) : (existing.order || idx + 1);
      cfg.accounts[idx] = {
        ...existing,
        ...accountData,
        name: name || existing.name,
        order,
        timeSlot
      };
    } else {
      const newIdx = cfg.accounts.length;
      let timeSlot = accountData.timeSlot || this.getDefaultTimeSlot(newIdx);
      if (accountData.timeSlot?.startHour !== undefined) {
        const sh = Number(accountData.timeSlot.startHour);
        timeSlot = {
          startHour: sh,
          endHour: (sh + 4) % 24,
          randomDelayMin: Number(accountData.timeSlot.randomDelayMin) || 60,
          durationHours: Number(accountData.timeSlot.durationHours) || 2
        };
      }
      const order = accountData.order !== undefined ? Number(accountData.order) : (newIdx + 1);
      cfg.accounts.push({
        id,
        name: name || `账号 ${newIdx + 1}`,
        order,
        enabled: accountData.enabled !== false,
        cookie: accountData.cookie || '',
        authCodeUrl: accountData.authCodeUrl || '',
        refreshToken: accountData.refreshToken || '',
        accessToken: accountData.accessToken || '',
        tokenTime: accountData.tokenTime || 0,
        timeSlot
      });
    }

    this.save();
    return this.getAccount(id);
  }

  deleteAccount(accountId) {
    const cfg = this.get();
    if (!Array.isArray(cfg.accounts)) return false;
    if (cfg.accounts.length <= 1) {
      throw new Error('至少需要保留一个账号');
    }
    cfg.accounts = cfg.accounts.filter(a => a.id !== accountId);
    this.save();
    return true;
  }

  update(partial) {
    if (!this.config) {
      this.load();
    }

    // 先深拷贝：mergeDeep 会改写传入对象，直接操作会把 express 的 req.body 也改掉
    const patch = structuredClone(partial || {});

    // 如果更新的是单账号字段 account，同步更新到第一个账号或指定账号
    if (patch.account && Array.isArray(this.config.accounts) && this.config.accounts.length > 0) {
      const targetId = patch.accountId || this.config.accounts[0].id;
      const idx = this.config.accounts.findIndex(a => a.id === targetId);
      if (idx !== -1) {
        Object.assign(this.config.accounts[idx], patch.account);
      }
    }

    if (Array.isArray(patch.accounts)) {
      if (patch.accounts.length === 0) {
        // 保护：前端 currentConfig 未加载完成时会上报空数组，
        // 直接覆盖会把所有账号连同 Cookie/Token 一起清空。
        console.error('[Config] 拒绝空的 accounts 更新，已保留原有账号');
      } else {
        this.config.accounts = patch.accounts;
      }
      delete patch.accounts;
    }

    this.config = this.mergeDeep(this.config, patch);
    this.save();
    return this.config;
  }

  mergeDeep(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      if (source[key] instanceof Object && !Array.isArray(source[key]) && key in target) {
        Object.assign(source[key], this.mergeDeep(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }
}

export const configManager = new ConfigManager();
export default configManager;
