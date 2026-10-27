import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const WINDOWS_FONT_DIR = process.env.WINDOWS_FONT_DIR || '/usr/share/fonts/truetype/windows';

function listFontFiles(dir = WINDOWS_FONT_DIR) {
  try {
    return fs.readdirSync(dir)
      .filter(name => /\.(ttf|ttc|otf)$/i.test(name))
      .sort();
  } catch {
    return [];
  }
}

async function fcMatch(family) {
  try {
    const { stdout } = await execFileAsync('fc-match', ['-f', '%{family}', family], {
      timeout: 5000,
      maxBuffer: 64 * 1024
    });
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

function familyMatches(actual, expected) {
  const normalized = String(actual || '').toLowerCase();
  return String(expected || '').split('|').some(token => normalized.includes(token.toLowerCase()));
}

export async function getFontStatus() {
  const files = listFontFiles();
  const [yahei, segoe, segoeEmoji] = await Promise.all([
    fcMatch('Microsoft YaHei'),
    fcMatch('Segoe UI'),
    fcMatch('Segoe UI Emoji')
  ]);
  const yaheiOk = familyMatches(yahei, ['Microsoft YaHei', '微软雅黑']);
  const segoeOk = familyMatches(segoe, ['Segoe UI']);
  const emojiOk = familyMatches(segoeEmoji, ['Segoe UI Emoji']);
  return {
    dir: WINDOWS_FONT_DIR,
    mounted: fs.existsSync(WINDOWS_FONT_DIR),
    files,
    fileCount: files.length,
    matches: {
      yahei,
      segoe,
      segoeEmoji
    },
    yaheiOk,
    segoeOk,
    emojiOk,
    windowsFontsReady: yaheiOk && segoeOk,
    fallback: !(yaheiOk && segoeOk),
    message: yaheiOk && segoeOk
      ? '已检测到 Microsoft YaHei 与 Segoe UI'
      : (files.length > 0
        ? '字体文件存在，但 fontconfig 尚未匹配到 Microsoft YaHei / Segoe UI'
        : '未检测到 Windows 字体，继续使用镜像内置开源字体')
  };
}

export async function refreshFontCache() {
  try {
    await execFileAsync('fc-cache', ['-f'], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  } catch {
    // 字体目录只读或 fontconfig 不存在时，后续匹配结果会如实反映失败。
  }
  return getFontStatus();
}

export function ensureWindowsFontDir() {
  try {
    fs.mkdirSync(WINDOWS_FONT_DIR, { recursive: true });
  } catch {}
}

