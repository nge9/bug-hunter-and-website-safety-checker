import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { chromium } from 'playwright';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function freePort() {
  const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}
async function startServer(port) {
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/history`)).ok) return child; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill(); throw new Error('Server failed to start: ' + output);
}
async function stop(child) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }

test('URL interface scans, filters findings and preserves history after restart', { timeout: 90000 }, async () => {
  const fixture = http.createServer((req,res) => {
    if (req.url === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type','text/html');
    res.end('<html><body><h1>UI fixture</h1><script>throw new Error("UI fixture crash")</script></body></html>');
  });
  await new Promise(r => fixture.listen(0,'127.0.0.1',r));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child, browser, id, cliId;
  try {
    child = await startServer(port);
    const rejected = await fetch(base+'/api/scan', { method:'POST', headers:{'Content-Type':'application/json',Origin:'https://other.test'}, body:JSON.stringify({url:'https://example.com'}) });
    assert.equal(rejected.status,403);
    const bad = await fetch(base+'/api/scan', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'file:///etc/passwd'}) });
    assert.equal(bad.status,400);
    browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.fill('#url',`http://127.0.0.1:${fixture.address().port}`);
    await page.selectOption('#pages','5');
    await page.check('input[type=checkbox]');
    await page.click('#submit');
    await page.waitForFunction(() => ['COMPLETE','PARTIAL','FAILED'].includes(document.querySelector('#state').textContent), null, { timeout:45000 });
    assert.ok((await page.textContent('#findings')).includes('Uncaught JavaScript exception'));
    assert.equal(await page.locator('#downloads a').count(),2);
    await page.selectOption('#severity','high');
    assert.ok(await page.locator('.finding').count() > 0);
    assert.ok((await page.textContent('#history-list')).includes('View full report'));
    assert.deepEqual(errors,[]);
    const records = await (await fetch(base+'/api/history')).json();
    const record = records.find(r => r.target === `http://127.0.0.1:${fixture.address().port}/`);
    id = record.id;
    assert.ok(record.summary.high > 0);
    const reportResponse = await fetch(base + record.reportUrl);
    assert.equal(reportResponse.status,200);
    await page.goto(base);
    await page.screenshot({path: path.join(process.env.SITEPROBE_PREVIEW_DIR || os.tmpdir(), 'siteprobe-desktop.png'), fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:path.join(process.env.SITEPROBE_PREVIEW_DIR || os.tmpdir(), 'siteprobe-mobile.png'),fullPage:true});
    await stop(child); child = await startServer(port);
    const restored = await (await fetch(base+'/api/history')).json();
    assert.ok(restored.some(r => r.id === id && r.summary.high > 0));
    cliId = `cli-test-${Date.now()}`;
    const cli = spawn(process.execPath, ['cli.js', `http://127.0.0.1:${fixture.address().port}`, '--pages', '1', '--out', path.join(root, 'reports', cliId)], {cwd:root, env:process.env, stdio:'ignore'});
    assert.equal(await new Promise(resolve => cli.on('exit', resolve)), 1);
    const afterCLI = await (await fetch(base+'/api/history')).json();
    assert.ok(afterCLI.some(r => r.id === cliId && r.summary.high > 0), 'CLI scans should appear in history');
  } finally {
    await browser?.close(); if(child) await stop(child);
    fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
    if (id) await rm(path.join(root,'reports',id),{recursive:true,force:true});
    if (cliId) await rm(path.join(root,'reports',cliId),{recursive:true,force:true});
  }
});
