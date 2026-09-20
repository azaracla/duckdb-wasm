#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const deps = process.env.ALPHA_SMOKE_DEPS;
if (!deps) throw new Error('ALPHA_SMOKE_DEPS must point to isolated dependencies');
const puppeteer = require(path.join(path.resolve(deps), 'node_modules/puppeteer-core'));
const dir = path.resolve(process.argv[2] || 'build/dev/coi-smoke');
const port = Number(process.env.ALPHA_DUCKLAKE_PORT || 8790);
const url = `http://127.0.0.1:${port}/ducklake.html`;
const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(file => file && fs.existsSync(file));
if (!chrome) throw new Error('Chromium not installed');
for (const file of ['ducklake.html', 'ducklake.duckdb_extension.wasm', 'duckdb-coi.wasm']) {
  if (!fs.statSync(path.join(dir, file)).size) throw new Error(`Missing/empty browser asset: ${file}`);
}
const server = spawn('python3', [path.join(__dirname, 'serve.py'), dir, '--port', String(port)], { stdio: 'inherit' });
let browser;
async function main() {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`HTTP server exited: ${server.exitCode}`);
      try { const response = await fetch(url); if (response.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`HTTP server unavailable: ${url}`);
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(String(error)); console.error('[pageerror]', error); });
    page.on('error', error => { errors.push(String(error)); console.error('[page crash]', error); });
    page.on('console', message => console.log(`[chrome ${message.type()}] ${message.text()}`));
    page.on('requestfailed', request => console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText}`));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__ducklakeSmoke?.done === true, { timeout: 120000 });
    const result = await page.evaluate(() => window.__ducklakeSmoke);
    console.log('DUCKLAKE ACCEPTANCE', JSON.stringify({ result, errors }));
    if (errors.length || !result?.ok || !result.checks?.includes('DuckLake loader reports loaded=true')) {
      throw new Error(`DuckLake browser acceptance failed: ${JSON.stringify({ result, errors })}`);
    }
    console.log('PASS: real COI Chromium DuckDB 2 loaded pinned DuckLake side module');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
