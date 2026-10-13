import configManager from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';

export class Notifier {
  async send(title, content) {
    const cfg = configManager.get();
    const notify = cfg.notify || {};
    const timeStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const fullContent = `【${title}】\n时间: ${timeStr}\n\n${content}`;

    const tasks = [];

    // 1. 企业微信
    if (notify.wework) {
      tasks.push(this.sendWeWork(notify.wework.trim(), fullContent));
    }

    // 2. 钉钉
    if (notify.dingding) {
      tasks.push(this.sendDingTalk(notify.dingding.trim(), title, fullContent));
    }

    // 3. 飞书
    if (notify.feishu) {
      tasks.push(this.sendFeishu(notify.feishu.trim(), title, fullContent));
    }

    // 4. Bark
    if (notify.bark) {
      tasks.push(this.sendBark(notify.bark.trim(), title, content));
    }

    // 5. PushMe
    if (notify.pushme) {
      tasks.push(this.sendPushMe(notify.pushme.trim(), title, content));
    }

    // 6. Telegram
    if (notify.telegram?.botToken && notify.telegram?.chatId) {
      tasks.push(this.sendTelegram(
        notify.telegram.botToken.trim(),
        notify.telegram.chatId.trim(),
        title,
        fullContent
      ));
    }

    if (tasks.length > 0) {
      const results = await Promise.allSettled(tasks);
      return results;
    }
  }

  async sendWeWork(key, text) {
    const url = key.startsWith('http') ? key : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'text',
          text: { content: text }
        }
      });
      logger.log('🔵', '「企业微信」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「企业微信」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendDingTalk(token, title, text) {
    const url = token.startsWith('http') ? token : `https://oapi.dingtalk.com/robot/send?access_token=${token}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msgtype: 'markdown',
          markdown: {
            title: `# ${title}`,
            text: text
          }
        }
      });
      logger.log('🔵', '「钉钉」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「钉钉」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendFeishu(urlOrKey, title, text) {
    const url = urlOrKey.startsWith('http') ? urlOrKey : `https://open.feishu.cn/open-apis/bot/v2/hook/${urlOrKey}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          msg_type: 'interactive',
          card: {
            schema: '2.0',
            header: {
              title: { tag: 'plain_text', content: title },
              template: 'blue'
            },
            body: {
              elements: [{ tag: 'markdown', content: text }]
            }
          }
        }
      });
      logger.log('🔵', '「飞书」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「飞书」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendBark(keyOrUrl, title, text) {
    const base = keyOrUrl.startsWith('http') ? keyOrUrl.replace(/\/$/, '') : `https://api.day.app/${keyOrUrl}`;
    const url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(text)}?group=rewards&icon=https://rewards.bing.com/rewards.png`;
    try {
      await networkClient.request({ url, method: 'GET' });
      logger.log('🔵', '「Bark」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Bark」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendPushMe(key, title, text) {
    const url = `https://push.i-i.me/?push_key=${encodeURIComponent(key)}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          title: `Microsoft Rewards - ${title}`,
          content: text,
          type: 'markdown'
        }
      });
      logger.log('🔵', '「PushMe」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「PushMe」推送失败: ${e.message}`);
      throw e;
    }
  }

  async sendTelegram(botToken, chatId, title, text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const message = `*${title}*\n\n${text}`;
    try {
      await networkClient.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: {
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        }
      });
      logger.log('🔵', '「Telegram」消息推送成功');
      return true;
    } catch (e) {
      logger.log('🔴', `「Telegram」推送失败: ${e.message}`);
      throw e;
    }
  }

  async testChannel(channel, value) {
    const title = '测试通知';
    const content = '如果你看到这条消息，说明该推送渠道已成功配置并联通！';
    switch (channel) {
      case 'wework':
        return this.sendWeWork(value, `【${title}】\n${content}`);
      case 'dingding':
        return this.sendDingTalk(value, title, `### ${title}\n${content}`);
      case 'feishu':
        return this.sendFeishu(value, title, content);
      case 'bark':
        return this.sendBark(value, title, content);
      case 'pushme':
        return this.sendPushMe(value, title, content);
      case 'telegram': {
        const { botToken, chatId } = typeof value === 'object' ? value : JSON.parse(value);
        return this.sendTelegram(botToken, chatId, title, content);
      }
      default:
        throw new Error('不支持的通知渠道');
    }
  }
}

export const notifier = new Notifier();
export default notifier;
