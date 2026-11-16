import { chromium } from 'playwright';
import robotsParser from 'robots-parser';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { renderReport } from './report.js';

const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const unsafePath = /(?:^|\/)(?:logout|signout|delete|remove|unsubscribe|checkout|purchase)(?:\/|$)/i;
export function normalizeURL(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  u.hash = '';
  return u.href;
}
export function crawlable(value, origin) {
  try {
    const u = new URL(value);
    return u.origin === origin && !u.search && !unsafePath.test(u.pathname) &&
      !/\.(?:pdf|zip|gz|png|jpe?g|webp|svg|mp4|mp3|exe|dmg|docx?|xlsx?)$/i.test(u.pathname);
  } catch { return false; }
}
export async function scanWebsite(input, options = {}) {
  const start = normalizeURL(input);
  const origin = new URL(start).origin;
  const maxPages = Math.max(1, Math.min(30, Number(options.maxPages) || 10));
  const maxLinks = Math.max(1, Math.min(300, Number(options.maxLinks) || 100));
  const outDir = path.resolve(options.outDir || 'reports/latest');
  const report = {
    target: start, startedAt: new Date().toISOString(), status: 'running',
    settings: { maxPages, maxLinks, browser: 'Chromium', viewports: ['1440×900', '390×844'] },
    pages: [], findings: [], coverage: { linksChecked: 0, discoveredPages: 1, skipped: [], warnings: [] },
    limitations: [
      'Automated observations are not proof that a site is bug-free or secure.',
      'Only public, same-origin pages are crawled. No logins, form submissions, exploit payloads or destructive actions are performed.',
      'Only GET, HEAD and OPTIONS browser requests are allowed. Apps requiring other methods may not fully load.',
      'Query-string links, action-like paths and downloads are excluded from crawling. External links are not probed.',
      'No business-logic, payment, authentication, malware or server-side vulnerability testing is performed.',
      'Screenshots, URLs and console messages can contain sensitive data; review reports before sharing.'
    ]
  };
  const emit = message => options.onProgress?.(message);
  function finding(page, category, severity, title, evidence, fix, extra = {}) {
    report.findings.push({ id: `F${String(report.findings.length + 1).padStart(4, '0')}`, page, category, severity, title, evidence: String(evidence).slice(0, 12000), fix, ...extra });
  }
  await mkdir(path.join(outDir, 'screenshots'), { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  let browser;
  try {
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(15000);
    const userAgent = await (async () => { const p = await context.newPage(); const ua = await p.evaluate(() => navigator.userAgent); await p.close(); return ua; })();
    let robots;
    try {
      const response = await context.request.get(`${origin}/robots.txt`, { timeout: 8000, maxRedirects: 0 });
      if (response.status() === 200) robots = robotsParser(`${origin}/robots.txt`, await response.text());
      else if (response.status() !== 404) report.coverage.warnings.push(`robots.txt returned HTTP ${response.status()}; crawl rules could not be confirmed.`);
      await response.dispose();
    } catch (error) { report.coverage.warnings.push(`Could not read robots.txt: ${error.message}`); }
    const allowed = url => !robots || robots.isAllowed(url, userAgent) !== false;
    await context.route('**/*', async route => {
      const req = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.abort('blockedbyclient');
      if (req.isNavigationRequest()) {
        const url = new URL(req.url());
        if (url.origin !== origin || unsafePath.test(url.pathname) || !allowed(url.href)) return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const queue = [start], seen = new Set(), discovered = new Set([start]), links = new Map();
    const deadline = Date.now() + 5 * 60_000;
    while (queue.length && report.pages.length < maxPages && Date.now() < deadline) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      if (!allowed(url) || unsafePath.test(new URL(url).pathname)) {
        report.coverage.skipped.push({ url, reason: 'robots.txt or action-like path' });
        continue;
      }
      emit(`Scanning page ${report.pages.length + 1}/${maxPages}: ${url}`);
      const page = await context.newPage();
      const record = { url, status: null, checks: [], screenshots: {} };
      report.pages.push(record);
      const events = new Set();
      const addEvent = (key, callback) => { if (!events.has(key) && events.size < 100) { events.add(key); callback(); } };
      page.on('pageerror', error => addEvent(`js:${error.message}`, () => finding(url, 'Runtime', 'high', 'Uncaught JavaScript exception', error.stack || error.message, 'Reproduce the exception and fix the failing code path.')));
      page.on('console', msg => {
        if (msg.type() === 'error') addEvent(`console:${msg.text()}`, () => finding(url, 'Console', 'medium', 'Browser console error', msg.text(), 'Inspect the console error and its originating script or request.', { location: msg.location() }));
      });
      page.on('response', response => {
        if (response.status() >= 400) addEvent(`http:${response.url()}`, () => finding(url, 'Network', response.status() >= 500 ? 'high' : 'medium', `HTTP ${response.status()} response`, `${response.request().resourceType()}: ${response.url()}`, 'Fix the endpoint or resource URL. Check whether authentication or bot protection caused this response.'));
      });
      page.on('requestfailed', req => {
        const error = req.failure()?.errorText || 'Unknown failure';
        if (/ABORTED|BLOCKED_BY_CLIENT/.test(error)) return;
        addEvent(`failed:${req.url()}`, () => finding(url, 'Network', 'medium', 'Request failed', `${req.url()} — ${error}`, 'Inspect connectivity, TLS, CORS, or the resource server.'));
      });
      try {
        const before = Date.now();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
        record.status = response?.status() || null;
        record.finalUrl = page.url();
        record.loadMs = Date.now() - before;
        record.checks.push('navigation', 'runtime', 'network');
        const html = response?.headers()['content-type'] || '';
        if (!html.includes('text/html')) {
          report.coverage.warnings.push(`${url}: HTML checks skipped (content type: ${html || 'unknown'}).`);
          continue;
        }
        const headers = await response.allHeaders();
        if (new URL(url).protocol === 'http:') finding(url, 'Security configuration', 'medium', 'Page served over HTTP', url, 'Serve the site over HTTPS and redirect HTTP traffic.');
        for (const [header, fix] of [
          ['content-security-policy', 'Define a Content-Security-Policy appropriate for your scripts and resources.'],
          ['x-content-type-options', 'Send X-Content-Type-Options: nosniff.'],
          ...(new URL(url).protocol === 'https:' ? [['strict-transport-security', 'Configure Strict-Transport-Security after confirming HTTPS works across the intended scope.']] : [])
        ]) if (!headers[header]) finding(url, 'Security configuration', 'low', `Missing ${header} header`, `Header absent on ${record.finalUrl}. This is a hardening suggestion, not a confirmed vulnerability.`, fix);
        if (headers['x-content-type-options'] && headers['x-content-type-options'].toLowerCase() !== 'nosniff') finding(url, 'Security configuration', 'low', 'Invalid X-Content-Type-Options', headers['x-content-type-options'], 'Set this header to nosniff.');
        const dom = await page.evaluate(() => ({
          title: document.title.trim(),
          viewport: document.querySelector('meta[name="viewport"]')?.content,
          images: [...document.images].filter(x => x.complete && x.naturalWidth === 0 && x.currentSrc).map(x => x.currentSrc),
          links: [...document.querySelectorAll('a[href]')].map(a => a.href),
          mixed: [...document.querySelectorAll('script[src],img[src],link[href],iframe[src]')].map(x => x.src || x.href).filter(x => x?.startsWith('http:'))
        }));
        record.title = dom.title;
        if (!dom.title) finding(url, 'Page metadata', 'low', 'Missing page title', '<title> is absent or empty.', 'Add a descriptive, unique document title.');
        if (!dom.viewport) finding(url, 'Mobile', 'medium', 'Missing viewport metadata', 'No meta[name="viewport"] element.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
        for (const src of new Set(dom.images)) finding(url, 'Images', 'medium', 'Broken image', src, 'Repair the image URL or restore the missing asset.');
        if (new URL(url).protocol === 'https:') for (const src of new Set(dom.mixed)) finding(url, 'Security configuration', 'medium', 'HTTP resource on an HTTPS page', src, 'Load this resource over HTTPS.');
        for (const href of dom.links) {
          let link;
          try { link = normalizeURL(href); } catch { continue; }
          if (!crawlable(link, origin) || !allowed(link)) continue;
          if (links.size < maxLinks && !links.has(link)) links.set(link, url);
          if (!discovered.has(link) && discovered.size < 1000) { discovered.add(link); queue.push(link); }
        }
        await page.evaluate(axeSource);
        const accessibility = await page.evaluate(async () => {
          const result = await Promise.race([window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }), new Promise((_, reject) => setTimeout(() => reject(new Error('Accessibility check timed out.')), 12000))]);
          return { violations: result.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, count: v.nodes.length, nodes: v.nodes.slice(0, 20).map(n => ({ target: n.target, html: n.html, explanation: n.failureSummary })) })), incomplete: result.incomplete.length };
        });
        for (const violation of accessibility.violations) finding(url, 'Accessibility', ['critical', 'serious'].includes(violation.impact) ? 'high' : 'medium', violation.help, JSON.stringify(violation.nodes, null, 2), `See ${violation.helpUrl}`, { rule: violation.id, affectedElements: violation.count, helpUrl: violation.helpUrl });
        record.accessibilityNeedsReview = accessibility.incomplete;
        record.checks.push('headers', 'metadata', 'images', 'accessibility');
        for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(200);
          const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 2 || r.left < -2) && getComputedStyle(x).visibility !== 'hidden'; }).slice(0, 8).map(x => x.outerHTML.slice(0, 300)) }));
          if (overflow.content > overflow.width + 2) finding(url, 'Layout', 'medium', `Horizontal overflow on ${name}`, `${overflow.content}px content in ${overflow.width}px viewport. Candidate elements: ${overflow.elements.join('\n')}`, 'Inspect the candidate elements for fixed widths or overflowing content. Some intentional carousels may require manual review.');
          const filename = `screenshots/page-${report.pages.length}-${name}.png`;
          await page.screenshot({ path: path.join(outDir, filename), timeout: 8000 });
          record.screenshots[name] = filename;
        }
        record.checks.push('desktop layout', 'mobile layout', 'screenshots');
      } catch (error) {
        record.error = error.message;
        report.coverage.warnings.push(`${url}: some checks did not complete: ${error.message}`);
        finding(url, 'Scan coverage', 'info', 'Page checks did not complete', error.message, 'Check redirects, bot protection and page availability, then rerun. This is not necessarily a website bug.');
      } finally { await page.close(); }
    }
    report.coverage.discoveredPages = discovered.size;
    report.coverage.remainingPages = queue.length;
    if (queue.length) report.coverage.warnings.push('Page or time limit reached; some discovered pages were not scanned.');
    for (const [url, source] of links) {
      if (Date.now() > deadline) { report.coverage.warnings.push('Time limit reached during link checking.'); break; }
      if (seen.has(url)) continue;
      emit(`Checking link ${report.coverage.linksChecked + 1}: ${url}`);
      try {
        const res = await context.request.head(url, { timeout: 6000, maxRedirects: 0 });
        report.coverage.linksChecked++;
        if (res.status() >= 400 && ![401, 403, 405, 429, 501].includes(res.status())) finding(source, 'Links', 'medium', `Broken internal link (HTTP ${res.status()})`, url, 'Update or remove the link, or restore the destination.');
        else if ([401, 403, 405, 429, 501].includes(res.status())) report.coverage.warnings.push(`Link not verified: ${url} (HEAD returned ${res.status()}).`);
        else if (res.status() >= 300) report.coverage.warnings.push(`Redirect destination not probed: ${url} → ${res.headers().location || 'unknown'}`);
        await res.dispose();
      } catch (error) { report.coverage.warnings.push(`Could not verify link ${url}: ${error.message}`); }
    }
    report.status = report.coverage.warnings.length || report.coverage.skipped.length ? 'partial' : 'complete';
  } catch (error) {
    report.status = 'failed';
    report.error = `${error.message}\nIf Chromium is missing, run npm run setup or set CHROMIUM_PATH to its executable.`;
  } finally { await browser?.close(); }
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(['high', 'medium', 'low', 'info'].map(s => [s, report.findings.filter(f => f.severity === s).length]));
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(outDir, 'report.html'), renderReport(report));
  emit(`Scan ${report.status}. ${report.findings.length} findings.`);
  return report;
}
