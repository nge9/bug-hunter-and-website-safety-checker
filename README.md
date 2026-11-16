# SiteProbe · Bug Hunter & Website Safety Checker

Paste your website URL, run an inspection in a real Chromium browser, and get a report with findings, evidence, suggested fixes, and desktop/mobile screenshots. Every inspection is saved in local scan history.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run setup
npm start
```

Open **http://127.0.0.1:3210**, paste a URL beginning with `https://` or `http://`, choose a page limit, and select **Inspect website**.

If you already have Chromium installed, set `CHROMIUM_PATH` to its executable instead of downloading a browser. On Linux installations missing browser libraries, run `npx playwright install --with-deps chromium`.

## What it checks

| Check | Evidence in the report |
| --- | --- |
| Uncaught JavaScript errors | Error message and stack trace |
| Browser console errors | Console text and source location in JSON |
| Failed requests and HTTP errors | Resource URL, type, and status/failure |
| Broken internal links | HTTP failures encountered during crawling and bounded HEAD probes |
| Broken images | Image source URL |
| Accessibility | axe-core WCAG 2 A/AA and WCAG 2.1 AA automated results, selectors, markup, and guidance |
| Mobile and desktop layout | Horizontal overflow at 390×844 and 1440×900, with candidate elements |
| Basic security configuration | HTTP use, mixed resources, missing CSP, nosniff, and HTTPS HSTS headers |
| Page metadata | Empty titles and missing viewport metadata |

A missing security header is a hardening suggestion, **not a confirmed exploitable vulnerability**. Layout and accessibility findings may need manual review. Each page lists which checks completed, and accessibility checks needing manual review are counted.

## Reports and history

The interface records every accepted scan, including failed and interrupted scans. History survives restarts and includes the URL, time, status, page count, severity counts, and report links. Click **Refresh** to update it. Interrupted scans are marked when the server restarts.

Each inspection gets its own folder:

```text
reports/<scan-id>/
  scan.json              # History record
  report.html            # Full readable report; print to save as PDF
  report.json            # Machine-readable findings and coverage
  screenshots/
    page-1-desktop.png
    page-1-mobile.png
```

Reports remain on your computer. Screenshots capture the viewport, not the full document. Delete an inspection's folder to remove its history and evidence. `reports/` is excluded from Git. Review report URLs, screenshots, markup, and logs before sharing them; they can contain sensitive information.

## Command line

```bash
npm run scan -- https://your-site.com --pages 10
npm run scan -- http://localhost:3000 --pages 5 --out reports/my-scan
```

CLI scans also create history records. The web interface discovers CLI records inside this project's `reports/` folder. An output folder elsewhere is an independent report archive.

Exit codes: `0` = no high-severity findings, `1` = high-severity findings, `2` = scan failure or invalid input. A partial report can return 0 or 1: inspect `status` and coverage before drawing conclusions.

## Scope and limitations

- Scan only sites you own or have permission to test.
- Crawls public pages on the exact same origin, respects readable `robots.txt` rules, skips action-like paths and query-string links, and does not submit forms or click controls.
- Browser traffic permits GET, HEAD, and OPTIONS only. Page scripts can still make ordinary GET requests to third-party services. The crawler does not follow external page navigation or probe external links.
- Does not log in, test checkout flows, send exploit payloads, detect malware, or prove server-side security. GET requests can have side effects on badly designed websites, so use a staging site where possible.
- Apps needing POST requests to render may show failures or incomplete coverage. Auth walls, CSP, anti-bot measures, redirects, timing, and lazy loading can also limit coverage.
- Default limit: 10 pages and 100 candidate internal links. Maximum: 30 pages, 300 candidate links through the library API, and 1,000 discovered page URLs. Link checks use HEAD without following redirects; unsupported, protected, and redirect responses are reported as coverage warnings.
- Scans have a five-minute scheduling budget; the current page, request timeouts, and report writing may finish after that budget. Navigation timeout is 15 seconds. Checks observe pages shortly after DOMContentLoaded; this is not a performance benchmark.
- An automated scan cannot discover every bug or guarantee a secure or accessible website. Test business behavior and interactive flows separately.

The server binds to **127.0.0.1** and validates Host and cross-origin scan requests. It is intended as a personal local tool; do not expose it as a public scanning service. One scan runs at a time. Change the port with `PORT` and open the corresponding `http://127.0.0.1:<port>` URL.

## Development

```bash
npm ci
npm run setup
npm test
```

Tests run real Chromium against local fixtures. They verify seeded runtime, HTTP, image, accessibility and mobile issues; strict-CSP auditing; robots rules; escaped report contents; crawl boundaries; blocked writes; the paste-URL interface; and history persistence after restart. No external target is scanned by tests.

Stack: Node.js built-in HTTP server, Playwright, axe-core, robots-parser, and plain HTML/CSS/JavaScript. No API key or AI service is required. Fonts load from Google Fonts when available; system fonts are the offline fallback.

## License

MIT. See [LICENSE](LICENSE).
