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
const baseURL = `http://127.0.0.1:${port}/smoke.html`;
const transport = process.env.ALPHA_RANGE_TRANSPORT || 'broker';
const repeat = Number(process.env.ALPHA_RANGE_REPEAT || 1);
if (!['broker', 'sync-xhr'].includes(transport)) throw new Error(`Unsupported ALPHA_RANGE_TRANSPORT: ${transport}`);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error(`Invalid ALPHA_RANGE_REPEAT: ${repeat}`);
const script = path.join(__dirname, 'serve.py');
const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const chrome = candidates.find(binary => binary && fs.existsSync(binary));
if (!chrome) throw new Error('No installed Chrome/Chromium found; do not silently skip browser validation');

async function waitForServer(url, server) {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Smoke server exited with ${server.exitCode}: ${url}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Smoke server did not start: ${url}`);
}

async function main() {
  const server = spawn('python3', [script, dir, '--port', String(port)], { stdio: 'inherit' });
  let rangeServer;
  let browser;
  try {
    await waitForServer(baseURL, server);
    let url = baseURL;
    // This gate is OPT-IN. Never count synthetic fetches as DuckDB concurrency.
    // Supply an actual local Parquet fixture with multiple row groups/chunks.
    if (process.env.ALPHA_PARQUET_FIXTURE) {
      const fixture = path.resolve(process.env.ALPHA_PARQUET_FIXTURE);
      if (!fs.statSync(fixture).isFile()) throw new Error(`Not a Parquet fixture: ${fixture}`);
      const rangePort = Number(process.env.ALPHA_RANGE_PORT || 8767);
      if (rangePort === port) throw new Error('Range fixture and smoke site need separate ports');
      const rangeOrigin = `http://127.0.0.1:${rangePort}`;
      rangeServer = spawn('python3', [path.join(__dirname, '../range_trace_server.py'), '--file', fixture, '--port', String(rangePort), '--delay-ms', String(Number(process.env.ALPHA_RANGE_DELAY_MS || 100))], { stdio: 'inherit' });
      await waitForServer(`${rangeOrigin}/__trace`, rangeServer);
      url += `?rangeBase=${encodeURIComponent(rangeOrigin + '/')}&transport=${encodeURIComponent(transport)}&repeat=${repeat}&controls=${process.env.ALPHA_RANGE_CONTROLS === '1' ? '1' : '0'}`;
      console.log(`[range acceptance] enabled for fixture ${fixture}; SQL origin ${rangeOrigin}; transport=${transport}; repeat=${repeat}`);
    } else {
      console.log('[range acceptance] NOT RUN: set ALPHA_PARQUET_FIXTURE to enable real DuckDB Parquet SQL overlap validation');
    }
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server'],
    });
    // puppeteer-core@22.8.0 exposes CDP sessions via Target.createCDPSession(),
    // not Browser.createBrowserCDPSession() (which caused the previous CI failure).
    // The browser target sees nested worker targets that Puppeteer's targetcreated may omit.
    const browserCDP = await browser.target().createCDPSession();
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
    if (errors.length || crashed.size || !result?.ok || !result.checks?.includes('threads=2, SQL=42')) {
      throw new Error(`COI browser failed: ${JSON.stringify({ result, errors, crashed: [...crashed] })}`);
    }
    if (rangeServer && transport === 'broker' && !result.checks.includes('one DuckDB Parquet query with >=2 overlapping HTTP Range reads')) {
      throw new Error('Range acceptance enabled but one-query overlap was not verified');
    }
    if (rangeServer && transport === 'sync-xhr' && !result.checks.includes('DuckDB Parquet sync-XHR transport baseline')) {
      throw new Error('Sync-XHR benchmark baseline did not complete');
    }
    console.log('PASS: browser COI initialized DuckDB 2, SELECT 42 and threads=2');
    if (rangeServer) console.log(transport === 'broker'
      ? 'PASS: one real DuckDB Parquet SQL query emitted overlapping HTTP 206 Range GETs'
      : 'PASS: one real DuckDB Parquet SQL query completed through the serialized sync-XHR baseline');
  } finally {
    if (browser) await browser.close();
    if (rangeServer) rangeServer.kill('SIGTERM');
    server.kill('SIGTERM');
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
