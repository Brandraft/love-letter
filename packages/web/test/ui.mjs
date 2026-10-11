// Browser walkthrough: create a room, add bots, play a few turns, open the ledger, switch theme.
// Needs a built server (pnpm build) and Chromium for playwright-core (npx playwright install chromium).
// Run: pnpm --filter @love-letter/web test:ui
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const port = 18000 + Math.floor(Math.random() * 1000);
const dataDir = mkdtempSync(join(tmpdir(), 'love-letter-ui-'));
const server = spawn('node', ['../server/dist/main.js'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, WEB_DIST: new URL('../dist', import.meta.url).pathname },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(base + '/api/health').catch(() => null))?.ok || (await fetch(base + '/')).ok) break; } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 100));
}

const errors = [];
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(base + '/');
  await page.click('button:has-text("Create a room")');
  await page.waitForURL(/\/r\//);
  await page.fill('input[placeholder="Your name"]', 'Alice');
  await page.click('button:has-text("Join")');
  await page.waitForSelector('text=Waiting for players');
  await page.selectOption('select:near(:text("Pace"))', '1');
  await page.selectOption('select:near(:text("First to"))', '1');
  await page.click('button:has-text("Add a bot")');
  await page.click('button:has-text("Add a bot")');
  await page.waitForSelector('text=Bot Cyrano');
  await page.click('button:has-text("Start game")');
  await page.waitForSelector('.table');

  // Play until the game ends (first to 1) using the keyboard where possible.
  for (let n = 0; n < 12; n++) {
    const over = await page.$('.overlay');
    if (over) break;
    try { await page.waitForSelector('.cmd .todo:has-text("Choose a card")', { timeout: 8000 }); } catch { continue; }
    const hand = await page.$$('.me .hand .card:not(.disabled)');
    await hand[0].click();
    await page.waitForTimeout(150);
    for (let k = 0; k < 2; k++) {
      const opt = await page.$('.cmd .opts button:not([disabled])');
      if (opt) { await opt.click(); await page.waitForTimeout(150); }
    }
    const cta = await page.$('.cmd .btn-cta:not([disabled])');
    if (cta) { await page.keyboard.press('Enter'); }
    await page.waitForTimeout(1500);
  }
  await page.waitForSelector('.overlay', { timeout: 30000 });
  await page.click('.overlay button:has-text("Play again")');
  await page.waitForSelector('.overlay', { state: 'detached' });
  await page.waitForSelector('.table');
  await page.click('.ledger-head');
  await page.waitForSelector('.ledger-list .entry');
  await page.click('button:has-text("Dark")');
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'dark') errors.push('theme toggle did not switch to dark');
} catch (e) {
  errors.push('walkthrough failed: ' + String(e));
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) { console.error('UI test failed:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('UI walkthrough passed');
