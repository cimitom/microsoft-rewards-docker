import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'data', 'app.log');

class Logger extends EventEmitter {
  constructor(maxLogs = 500, maxTimeline = 30) {
    super();
    this.maxLogs = maxLogs;
    this.maxTimeline = maxTimeline;
    this.logs = [];
    this.timeline = [];
    this.ensureLogFile();
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

  log(icon, msg, tag = '') {
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      timestamp: Date.now(),
      time: this.getTimeStr(),
      fullTime: this.getFullTimeStr(),
      icon: icon || 'ℹ️',
      tag: tag || '',
      message: String(msg)
    };

    const line = `[${entry.fullTime}] ${entry.icon} ${entry.tag ? `[${entry.tag}] ` : ''}${entry.message}\n`;
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

  addTimeline(tag, text) {
    const item = {
      time: this.getTimeStr(),
      fullTime: this.getFullTimeStr(),
      tag,
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
