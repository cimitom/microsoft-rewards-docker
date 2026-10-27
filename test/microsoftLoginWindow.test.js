import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractOAuthCode,
  serializeBingCookies
} from '../src/core/microsoftLoginWindow.js';

test('OAuth 跳转链接可提取 code', () => {
  assert.equal(
    extractOAuthCode('https://login.live.com/oauth20_desktop.srf?code=M.C508_ABC&state=x'),
    'M.C508_ABC'
  );
  assert.equal(extractOAuthCode('https://login.live.com/oauth20_desktop.srf?error=access_denied'), '');
});

test('Cookie 序列化只保留 Bing Cookie 并优先使用 Rewards 域名', () => {
  const cookie = serializeBingCookies([
    { name: '_U', value: 'old', domain: '.bing.com' },
    { name: '_U', value: 'new', domain: 'rewards.bing.com' },
    { name: 'MUID', value: 'm1', domain: '.bing.com' },
    { name: 'MSA', value: 'live', domain: '.live.com' },
    { name: '_EDGE_S', value: 'edge', domain: '.bing.com' }
  ]);
  assert.match(cookie, /_U=new/);
  assert.doesNotMatch(cookie, /_U=old/);
  assert.match(cookie, /MUID=m1/);
  assert.doesNotMatch(cookie, /MSA=live/);
  assert.doesNotMatch(cookie, /_EDGE_S/);
});

