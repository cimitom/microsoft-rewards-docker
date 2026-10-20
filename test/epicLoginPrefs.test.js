import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { EPIC_FIREFOX_PREFS } = await import('../src/core/epic.js');
const ROOT = path.resolve(import.meta.dirname, '..');
const EPIC_SOURCE = fs.readFileSync(path.join(ROOT, 'src/core/epic.js'), 'utf-8');

test('Epic 登录 Firefox 允许 hCaptcha/Talon 所需的跨站 Cookie', () => {
  assert.equal(EPIC_FIREFOX_PREFS['network.cookie.cookieBehavior'], 0);
  assert.equal(EPIC_FIREFOX_PREFS['network.cookie.cookieBehavior.pbmode'], 0);
  assert.equal(EPIC_FIREFOX_PREFS['privacy.trackingprotection.enabled'], false);
});

test('Epic 登录 Firefox 关闭容易在容器网络中拖慢验证码的 HTTP/3 与 IPv6', () => {
  assert.equal(EPIC_FIREFOX_PREFS['network.http.http3.enable'], false);
  assert.equal(EPIC_FIREFOX_PREFS['network.dns.disableIPv6'], true);
  assert.match(EPIC_SOURCE, /firefoxUserPrefs:\s*EPIC_FIREFOX_PREFS/);
});
