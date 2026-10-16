import fs from 'fs';
import path from 'path';

/**
 * Playwright Firefox 的最小化指纹对齐。
 *
 * 背景（v1.7.2 实测确认）：这里以前复用 puppeteer-extra-plugin-stealth 的
 * evasions 列表，但那是一套 **Chromium 专用** 补丁。在 Firefox 上它没有隐藏
 * 自动化特征，反而制造出一堆自相矛盾的信号：
 *
 *   信号                 真实 Firefox 157     旧 stealth 注入后
 *   navigator.platform   MacIntel            MacIntel（但 UA 声称 Windows）
 *   navigator.oscpu      Intel Mac OS X      Intel Mac OS X（同上矛盾）
 *   navigator.plugins    []                  Chrome PDF Plugin 等 3 个
 *   window.chrome        undefined           object(app,csi,loadTimes,runtime)
 *   WebGL                Apple M1            NO WEBGL CONTEXT
 *
 * Firefox 不存在 Chrome PDF 插件，也没有 window.chrome。凭空补出这两样，
 * 比「不做任何伪装」更容易被 FingerprintJS / hCaptcha 判为机器人——
 * Epic 登录页正是用这套风控，因此登录 POST 会直接返回「错误回复」。
 *
 * 所以这里只保留唯一一个 Firefox 确实需要的修补：
 * Playwright 驱动的 Firefox 会把 navigator.webdriver 置为 true，
 * 而真实用户浏览器该值为 false。其余一律保留浏览器原生值。
 */

/**
 * 真实 Firefox 的 navigator.webdriver 是 false，而 Playwright 驱动的实例是 true。
 * 注意是「置为 false」而不是删除属性：真实 Firefox 上该属性存在且为 false，
 * 删掉它反而多出一个 `'webdriver' in navigator === false` 的特征。
 */
export function webdriverInitScript() {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true,
      enumerable: true
    });
  } catch {}
}

export async function applyFirefoxStealth(context) {
  if (!context?.addInitScript) return;
  await context.addInitScript(webdriverInitScript).catch(() => {});
}

/**
 * 从 Playwright 自带的 Firefox 安装目录里读真实版本号。
 *
 * 这里刻意不硬编码版本：旧代码写死 `rv:127.0`，而镜像里实际是 Firefox 157，
 * 于是 UA 与 navigator.appVersion / oscpu / 实际 JS 能力全都对不上。
 * application.ini 是 Firefox 自己的元数据文件，随浏览器一起升级，不会漂移。
 */
export function detectFirefoxVersion(executablePath) {
  if (!executablePath) return null;
  const dir = path.dirname(executablePath);
  const candidates = [
    path.join(dir, 'application.ini'),                          // Linux / Windows
    path.join(dir, '..', 'Resources', 'application.ini')        // macOS .app 包
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf-8');
      const m = text.match(/^Version=(.+)$/m);
      if (m) return m[1].trim();
    } catch {}
  }
  return null;
}

/**
 * 按真实浏览器身份拼 UA，而不是伪装成别的系统。
 *
 * Firefox 没有 Chromium 那种 CDP `Emulation.setUserAgentOverride`：
 * Playwright 的 `userAgent` 选项只改 UA 字符串，navigator.platform / oscpu /
 * appVersion 仍然暴露真实系统。声称 Windows 会立刻被 FingerprintJS 抓到矛盾，
 * 所以这里只如实描述当前系统。
 */
export function buildFirefoxUserAgent(version, platform = process.platform) {
  if (!version) return null;
  const v = String(version).trim();
  const token = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : (platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64');
  return `Mozilla/5.0 (${token}; rv:${v}) Gecko/20100101 Firefox/${v}`;
}
