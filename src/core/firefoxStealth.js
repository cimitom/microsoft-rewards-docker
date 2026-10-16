/**
 * Playwright Firefox 的轻量 stealth 注入。
 *
 * Patchright 只修补 Chromium，Firefox 不受其保护。这里沿用
 * vogler/free-games-claimer 的做法，直接复用 puppeteer-extra-plugin-stealth
 * 的 evasions，在 Firefox persistent context 创建后逐条 addInitScript。
 */
const EVASIONS = [
  'chrome.app',
  'chrome.csi',
  'chrome.loadTimes',
  'chrome.runtime',
  'defaultArgs',
  'iframe.contentWindow',
  'media.codecs',
  'navigator.hardwareConcurrency',
  'navigator.languages',
  'navigator.permissions',
  'navigator.plugins',
  'navigator.webdriver',
  'sourceurl',
  'webgl.vendor',
  'window.outerdimensions'
];

export async function applyFirefoxStealth(context) {
  if (!context?.addInitScript) return;
  const callbacks = [];
  const collector = {
    callbacks,
    async evaluateOnNewDocument(callback, args) {
      callbacks.push({ callback, args });
    }
  };

  for (const name of EVASIONS) {
    try {
      const mod = await import(`puppeteer-extra-plugin-stealth/evasions/${name}/index.js`);
      mod.default().onPageCreated(collector);
    } catch {}
  }

  for (const item of callbacks) {
    try {
      await context.addInitScript(item.callback, item.args);
    } catch {}
  }
}
