#!/usr/bin/env node
'use strict';
/** Headless Chrome smoke on the *real* COI worker bundles, not a mocked WASM API. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const deps = process.env.ALPHA_SMOKE_DEPS;
if (!deps) throw new Error('ALPHA_SMOKE_DEPS is required');
const puppeteer = require(path.join(path.resolve(deps), 'node_modules/puppeteer-core'));
const dir = path.resolve(process.argv[2] || 'build/dev/coi-smoke');
const port = Number(process.env.ALPHA_SMOKE_PORT || 8766);
const url = `http://127.0.0.1:${port}/smoke.html`;
const script = path.join(__dirname, 'serve.py');
const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = candidates.find(binary => binary && fs.existsSync(binary));
if (!chrome) throw new Error('No installed Chrome/Chromium found; do not silently skip browser validation');

async function main() {
  const server = spawn('python3', [script, dir, '--port', String(port)], { stdio: 'inherit' });
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`COI smoke server exited with ${server.exitCode}`);
      try {
        const response = await fetch(url);
        if (response.ok) { ready = true; break; }
      } catch { /* server not listening yet */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('COI smoke server did not start');
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server'],
    });
    // Puppeteer's browser.on('targetcreated') missed every pthread in the prior
    // run: pthread workers are children of the dispatcher worker, not the page.
    // Discover all Chrome targets at browser scope, independently of Puppeteer.
    const browserCDP = await browser.createBrowserCDPSession();
    const discovered = new Map();
    const crashed = new Set();
    browserCDP.on('Target.targetCreated', ({ targetInfo }) => {
      if (!/worker/i.test(targetInfo.type)) return;
      discovered.set(targetInfo.targetId, { type: targetInfo.type, url: targetInfo.url });
      console.log(`[browser CDP] worker created id=${targetInfo.targetId} type=${targetInfo.type} url=${targetInfo.url}`);
    });
    browserCDP.on('Target.targetInfoChanged', ({ targetInfo }) => {
      if (discovered.has(targetInfo.targetId)) discovered.set(targetInfo.targetId, { type: targetInfo.type, url: targetInfo.url });
    });
    browserCDP.on('Target.targetCrashed', ({ targetId, status, errorCode }) => {
      crashed.add(targetId);
      console.error(`[browser CDP] target crashed id=${targetId} status=${status} errorCode=${errorCode}`);
    });
    await browserCDP.send('Target.setDiscoverTargets', { discover: true });
    const page = await browser.newPage();
    const errors = [];
    const workerSessions = [];
    let workersSeen = 0;
    // Keep the Puppeteer-level exception probe where available, but never
    // equate zero Puppeteer targets with zero nested Emscripten pthreads.
    browser.on('targetcreated', async target => {
      if (target.type() !== 'worker') return;
      const workerNumber = ++workersSeen;
      console.log(`[pthread diagnostic] Puppeteer worker target ${workerNumber}: ${target.url()}`);
      try {
        const session = await target.createCDPSession();
        workerSessions.push(session);
        session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
          const exception = exceptionDetails.exception?.description || exceptionDetails.text;
          console.error(`[pthread diagnostic] worker ${workerNumber} exception: ${exception}`);
          errors.push(`pthread ${workerNumber}: ${exception}`);
        });
        session.on('Runtime.consoleAPICalled', ({ type, args }) => {
          const message = args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ');
          if (type === 'error' || type === 'warning' || /worker|pthread|abort|error|failed/i.test(message)) {
            console.log(`[pthread diagnostic] worker ${workerNumber} ${type}: ${message}`);
          }
        });
        await session.send('Runtime.enable');
      } catch (error) {
        console.error(`[pthread diagnostic] worker ${workerNumber} CDP attach failed:`, error);
      }
    });
    page.on('requestfailed', request => console.error(`[chrome requestfailed] ${request.url()}: ${request.failure()?.errorText}`));
    let rejectFatal;
    const fatal = new Promise((_, reject) => { rejectFatal = reject; });
    fatal.catch(() => {});
    page.on('console', message => console.log(`[chrome ${message.type()}] ${message.text()}`));
    page.on('pageerror', error => { errors.push(String(error)); console.error('[chrome pageerror]', error); rejectFatal(error); });
    page.on('error', error => { errors.push(String(error)); console.error('[chrome error]', error); rejectFatal(error); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await Promise.race([
        page.waitForFunction(() => window.__alphaSmoke?.done === true, { timeout: 90000 }),
        fatal,
      ]);
    } finally {
      const targets = await browserCDP.send('Target.getTargets').catch(error => {
        console.error('[browser CDP] target snapshot failed:', error.message);
        return { targetInfos: [] };
      });
      const live = targets.targetInfos.filter(info => /worker/i.test(info.type));
      console.log(`[pthread diagnostic] browser-discovered=${discovered.size}, live-workers=${live.length}, crashed-targets=${crashed.size}, puppeteer-targets=${workersSeen}, CDP-sessions=${workerSessions.length}, errors=${errors.length}`);
      for (const info of live) console.log(`[browser CDP] live worker id=${info.targetId} type=${info.type} attached=${info.attached} url=${info.url}`);
    }
    const result = await page.evaluate(() => window.__alphaSmoke);
    console.log('COI BROWSER SMOKE:', JSON.stringify(result));
    if (errors.length || crashed.size || !result?.ok || !result.checks?.includes('threads=4, SQL=42')) {
      throw new Error(`COI browser failed: ${JSON.stringify({ result, errors, crashed: [...crashed] })}`);
    }
    console.log('PASS: browser COI initialized DuckDB 2, SELECT 42 and thread settings 1/2/4');
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
