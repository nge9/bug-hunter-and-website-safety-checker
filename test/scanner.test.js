import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { scanWebsite, normalizeURL, crawlable } from '../scanner.js';
import { escapeHTML } from '../report.js';

test('URL validation and crawl boundaries', () => {
  assert.equal(normalizeURL('https://example.com/a#x'), 'https://example.com/a');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com', 'garbage']) assert.throws(() => normalizeURL(url));
  for (const url of ['https://evil.test', 'https://example.com/logout', 'https://example.com/delete/1', 'https://example.com/?action=delete', 'https://example.com/file.pdf']) assert.equal(crawlable(url, 'https://example.com'), false);
  assert.equal(crawlable('https://example.com/about', 'https://example.com'), true);
  assert.equal(escapeHTML('<script>"&'), '&lt;script&gt;&quot;&amp;');
});

test('real browser finds seeded bugs, obeys scope, and writes safe reports', { timeout: 90000 }, async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/robots.txt') { res.end('User-agent: *\nDisallow: /private\n'); return; }
    if (req.url === '/missing' || req.url === '/broken.png') { res.writeHead(404); res.end('missing'); return; }
    if (req.url === '/secure') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");
      res.setHeader('Content-Type', 'text/html');
      res.end('<html lang="en"><head><title>Secure page</title></head><body><h1>Secure</h1><img src="/broken.png"></body></html>'); return;
    }
    if (req.url === '/ok') { res.setHeader('Content-Type', 'text/html'); res.end('<html lang="en"><head><title>OK</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>OK</h1></main></body></html>'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Fixture &lt;script&gt;alert(1)&lt;/script&gt;</title></head><body style="width:1200px"><h1>Bug fixture</h1><img src="/broken.png"><button></button><a href="/ok">OK</a><a href="/missing">Missing</a><a href="/private">Private</a><a href="/logout">Logout</a><a href="/?action=delete">Delete</a><a href="https://example.org/">External</a><a href="/secure">CSP</a><script>fetch('/mutate',{method:'POST'}).catch(()=>{}); console.error('fixture console error'); setTimeout(()=>{throw new Error('fixture runtime crash')},20)</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'siteprobe-test-'));
  try {
    const report = await scanWebsite(origin, { maxPages: 4, outDir });
    assert.notEqual(report.status, 'failed', report.error);
    assert.equal(report.pages.length, 4);
    for (const title of ['Uncaught JavaScript exception', 'Browser console error', 'Broken image', 'Horizontal overflow on mobile', 'HTTP 404 response']) assert.ok(report.findings.some(f => f.title === title), `Missing finding: ${title}`);
    assert.ok(report.findings.some(f => f.category === 'Accessibility'));
    assert.ok(report.pages.find(p => p.url.endsWith('/secure')).checks.includes('accessibility'), 'axe should work with strict CSP');
    assert.ok(!requests.some(x => /POST|\/private|\/logout|action=delete/.test(x)), JSON.stringify(requests));
    assert.ok(report.pages.every(p => p.url.startsWith(origin)));
    assert.ok((await readFile(path.join(outDir, 'screenshots/page-1-mobile.png'))).length > 500);
    const html = await readFile(path.join(outDir, 'report.html'), 'utf8');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    const saved = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8'));
    assert.equal(saved.findings.length, report.findings.length);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outDir, { recursive: true, force: true }); }
});

test('robots-disallowed entry is reported as partial coverage', { timeout: 30000 }, async () => {
  const server = http.createServer((req, res) => { if (req.url === '/robots.txt') res.end('User-agent: *\nDisallow: /\n'); else { res.statusCode = 500; res.end('must not crawl'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'siteprobe-robots-'));
  try {
    const r = await scanWebsite(`http://127.0.0.1:${server.address().port}`, { outDir });
    assert.equal(r.status, 'partial'); assert.equal(r.pages.length, 0); assert.equal(r.coverage.skipped.length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outDir, { recursive: true, force: true }); }
});
