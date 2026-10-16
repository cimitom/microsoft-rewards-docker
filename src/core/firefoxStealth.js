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
 *
 * 另外必须把 getter 的 toString 也伪装成 native：否则风控只要一句
 * `Function.prototype.toString.call(descriptor.get)` 就会看到 `() => false`，
 * 而真实 Firefox 返回的是 `function webdriver() { [native code] }`。
 */
export function webdriverInitScript() {
  try {
    const fakeGet = function webdriver() { return false; };

    // 只针对我们这一处补丁伪造 native 外观，其余函数原样透传，
    // 尽量不干扰页面自身对 Function.prototype.toString 的使用。
    const nativeToString = Function.prototype.toString;
    const patchedToString = function toString() {
      if (this === fakeGet) return 'function webdriver() {\n    [native code]\n}';
      return nativeToString.call(this);
    };
    patchedToString.toString = () => nativeToString.call(nativeToString);
    Object.defineProperty(Function.prototype, 'toString', {
      value: patchedToString,
      writable: true,
      configurable: true,
      enumerable: false
    });

    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: fakeGet,
      configurable: true,
      enumerable: true
    });
  } catch {}
}

/**
 * 容器里没有 GPU，WebGL 只能走 Mesa llvmpipe（软件渲染）。
 * 「软件渲染」本身就是虚拟机 / 无头环境的典型特征，风控会据此扣分，
 * 所以这里把 UNMASKED_VENDOR / UNMASKED_RENDERER 换成常见的 Intel 核显标识。
 *
 * 与 browser.js 给 Chromium 的处理保持一致：同样处理 toString，
 * 避免 getParameter 的源码暴露这是一段补丁。
 */
export function webglInitScript() {
  const VENDOR = 'Intel Inc.';
  const RENDERER = 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)';
  const SOFTWARE_RE = /llvmpipe|swiftshader|softpipe|software|mesa offscreen/i;
  try {
    const patch = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      let spoof = null; // null = 还没判定，true = 需要伪装，false = 真显卡，保持原样
      proto.getParameter = function (p) {
        if (p === 37445 || p === 37446) {
          if (spoof === null) {
            // 厂商与渲染器一次性判定，避免出现「厂商是 Mesa、渲染器是 Intel」这种新的矛盾
            const realVendor = String(orig.call(this, 37445) || '');
            const realRenderer = String(orig.call(this, 37446) || '');
            spoof = SOFTWARE_RE.test(`${realVendor} ${realRenderer}`);
          }
          // 只有软件渲染才替换；真机 GPU 保持真实值，不为伪装引入新矛盾
          if (spoof) return p === 37445 ? VENDOR : RENDERER;
        }
        return orig.call(this, p);
      };
      proto.getParameter.toString = () => orig.toString();
    };
    patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
  } catch {}
}

export async function applyFirefoxStealth(context) {
  if (!context?.addInitScript) return;
  await context.addInitScript(webdriverInitScript).catch(() => {});
  await context.addInitScript(webglInitScript).catch(() => {});
}

/**
 * 把采集到的指纹信号翻译成人能看懂的告警。
 *
 * 抽成纯函数是为了能单测：这些都是「同一份指纹里前后矛盾」的判据，
 * 也正是 v1.7.2 之前把 Epic 登录搞挂的那类问题。
 */
export function evaluateFirefoxFingerprint(signals = {}) {
  const warnings = [];
  const ua = String(signals.userAgent || '');
  const platform = String(signals.platform || '');
  const gl = `${signals.webglVendor || ''} ${signals.webglRenderer || ''}`.trim();

  if (signals.webdriver !== false) {
    warnings.push('navigator.webdriver 不是 false —— 会被直接判定为自动化浏览器');
  }
  if (signals.hasWindowChrome) {
    warnings.push('window.chrome 存在 —— Firefox 原生没有这个对象，属于 Chromium 补丁残留');
  }
  if (Number(signals.pluginsCount) > 0) {
    warnings.push(`navigator.plugins 有 ${signals.pluginsCount} 项 —— Firefox 不应有插件列表`);
  }
  if (ua && !/Firefox\//.test(ua)) {
    warnings.push('UA 里没有 Firefox 标识');
  }
  if (/Windows NT/.test(ua) && !/Win/.test(platform)) {
    warnings.push('UA 声称 Windows，但 navigator.platform 不是 Win —— 身份自相矛盾');
  }
  if (/Macintosh/.test(ua) && !/Mac/.test(platform)) {
    warnings.push('UA 声称 macOS，但 navigator.platform 不是 Mac —— 身份自相矛盾');
  }
  if (/(X11|Linux)/.test(ua) && !/Linux/.test(platform)) {
    warnings.push('UA 声称 Linux，但 navigator.platform 不是 Linux —— 身份自相矛盾');
  }
  if (/llvmpipe|swiftshader|softpipe|software/i.test(gl)) {
    warnings.push('WebGL 暴露软件渲染（llvmpipe / SwiftShader）—— 典型的无头或虚拟机特征');
  }
  if (!signals.webglRenderer) {
    warnings.push('WebGL 不可用 —— 风控会当成异常浏览器');
  }
  if (!Array.isArray(signals.languages) || signals.languages.length === 0) {
    warnings.push('navigator.languages 为空 —— 真实浏览器一定带语言列表');
  }
  return warnings;
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
