import { EventEmitter } from 'events';

class Logger extends EventEmitter {
  constructor(maxLogs = 500, maxTimeline = 30) {
    super();
    this.maxLogs = maxLogs;
    this.maxTimeline = maxTimeline;
    this.logs = [];
    this.timeline = [];
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

    console.log(`[${entry.fullTime}] ${entry.icon} ${entry.tag ? `[${entry.tag}] ` : ''}${entry.message}`);

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
