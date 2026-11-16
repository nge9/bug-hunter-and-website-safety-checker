const $ = id => document.getElementById(id);
let report;
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
function findings() {
  $('findings').replaceChildren();
  const filter = $('severity').value;
  const sorted = [...report.findings].sort((a,b) => ['high','medium','low','info'].indexOf(a.severity) - ['high','medium','low','info'].indexOf(b.severity));
  for (const f of sorted.filter(f => filter === 'all' || f.severity === filter)) {
    const card = el('article', undefined, 'finding');
    card.append(el('span', `${f.severity} · ${f.category}`, `badge ${f.severity}`), el('h3', f.title), el('p', f.page), el('pre', f.evidence), el('p', `Suggested fix: ${f.fix}`));
    $('findings').append(card);
  }
  if (!$('findings').children.length) $('findings').append(el('p', 'No findings in this selection. See coverage for checks that were not completed.'));
}
function showReport(job) {
  report = job.report;
  if (!report) return;
  $('result-title').textContent = `${report.findings.length} findings across ${report.pages.length} pages`;
  $('summary').replaceChildren(...Object.entries(report.summary).map(([severity, count]) => { const n = el('div', undefined, 'metric'); n.append(el('strong', count), el('span', severity)); return n; }));
  $('downloads').replaceChildren();
  for (const [label, url] of [['Open full HTML report / save PDF', job.reportUrl], ['Download JSON', job.jsonUrl]]) {
    const a = el('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener'; if (url.endsWith('.json')) a.download = 'report.json'; $('downloads').append(a);
  }
  $('filters').hidden = false;
  $('severity').value = 'all';
  findings();
  $('coverage').hidden = false;
  $('coverage-body').replaceChildren();
  const list = el('ul');
  for (const text of [report.error, `Status: ${report.status}. Scanned ${report.pages.length} of ${report.coverage.discoveredPages} discovered pages. ${report.coverage.linksChecked} additional link probes.`, ...report.coverage.warnings, ...report.coverage.skipped.map(s => `Skipped ${s.url}: ${s.reason}`), ...report.limitations].filter(Boolean)) list.append(el('li', text));
  $('coverage-body').append(list);
}
$('severity').addEventListener('change', findings);
$('scan-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('submit').disabled = true;
  $('results').hidden = false;
  $('summary').replaceChildren(); $('findings').replaceChildren(); $('downloads').replaceChildren();
  $('filters').hidden = true; $('coverage').hidden = true;
  $('result-title').textContent = 'Scanning your website…'; $('state').textContent = 'RUNNING'; $('progress').textContent = 'Starting…';
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const response = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: $('url').value, maxPages: Number($('pages').value) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start scan.');
    await loadHistory();
    let failures = 0;
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      let res;
      try { res = await fetch(`/api/scan/${data.id}`); if (!res.ok) throw new Error('Could not load scan progress.'); failures = 0; }
      catch (error) { if (++failures >= 5) throw error; continue; }
      const job = await res.json();
      $('progress').textContent = job.message;
      $('state').textContent = job.state.toUpperCase();
      if (job.state !== 'running') { showReport(job); await loadHistory(); break; }
    }
  } catch (error) { $('progress').textContent = error.message; $('state').textContent = 'ERROR'; $('result-title').textContent = 'Inspection could not finish'; }
  finally { $('submit').disabled = false; }
});

async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error('Could not read scan history.');
    const records = await response.json();
    $('history-list').replaceChildren();
    for (const record of records) {
      const card = el('article', undefined, 'history-card');
      const top = el('div', undefined, 'history-top');
      top.append(el('strong', record.target), el('span', record.state, 'badge'));
      card.append(top, el('p', `${new Date(record.startedAt).toLocaleString()} · ${record.pages ?? 0} pages inspected`));
      if (record.summary) card.append(el('p', Object.entries(record.summary).map(([s,n]) => `${n} ${s}`).join(' · ')));
      if (record.state === 'failed' || record.state === 'interrupted') card.append(el('p', record.message));
      if (record.reportUrl) {
        const links = el('div', undefined, 'downloads');
        for (const [label,url] of [['View full report', record.reportUrl], ['JSON', record.jsonUrl]]) {
          const a = el('a', label); a.href = url; a.target = '_blank'; a.rel = 'noopener'; links.append(a);
        }
        card.append(links);
      }
      $('history-list').append(card);
    }
    if (!records.length) $('history-list').append(el('p', 'No scans yet. Your first inspection will appear here.', 'footnote'));
  } catch (error) { $('history-list').replaceChildren(el('p', error.message)); }
}
$('refresh-history').addEventListener('click', loadHistory);
loadHistory();
