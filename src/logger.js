import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './fsUtil.js';

const LOG_FILE = path.join(DATA_DIR, 'app.log');

class Logger extends EventEmitter {
  constructor(maxLogs = 500, maxTimeline = 30) {
    super();
    this.maxLogs = maxLogs;
    this.maxTimeline = maxTimeline;
    this.logs = [];
    this.timeline = [];
    // 当前正在操作的账号名：让未显式传账号名的日志也能被正确归属
    this.accountContext = '';
    this.ensureLogFile();
  }

  setAccountContext(name) {
    this.accountContext = name || '';
  }

  getAccountContext() {
    return this.accountContext;
  }

  /**
   * 在指定账号上下文内执行一段逻辑，结束后自动还原（避免上下文串台）
   */
  async withAccount(name, fn) {
    const prev = this.accountContext;
    if (name) this.accountContext = name;
    try {
      return await fn();
    } finally {
      this.accountContext = prev;
    }
  }

  ensureLogFile() {
    try {
      const dataDir = path.dirname(LOG_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } catch {}
  }

  getTimeStr() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour12: false });
  }

  getFullTimeStr() {
    const now = new Date();
    return now.toLocaleString('zh-CN', { hour12: false });
  }

  log(icon, msg, tag = '', accountName = '') {
    const acc = accountName || this.accountContext || '';
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      timestamp: Date.now(),
      time: this.getTimeStr(),
      fullTime: this.getFullTimeStr(),
      icon: icon || 'ℹ️',
      tag: tag || '',
      accountName: acc,
      message: String(msg)
    };

    const accPrefix = acc ? `[${acc}] ` : (tag ? `[${tag}] ` : '');
    const line = `[${entry.fullTime}] ${entry.icon} ${accPrefix}${entry.message}\n`;
    console.log(line.trimEnd());

    // 持久化追加写入 data/app.log
    try {
      this.ensureLogFile();
      fs.appendFileSync(LOG_FILE, line, 'utf-8');
    } catch {}

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    this.emit('log', entry);
    return entry;
  }

  addTimeline(tag, text, accountName = '') {
    const item = {
      time: this.getTimeStr(),
      fullTime: this.getFullTimeStr(),
      tag,
      accountName: accountName || this.accountContext || tag || '',
      text
    };
    this.timeline.unshift(item);
    if (this.timeline.length > this.maxTimeline) {
      this.timeline.pop();
    }
    this.emit('timeline', item);
  }

  getLogs() {
    return this.logs;
  }

  getTimeline() {
    return this.timeline;
  }

  clearLogs() {
    this.logs = [];
    this.emit('clear');
  }
}

export const logger = new Logger();
export default logger;
