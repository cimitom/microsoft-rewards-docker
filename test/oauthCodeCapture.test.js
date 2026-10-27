import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { waitForOAuthCode } from '../src/core/microsoftLoginWindow.js';

function createPageWithRedirectChain(codeUrl) {
  const page = new EventEmitter();
  page.mainFrame = () => ({ name: 'main' });
  page.url = () => 'https://login.live.com/oauth20_authorize.srf';
  page.goto = async () => ({
    url: () => 'https://rewards.bing.com/dashboard',
    headers: () => ({}),
    request: () => ({
      url: () => 'https://rewards.bing.com/dashboard',
      redirectedFrom: () => ({
        url: () => codeUrl,
        redirectedFrom: () => null
      })
    })
  });
  return page;
}

test('OAuth code 在快速重定向链中也能被捕获', async () => {
  const codeUrl = 'https://login.live.com/oauth20_desktop.srf?code=ABC123&state=x';
  const page = createPageWithRedirectChain(codeUrl);
  const context = { pages: () => [] };
  const captured = await waitForOAuthCode(context, page, {
    authorizeUrl: 'https://login.live.com/oauth20_authorize.srf',
    timeoutMs: 1000
  });
  assert.equal(captured, codeUrl);
});

test('OAuth 错误参数会立即返回真实错误', async () => {
  const page = new EventEmitter();
  page.mainFrame = () => ({ name: 'main' });
  page.url = () => 'https://login.live.com/oauth20_desktop.srf?error=access_denied&error_description=denied';
  page.goto = async () => null;
  const context = { pages: () => [] };
  await assert.rejects(
    () => waitForOAuthCode(context, page, {
      authorizeUrl: 'https://login.live.com/oauth20_authorize.srf',
      timeoutMs: 1000
    }),
    /denied/
  );
});

