// Render the existing code-native product monogram with a full-bleed iOS background.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const svg = (await readFile(new URL('../build/icon.svg', import.meta.url), 'utf8'))
  .replace('<rect x="64" y="64" width="896" height="896" rx="205"', '<rect x="0" y="0" width="1024" height="1024"');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:#1c1c1a;overflow:hidden}</style>${svg}`);
  await page.screenshot({ path: new URL('Benchdesk/Assets.xcassets/AppIcon.appiconset/AppIcon.png', import.meta.url).pathname });
} finally { await browser.close(); }
