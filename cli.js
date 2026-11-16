import { scanWebsite, normalizeURL } from './scanner.js';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (!args[0] || args.includes('--help')) {
  console.log('Usage: npm run scan -- https://your-site.com [--pages 10] [--out reports/my-scan]\nOnly scan sites you own or have permission to test.');
  process.exit(args.includes('--help') ? 0 : 1);
}
function option(flag, fallback) { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; }
let record, outDir;
try {
  const target = normalizeURL(args[0]);
  outDir = path.resolve(option('--out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports', `scan-${Date.now()}`)));
  await mkdir(outDir, { recursive: true });
  const id = path.basename(outDir);
  record = { id, target, state: 'running', startedAt: new Date().toISOString() };
  await writeFile(path.join(outDir, 'scan.json'), JSON.stringify(record, null, 2));
  const report = await scanWebsite(target, { maxPages: option('--pages', 10), outDir, onProgress: console.log });
  Object.assign(record, { state: report.status, finishedAt: report.finishedAt, summary: report.summary, pages: report.pages.length, message: report.error || 'Scan finished.', reportUrl: `/reports/${id}/report.html`, jsonUrl: `/reports/${id}/report.json` });
  await writeFile(path.join(outDir, 'scan.json'), JSON.stringify(record, null, 2));
  console.log(`\n${JSON.stringify(report.summary)}\nHTML: ${path.join(outDir, 'report.html')}\nJSON: ${path.join(outDir, 'report.json')}`);
  process.exitCode = report.status === 'failed' ? 2 : report.findings.some(f => f.severity === 'high') ? 1 : 0;
} catch (error) {
  if (record && outDir) {
    Object.assign(record, { state: 'failed', finishedAt: new Date().toISOString(), message: error.message });
    try { await writeFile(path.join(outDir, 'scan.json'), JSON.stringify(record, null, 2)); } catch {}
  }
  console.error(error.message); process.exitCode = 2;
}
