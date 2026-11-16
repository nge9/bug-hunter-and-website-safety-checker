import http from 'node:http';
import { readFile, stat, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scanWebsite, normalizeURL } from './scanner.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const reports = path.join(root, 'reports');
const port = Number(process.env.PORT || 3210);
const host = `127.0.0.1:${port}`;
const jobs = new Map();
await mkdir(reports, { recursive: true });
// A process restart must never leave an old scan looking active.
for (const entry of await readdir(reports, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(reports, entry.name, 'scan.json');
  try {
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (record.state === 'running') {
      record.state = 'interrupted';
      record.message = 'The program stopped before this scan finished.';
      await writeFile(file, JSON.stringify(record, null, 2));
    }
  } catch { /* An incomplete or unrelated directory has no history record. */ }
}
async function saveRecord(job) {
  const record = { id: job.id, target: job.target, startedAt: job.startedAt, state: job.state,
    finishedAt: job.report?.finishedAt, summary: job.report?.summary, pages: job.report?.pages.length,
    message: job.message, reportUrl: job.reportUrl, jsonUrl: job.jsonUrl };
  await writeFile(path.join(reports, job.id, 'scan.json'), JSON.stringify(record, null, 2));
}
async function history() {
  const records = [];
  for (const entry of await readdir(reports, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { records.push(JSON.parse(await readFile(path.join(reports, entry.name, 'scan.json'), 'utf8'))); } catch { /* Skip unrelated files. */ }
  }
  return records.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
}
let active = false;
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  if (req.headers.host !== host) return send(res, 403, { error: `Open http://${host}` });
  const url = new URL(req.url, `http://${host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: 'Cross-origin requests are blocked.' });
      if (active) return send(res, 409, { error: 'A scan is already running. Wait for it to finish.' });
      if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Expected JSON.' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(res, 413, { error: 'Request too large.' }); }
      const data = JSON.parse(body);
      const target = normalizeURL(data.url);
      const maxPages = Number(data.maxPages || 10);
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 30) return send(res, 400, { error: 'Page limit must be 1–30.' });
      const id = randomUUID();
      if (active) return send(res, 409, { error: 'A scan is already running.' });
      const job = { id, target, startedAt: new Date().toISOString(), state: 'running', message: 'Starting Chromium…', messages: [] };
      active = true;
      try {
        await mkdir(path.join(reports, id), { recursive: true });
        await saveRecord(job);
      } catch (error) { active = false; throw error; }
      jobs.set(id, job);
      // Keep memory bounded during long-lived local use. Report files remain on disk.
      if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
      send(res, 202, { id });
      scanWebsite(target, { maxPages, outDir: path.join(reports, id), onProgress(message) { job.message = message; job.messages = [...job.messages, message].slice(-100); } }).then(async report => {
        job.report = report; job.reportUrl = `/reports/${id}/report.html`; job.jsonUrl = `/reports/${id}/report.json`;
        await saveRecord({ ...job, state: report.status });
        job.state = report.status;
      }).catch(async error => { job.state = 'failed'; job.message = error.message; try { await saveRecord(job); } catch { /* Disk error is visible in job status. */ } }).finally(() => { active = false; });
      return;
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    if (url.pathname === '/api/history') return send(res, 200, await history());
    if (url.pathname.startsWith('/api/scan/')) {
      const job = jobs.get(url.pathname.split('/').pop());
      return send(res, job ? 200 : 404, job || { error: 'Scan not found.' });
    }
    let filename;
    if (url.pathname.startsWith('/reports/')) {
      const relative = decodeURIComponent(url.pathname.slice('/reports/'.length));
      filename = path.resolve(reports, relative);
      if (!filename.startsWith(reports + path.sep)) return send(res, 403, { error: 'Invalid path.' });
    } else {
      const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      if (!files[url.pathname]) return send(res, 404, { error: 'Not found.' });
      filename = path.join(root, 'public', files[url.pathname]);
    }
    if (!(await stat(filename)).isFile()) return send(res, 404, { error: 'Not found.' });
    const ext = path.extname(filename);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(await readFile(filename));
  } catch (error) { send(res, error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'Not found.' : error.message }); }
});
server.requestTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log(`SiteProbe → http://${host}\nPress Ctrl+C to stop.`));
