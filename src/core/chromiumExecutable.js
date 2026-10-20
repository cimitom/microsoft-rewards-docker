import fs from 'fs';

const CHROMIUM_CANDIDATES = [
  // Linux (Debian/Ubuntu/Alpine)
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  // macOS
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Windows
  'C:\\Program Files (x86)\\Microsoft Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

/**
 * Find an installed Chromium-family browser without downloading Playwright's
 * bundled Chromium. Docker pins CHROMIUM_PATH, while desktop installs use the
 * first known Edge/Chrome location.
 */
export function findChromiumExecutable(env = process.env) {
  const configured = String(env.CHROMIUM_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  return CHROMIUM_CANDIDATES.find(candidate => fs.existsSync(candidate)) || null;
}
