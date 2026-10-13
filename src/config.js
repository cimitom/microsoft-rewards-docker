import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CONFIG = {
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
    searchApi: 'offline', // 'offline' | 'hot.baiwumm.com' | 'hot.cnxiaobai.com' | 'hot.nntool.cc'
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
    bark: ''
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

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        this.config = this.mergeDeep(structuredClone(DEFAULT_CONFIG), parsed);
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

  save() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf-8');
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

  update(partial) {
    if (!this.config) {
      this.load();
    }
    this.config = this.mergeDeep(this.config, partial);
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
