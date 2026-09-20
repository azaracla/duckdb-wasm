#!/usr/bin/env node
'use strict';

/**
 * A/B benchmark for DuckDB 2 browser remote Parquet I/O.
 *
 * Keeps DuckDB revision, SQL, threads, async_threads, read_ahead_depth,
 * browser, fixture and server identical. The only variable is the browser
 * transport: central async fetch broker vs the legacy synchronous XHR path.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const deps = process.env.ALPHA_SMOKE_DEPS;
if (!deps) throw new Error('ALPHA_SMOKE_DEPS is required');
const fixtureEnv = process.env.ALPHA_PARQUET_FIXTURE;
if (!fixtureEnv) throw new Error('ALPHA_PARQUET_FIXTURE is required');

const puppeteer = require(path.join(path.resolve(deps), 'node_modules/puppeteer-core'));
const dir = path.resolve(process.argv[2] || 'build/dev/coi-smoke');
const fixture = path.resolve(fixtureEnv);
if (!fs.statSync(fixture).isFile()) throw new Error(`Not a Parquet fixture: ${fixture}`);

const sitePort = Number(process.env.ALPHA_BENCH_SITE_PORT || 8770);
const rangePort = Number(process.env.ALPHA_BENCH_RANGE_PORT || 8771);
const delayMs = Number(process.env.ALPHA_RANGE_DELAY_MS || 0);
const repetitions = Number(process.env.ALPHA_BENCH_REPETITIONS || 5);
if (!Number.isInteger(repetitions) || repetitions < 3) throw new Error('ALPHA_BENCH_REPETITIONS must be an integer >= 3');
if (sitePort === rangePort) throw new Error('Benchmark site and range server need separate ports');

const siteOrigin = `http://127.0.0.1:${sitePort}`;
const rangeOrigin = `http://127.0.0.1:${rangePort}`;
const serveScript = path.join(__dirname, 'serve.py');
const rangeScript = path.join(__dirname, '../range_trace_server.py');
const candidates = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const chrome = candidates.find(binary => binary && fs.existsSync(binary));
if (!chrome) throw new Error('No installed Chrome/Chromium found');

async function waitForServer(url, processHandle) {
  for (let i = 0; i < 100; i++) {
    if (processHandle.exitCode !== null) throw new Error(`Server exited with ${processHandle.exitCode}: ${url}`);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${url}`);
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function summarize(samples) {
  const times = samples.map(sample => sample.queryMs).sort((a, b) => a - b);
  const throughputs = samples.map(sample => sample.throughputMbps);
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  return {
    repetitions: samples.length,
    meanMs: mean(times),
    medianMs: percentile(times, 50),
    p95Ms: percentile(times, 95),
    minMs: times[0],
    maxMs: times[times.length - 1],
    meanThroughputMbps: mean(throughputs),
    maxOverlap: Math.max(...samples.map(sample => sample.maxOverlap)),
    rangeGets: samples.map(sample => sample.rangeGets),
    transferredBytes: samples.map(sample => sample.transferredBytes),
  };
}

async function runTrial(browser, transport, iteration) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('error', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') console.error(`[bench ${transport} #${iteration}] ${message.text()}`);
  });
  const url = new URL('/smoke.html', siteOrigin);
  url.searchParams.set('rangeBase', rangeOrigin + '/');
  url.searchParams.set('transport', transport);
  url.searchParams.set('controls', '0');
  try {
    await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__alphaSmoke?.done === true, { timeout: 120_000 });
    const result = await page.evaluate(() => window.__alphaSmoke);
    if (errors.length || !result?.ok) {
      throw new Error(`Trial failed: ${JSON.stringify({ transport, iteration, errors, result })}`);
    }
    const expectedCheck = transport === 'broker'
      ? 'one DuckDB Parquet query with >=2 overlapping HTTP Range reads'
      : 'one DuckDB Parquet query with serialized HTTP Range reads';
    if (!result.checks?.includes(expectedCheck)) {
      throw new Error(`Missing transport check: ${expectedCheck}`);
    }
    const rangedGets = result.rangeTrace.events.filter(event => event.method === 'GET' && event.range);
    const transferredBytes = rangedGets.reduce((sum, event) => sum + Number(event.bytes || 0), 0);
    const queryMs = Number(result.parquet.queryMs);
    const throughputMbps = transferredBytes * 8 / (queryMs / 1000) / 1_000_000;
    const sample = {
      iteration,
      transport,
      version: result.version,
      queryMs,
      idSum: result.parquet.idSum,
      rangeGets: result.rangeTrace.completed_range_gets,
      maxOverlap: result.rangeTrace.max_overlapping_ranges,
      transferredBytes,
      throughputMbps,
      ioSettings: result.ioSettings,
    };
    console.log('BENCH SAMPLE', JSON.stringify(sample));
    return sample;
  } finally {
    await page.close();
  }
}

async function main() {
  const siteServer = spawn('python3', [serveScript, dir, '--port', String(sitePort)], { stdio: 'inherit' });
  const rangeServer = spawn('python3', [
    rangeScript,
    '--file', fixture,
    '--port', String(rangePort),
    '--delay-ms', String(delayMs),
  ], { stdio: 'inherit' });
  let browser;
  try {
    await Promise.all([
      waitForServer(`${siteOrigin}/smoke.html`, siteServer),
      waitForServer(`${rangeOrigin}/__trace`, rangeServer),
    ]);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server'],
    });

    const samples = { 'sync-xhr': [], broker: [] };
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      // Alternate order to reduce systematic warm-up / thermal / scheduler bias.
      const order = iteration % 2 === 1 ? ['sync-xhr', 'broker'] : ['broker', 'sync-xhr'];
      for (const transport of order) {
        samples[transport].push(await runTrial(browser, transport, iteration));
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }

    const baseline = summarize(samples['sync-xhr']);
    const broker = summarize(samples.broker);
    const report = {
      benchmark: 'DuckDB 2 WASM remote Parquet transport A/B',
      methodology: {
        repetitions,
        delayMs,
        fixtureBytes: fs.statSync(fixture).size,
        query: "SELECT SUM(id)::HUGEINT AS id_sum FROM read_parquet('fixture.parquet')",
        externalFileCache: false,
        controlledVariable: 'HTTP Range transport only: synchronous XHR vs central async fetch broker',
        order: 'alternating per repetition',
      },
      baseline,
      broker,
      speedup: {
        median: baseline.medianMs / broker.medianMs,
        mean: baseline.meanMs / broker.meanMs,
        p95: baseline.p95Ms / broker.p95Ms,
      },
      samples,
    };
    console.log('DUCKDB ASYNC IO BENCHMARK', JSON.stringify(report));
    const output = path.resolve(process.env.ALPHA_BENCHMARK_OUT || `async-io-benchmark-${delayMs}ms.json`);
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Benchmark report written to ${output}`);
  } finally {
    if (browser) await browser.close();
    rangeServer.kill('SIGTERM');
    siteServer.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
