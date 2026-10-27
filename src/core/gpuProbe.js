import { chromium } from 'patchright-core';
import logger from '../logger.js';
import { browserSlotLock } from './contextLock.js';
import { findChromiumExecutable } from './chromiumExecutable.js';
import {
  buildChromiumArgs,
  buildChromiumEnv,
  classifyWebglRenderer,
  inspectDriEnvironment
} from './chromiumRuntime.js';

const GPU_PROBE_TIMEOUT_MS = 30000;

async function readGpuSignals(page) {
  return page.evaluate(() => {
    const result = {
      webgl: false,
      webgl2: false,
      vendor: '',
      renderer: '',
      version: '',
      shadingLanguageVersion: '',
      drawOk: false,
      contextLost: false,
      error: 0
    };
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
      result.webgl2 = !!gl;
      if (!gl) {
        gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
      }
      result.webgl = !!gl;
      if (!gl) return result;

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      result.vendor = debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '')
        : String(gl.getParameter(gl.VENDOR) || '');
      result.renderer = debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '')
        : String(gl.getParameter(gl.RENDERER) || '');
      result.version = String(gl.getParameter(gl.VERSION) || '');
      result.shadingLanguageVersion = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '');

      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }');
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'precision mediump float; void main(){ gl_FragColor=vec4(0.2,0.8,0.4,1.0); }');
      gl.compileShader(fs);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.useProgram(program);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixel = new Uint8Array(4);
      gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      result.drawOk = pixel[1] > 20;
      result.contextLost = gl.isContextLost();
      result.error = gl.getError();
    } catch (error) {
      result.error = -1;
      result.errorMessage = String(error?.message || error);
    }
    return result;
  });
}

async function readSystemInfo(browser) {
  try {
    const session = await browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getInfo');
    return {
      devices: Array.isArray(info?.gpu?.devices)
        ? info.gpu.devices.map(device => ({
          vendorId: device.vendorId,
          deviceId: device.deviceId,
          vendorName: device.vendorName,
          deviceName: device.deviceName,
          driverVendor: device.driverVendor,
          driverVersion: device.driverVersion,
          active: device.active
        }))
        : [],
      auxAttributes: info?.gpu?.auxAttributes || {}
    };
  } catch {
    return null;
  }
}

/**
 * 用未注入 WebGL 伪装的临时 Chromium 检查核显是否真的可用。
 * 检测必须绕过指纹伪装，否则 SwiftShader 也会被报告成 UHD 630。
 */
export async function checkGpuCapability() {
  const dri = inspectDriEnvironment();
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    return {
      success: false,
      dri,
      message: '未检测到 Chromium/Edge 可执行文件',
      checkedAt: Date.now()
    };
  }
  if (!dri.available) {
    return {
      success: false,
      dri,
      message: '容器内未发现 /dev/dri，请先在极空间/Docker 中映射核显设备',
      checkedAt: Date.now()
    };
  }

  const owner = `gpu-probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  if (!browserSlotLock.tryAcquire(owner)) {
    return {
      success: false,
      busy: true,
      dri,
      message: '浏览器正在执行任务，请稍后再检测核显',
      checkedAt: Date.now()
    };
  }

  const startedAt = Date.now();
  let browser = null;
  try {
    logger.log('🖥️', '开始检测核显与 Chromium 硬件渲染能力...');
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: buildChromiumArgs({ useGpu: true }),
      env: buildChromiumEnv({ useGpu: true })
    });
    const page = await browser.newPage();
    await page.goto('about:blank', { timeout: 10000 }).catch(() => {});
    const signals = await readGpuSignals(page);
    const systemInfo = await readSystemInfo(browser);
    const kind = classifyWebglRenderer(signals.vendor, signals.renderer);
    const hardware = signals.webgl && !kind.software && signals.drawOk && !signals.contextLost;
    const activeDevices = systemInfo?.devices?.filter(device => device.active) || [];
    const durationMs = Date.now() - startedAt;

    const result = {
      success: hardware,
      software: kind.software,
      renderer: signals.renderer,
      vendor: signals.vendor,
      webgl: signals.webgl,
      webgl2: signals.webgl2,
      drawOk: signals.drawOk,
      contextLost: signals.contextLost,
      glError: signals.error,
      version: signals.version,
      shadingLanguageVersion: signals.shadingLanguageVersion,
      systemInfo,
      activeDevices,
      dri,
      durationMs,
      message: hardware
        ? `核显工作正常：${signals.renderer || '未知渲染器'}`
        : (kind.software
          ? `检测到软件渲染：${signals.renderer || '未知渲染器'}`
          : '核显 WebGL 初始化失败，请检查 /dev/dri 权限与极空间 GPU 设置'),
      checkedAt: Date.now()
    };
    logger.log(result.success ? '🟢' : '🟡', result.message);
    return result;
  } catch (error) {
    const message = String(error?.message || error).split('\n')[0];
    logger.log('🔴', `核显检测失败: ${message}`);
    return {
      success: false,
      dri,
      error: message,
      durationMs: Date.now() - startedAt,
      message: `核显检测失败: ${message}`,
      checkedAt: Date.now()
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    browserSlotLock.release(owner);
  }
}

