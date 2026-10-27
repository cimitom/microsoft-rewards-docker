import fs from 'fs';

/**
 * Chromium 启动参数与运行环境的唯一入口。
 *
 * 软件渲染模式保持 v1.9.x 的行为：LIBGL_ALWAYS_SOFTWARE=1 + --disable-gpu，
 * 这样在没有 /dev/dri 的 NAS 上仍然可以用 Mesa/SwiftShader 提供 WebGL。
 *
 * 核显模式只负责让 Chromium 真正走硬件渲染；WebGL 型号伪装仍在指纹层完成，
 * 不能让 Linux/Mesa 的真实驱动字符串直接暴露给声称 Windows 的页面。
 */

export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i;

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check'
];

export const GPU_BACKENDS = ['gl', 'vulkan', 'egl'];

const GPU_BACKEND_ARGS = {
  gl: ['--use-gl=angle', '--use-angle=gl'],
  vulkan: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan'],
  egl: ['--use-gl=egl']
};

export function normalizeGpuBackend(value) {
  const backend = String(value || '').toLowerCase();
  return GPU_BACKENDS.includes(backend) ? backend : 'gl';
}

export function buildChromiumArgs({ useGpu = false, gpuBackend = 'gl', visible = false, extraArgs = [] } = {}) {
  const args = [...BASE_ARGS];
  if (useGpu) {
    args.push(
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--disable-software-rasterizer',
      ...(GPU_BACKEND_ARGS[normalizeGpuBackend(gpuBackend)] || GPU_BACKEND_ARGS.gl)
    );
  } else {
    args.push('--disable-gpu');
  }
  if (visible) {
    args.push('--disable-quic', '--window-size=1366,768', '--window-position=0,0');
  }
  return [...args, ...extraArgs.filter(Boolean)];
}

export function buildChromiumEnv({ useGpu = false, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  if (useGpu) {
    delete env.LIBGL_ALWAYS_SOFTWARE;
  } else {
    env.LIBGL_ALWAYS_SOFTWARE = '1';
  }
  return env;
}

export function listDriDevices(dir = '/dev/dri') {
  try {
    return fs.readdirSync(dir)
      .filter(name => /^(card|renderD)\d+$/.test(name))
      .sort()
      .map(name => `${dir}/${name}`);
  } catch {
    return [];
  }
}

export function inspectDriEnvironment(dir = '/dev/dri') {
  const devices = listDriDevices(dir);
  const renderNodes = devices.filter(item => /\/renderD\d+$/.test(item));
  return {
    dir,
    available: devices.length > 0,
    devices,
    renderNodes,
    hasRenderNode: renderNodes.length > 0
  };
}

export function classifyWebglRenderer(vendor = '', renderer = '') {
  const text = `${vendor} ${renderer}`.trim();
  if (!text) return { software: false, label: 'unknown', text: '' };
  if (SOFTWARE_RENDERER_RE.test(text)) {
    return { software: true, label: 'software', text };
  }
  return { software: false, label: 'hardware', text };
}

