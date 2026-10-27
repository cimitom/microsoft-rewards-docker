import fs from 'fs';
import { spawn } from 'child_process';
import configManager from '../config.js';
import logger from '../logger.js';

const VNC_PID_FILE = '/tmp/ms-rewards-x11vnc.pid';
const MAX_VNC_PASSWORD_LENGTH = 8;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processAlive(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(VNC_PID_FILE, 'utf-8').trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * x11vnc/VNC 协议只使用密码的前 8 个字符。这里提前拒绝超长密码，
 * 避免界面显示 10 位但实际只能输入前 8 位造成“密码正确却连不上”。
 */
export function normalizeVncPassword(value = '') {
  const password = String(value ?? '').trim();
  if (password.length > MAX_VNC_PASSWORD_LENGTH) {
    throw new Error(`VNC 密码最多 ${MAX_VNC_PASSWORD_LENGTH} 位`);
  }
  return password;
}

export function resolveVncPassword(config = configManager.get()) {
  return normalizeVncPassword(config?.server?.vncPassword || process.env.NOVNC_PASSWORD || '');
}

export function isVncServerEnabled() {
  return process.env.VNC_ENABLED === '1' || process.env.EPIC_VISIBLE === '1';
}

async function stopExistingVnc() {
  const pid = readPid();
  if (!processAlive(pid)) {
    try {
      fs.rmSync(VNC_PID_FILE, { force: true });
    } catch {}
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 20 && processAlive(pid); i++) {
    await delay(100);
  }
  if (processAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    await delay(100);
  }
  try {
    fs.rmSync(VNC_PID_FILE, { force: true });
  } catch {}
}

/**
 * 保存配置后热重启 x11vnc，使新的 VNC 密码立即生效。
 * Xvfb 和 websockify 保持不变，现有 noVNC 页面会自动重连。
 */
export async function restartVncServer(password = resolveVncPassword()) {
  if (!isVncServerEnabled()) {
    return { restarted: false, skipped: true, message: '当前未启用 VNC' };
  }

  const normalized = normalizeVncPassword(password);
  await stopExistingVnc();

  const args = [
    '-display', process.env.DISPLAY || ':1',
    '-forever',
    '-shared',
    '-rfbport', String(process.env.VNC_PORT || 5900),
    ...(normalized ? ['-passwd', normalized] : ['-nopw'])
  ];

  let spawnError = '';
  const child = spawn('x11vnc', args, {
    detached: true,
    stdio: 'ignore'
  });
  child.on('error', error => {
    spawnError = String(error?.message || error);
  });
  child.unref();

  await delay(450);
  if (spawnError || !processAlive(child.pid)) {
    throw new Error(spawnError || 'x11vnc 启动失败');
  }
  fs.writeFileSync(VNC_PID_FILE, String(child.pid), { encoding: 'utf-8', mode: 0o600 });
  logger.log('🔐', normalized ? 'VNC 密码已更新并生效' : 'VNC 密码已清空，当前仅依赖 WebUI 访问认证');
  return {
    restarted: true,
    passwordConfigured: !!normalized,
    pid: child.pid
  };
}

