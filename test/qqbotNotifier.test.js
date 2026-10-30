import test from 'node:test';
import assert from 'node:assert/strict';
import notifier, { Notifier } from '../src/core/notifier.js';
import networkClient from '../src/network.js';

test('QQ 机器人参数校验：缺少 AppID 或 AppSecret 时报错', async () => {
  await assert.rejects(
    notifier.sendQqBot({ appId: '', clientSecret: '', openId: 'abc' }, '标题', '正文'),
    /QQ 机器人 AppID 与 AppSecret 不能为空/
  );
});

test('QQ 机器人参数校验：缺少 OpenID 与群 OpenID 时报错', async () => {
  await assert.rejects(
    notifier.sendQqBot({ appId: '102030', clientSecret: 'sec', openId: '', groupOpenId: '' }, '标题', '正文'),
    /QQ 机器人 OpenID 与群 OpenID 均为空/
  );
});

test('QQ 机器人消息推送：成功获取 Token 并向 C2C 私聊与群聊发送消息，且正确复用 Token 缓存', async () => {
  const testNotifier = new Notifier();
  const origRequest = networkClient.request;
  const requests = [];

  networkClient.request = async (options) => {
    requests.push(options);
    if (options.url === 'https://bots.qq.com/app/getAppAccessToken') {
      return { access_token: 'test_token_123', expires_in: '7200' };
    }
    if (options.url.startsWith('https://api.sgroup.qq.com/v2/')) {
      return { id: 'msg_001', timestamp: Date.now() };
    }
    throw new Error(`未知请求: ${options.url}`);
  };

  try {
    // 1. 同时向私聊与群聊发送
    const ok = await testNotifier.sendQqBot({
      appId: 'bot_app_1',
      clientSecret: 'bot_secret_1',
      openId: 'user_openid_1',
      groupOpenId: 'group_openid_1'
    }, '任务完成', '今日已打满 162 分');

    assert.equal(ok, true);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, 'https://bots.qq.com/app/getAppAccessToken');
    assert.deepEqual(requests[0].data, { appId: 'bot_app_1', clientSecret: 'bot_secret_1' });

    assert.equal(requests[1].url, 'https://api.sgroup.qq.com/v2/users/user_openid_1/messages');
    assert.equal(requests[1].headers.Authorization, 'QQBot test_token_123');
    assert.equal(requests[1].data.msg_type, 0);
    assert.equal(requests[1].data.content, '今日已打满 162 分');

    assert.equal(requests[2].url, 'https://api.sgroup.qq.com/v2/groups/group_openid_1/messages');
    assert.equal(requests[2].headers.Authorization, 'QQBot test_token_123');
    assert.equal(requests[2].data.msg_type, 0);

    // 2. 紧接着发送第二条消息：验证 Token 缓存生效，不再调用 getAppAccessToken
    await testNotifier.sendQqBot({
      appId: 'bot_app_1',
      clientSecret: 'bot_secret_1',
      openId: 'user_openid_1'
    }, '第二条', '测试复用 Token');

    assert.equal(requests.length, 4, '应当复用已缓存的 Token，不再发 getAppAccessToken 请求');
    assert.equal(requests[3].url, 'https://api.sgroup.qq.com/v2/users/user_openid_1/messages');
    assert.equal(requests[3].headers.Authorization, 'QQBot test_token_123');
  } finally {
    networkClient.request = origRequest;
  }
});

test('testChannel 支持 qqbot 测试调用', async () => {
  const testNotifier = new Notifier();
  const origRequest = networkClient.request;
  let called = false;

  networkClient.request = async (options) => {
    if (options.url === 'https://bots.qq.com/app/getAppAccessToken') {
      return { access_token: 'tok_test', expires_in: 7200 };
    }
    if (options.url.includes('/users/my_user/messages')) {
      called = true;
      return { id: 'm1' };
    }
    return {};
  };

  try {
    await testNotifier.testChannel('qqbot', JSON.stringify({
      appId: 'app1',
      clientSecret: 'sec1',
      openId: 'my_user'
    }));
    assert.equal(called, true);
  } finally {
    networkClient.request = origRequest;
  }
});
