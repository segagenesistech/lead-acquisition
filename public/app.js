const $app = document.getElementById('app');
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers }, body: opts.body && JSON.stringify(opts.body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const moneyShort = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`);
const fmt = (n) => Number(n).toLocaleString('en-US');
const healthColor = (h) => (h < 40 ? 'var(--risk)' : h < 65 ? 'var(--amber)' : 'var(--teal)');
const CAT_LABEL = { conversion: 'Conversion', security: 'Security', performance: 'Performance', maintenance: 'Maintenance', seo: 'SEO' };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

let meta;
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3500);
}

async function refreshQuota() {
  meta = await api('/api/meta');
  document.getElementById('quota').textContent = `${fmt(meta.auditsLeft)} audits left this month`;
}

/* ---------- New search ---------- */

const DEFAULT_FORM = { regions: ['US', 'AU', 'CA'], keywords: [], industries: [], signals: ['expired_ssl', 'domain_expiring', 'outdated_woo', 'broken_checkout'], domains: '' };

function renderSearch() {
  const form = { ...DEFAULT_FORM, ...store.get('lf:draft', {}) };
  const save = () => store.set('lf:draft', form);
  const providerReady = meta.provider.ready;

  $app.innerHTML = `
  <div class="search-grid">
    <section class="search-form">
      <h1>Find WooCommerce stores that need a rebuild</h1>
      <p class="lede">Scans public sites, detects WordPress and WooCommerce, then flags expired or neglected stores.</p>
      <div class="field"><span class="label" id="l-regions">Regions</span>
        <div class="chips" role="group" aria-labelledby="l-regions">${Object.entries(meta.regions).map(([k, r]) => `<button class="chip" data-region="${k}" aria-pressed="${form.regions.includes(k)}">${esc(r.label)}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="kw">Keywords</label>
        <div class="tag-input" id="tags"><input id="kw" placeholder="Add a product keyword, e.g. linen dresses" autocomplete="off"></div>
      </div>
      <div class="field"><span class="label" id="l-ind">E-commerce industry</span>
        <div class="chips" role="group" aria-labelledby="l-ind">${Object.entries(meta.industries).map(([k, i]) => `<button class="chip pill" data-industry="${k}" aria-pressed="${form.industries.includes(k)}">${esc(i.label)}</button>`).join('')}</div>
      </div>
      <div class="field"><span class="label">Rebuild signals</span>
        <div class="signals">${Object.entries(meta.signals).map(([k, s]) => `<label class="check"><input type="checkbox" data-signal="${k}" ${form.signals.includes(k) ? 'checked' : ''}> ${esc(s.label)}</label>`).join('')}</div>
      </div>
      <details class="import" ${form.domains || !providerReady ? 'open' : ''}>
        <summary>Or audit your own list of domains</summary>
        <textarea id="domains" placeholder="one domain per line&#10;lunaroots.com&#10;outbackherbals.com.au">${esc(form.domains)}</textarea>
      </details>
    </section>
    <aside class="scope">
      <span class="eyebrow">Scope</span>
      <div class="scope-number" id="est">—</div>
      <div class="scope-sub" id="est-sub">candidate stores matching</div>
      <div class="scope-lines" id="scope-lines"></div>
      ${providerReady ? '' : `<div class="notice">No search API key is set for “${esc(meta.provider.name)}”. Add one to <span class="mono">.env</span> to discover stores, or paste domains.</div>`}
      <div id="progress"></div>
      <div class="scope-actions">
        <button class="btn primary" id="start">Start scan</button>
        <button class="btn secondary" id="recurring">Save as recurring search</button>
      </div>
    </aside>
  </div>`;

  const tags = document.getElementById('tags');
  const kw = document.getElementById('kw');
  const drawTags = () => {
    tags.querySelectorAll('.tag').forEach((t) => t.remove());
    form.keywords.forEach((k, i) => kw.insertAdjacentHTML('beforebegin', `<span class="tag">${esc(k)}<button aria-label="Remove ${esc(k)}" data-rm="${i}">×</button></span>`));
  };
  drawTags();
  tags.addEventListener('click', (e) => {
    const i = e.target.dataset.rm;
    if (i !== undefined) { form.keywords.splice(Number(i), 1); drawTags(); changed(); } else kw.focus();
  });
  const addKeyword = () => {
    const v = kw.value.replace(/,/g, ' ').trim();
    if (v && !form.keywords.includes(v)) { form.keywords.push(v); drawTags(); changed(); }
    kw.value = '';
  };
  kw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addKeyword(); }
    if (e.key === 'Backspace' && !kw.value && form.keywords.length) { form.keywords.pop(); drawTags(); changed(); }
  });
  kw.addEventListener('blur', addKeyword);

  const toggle = (list, v) => (list.includes(v) ? list.splice(list.indexOf(v), 1) : list.push(v));
  $app.querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => { toggle(form.regions, b.dataset.region); b.setAttribute('aria-pressed', form.regions.includes(b.dataset.region)); changed(); }));
  $app.querySelectorAll('[data-industry]').forEach((b) => b.addEventListener('click', () => { toggle(form.industries, b.dataset.industry); b.setAttribute('aria-pressed', form.industries.includes(b.dataset.industry)); changed(); }));
  $app.querySelectorAll('[data-signal]').forEach((c) => c.addEventListener('change', () => { toggle(form.signals, c.dataset.signal); changed(); }));
  document.getElementById('domains').addEventListener('input', (e) => { form.domains = e.target.value; changed(); });

  const domainList = () => form.domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
  const payload = () => ({ regions: form.regions, keywords: form.keywords, industries: form.industries, signals: form.signals, domains: domainList() });
  let estTimer;
  function changed() {
    save();
    const n = (a, w) => `${a.length} ${w}${a.length === 1 ? '' : 's'}`;
    const d = domainList();
    document.getElementById('scope-lines').innerHTML = d.length
      ? `${n(d, 'imported domain')}<br>${n(form.signals, 'rebuild signal')}<br>Full audit of top ${fmt(Math.min(meta.auditsPerScan, d.length))} by revenue risk`
      : `${n(form.regions, 'region')} · ${n(form.keywords, 'keyword')} · ${form.industries.length} ${form.industries.length === 1 ? 'industry' : 'industries'}<br>${n(form.signals, 'rebuild signal')}<br>Full audit of top ${fmt(meta.auditsPerScan)} by revenue risk`;
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      try {
        const e = await api('/api/estimate', { method: 'POST', body: payload() });
        document.getElementById('est').textContent = e.candidates ? `~${fmt(e.candidates)}` : '—';
        document.getElementById('est-sub').textContent = d.length ? 'domains to check' : e.queries ? `candidate stores matching · ${e.queries} search queries` : 'add keywords or industries';
      } catch { /* estimate is best-effort */ }
    }, 300);
  }
  changed();

  const submit = async (recurring) => {
    try {
      const s = await api('/api/searches', { method: 'POST', body: { ...payload(), recurring } });
      store.set('lf:activeSearch', s.id);
      toast(recurring ? 'Saved — re-runs weekly. First scan started.' : 'Scan started');
      watchProgress(s.id);
    } catch (e) { toast(e.message); }
  };
  document.getElementById('start').addEventListener('click', () => submit(false));
  document.getElementById('recurring').addEventListener('click', () => submit(true));
  const active = store.get('lf:activeSearch');
  if (active) watchProgress(active);
}

function progressHtml(s) {
  const p = s.scan?.progress || {};
  const st = s.scan?.status;
  const pct = p.phase === 'done' ? 100 : p.phase === 'auditing' ? 50 + 50 * ((p.audited + p.reused) / Math.max(1, Math.min(meta.auditsPerScan, p.woocommerce))) : p.queries ? 50 * (p.queriesDone / p.queries) : p.candidates ? 50 * (p.checked / p.candidates) : 5;
  const label = st === 'failed' ? 'Scan failed' : p.phase === 'done' ? 'Scan complete' : p.phase === 'auditing' ? 'Auditing stores…' : 'Discovering stores…';
  return `<div class="progress">
    <strong>${label}</strong> <span class="muted">· ${esc(s.name)}</span>
    <div class="bar"><i style="width:${Math.min(100, pct).toFixed(0)}%"></i></div>
    ${st === 'failed' ? `<div class="notice">${esc(s.scan.error)}</div>` : ''}
    <dl>
      <dt>Candidates found</dt><dd>${fmt(p.candidates || 0)}</dd>
      <dt>Checked</dt><dd>${fmt(p.checked || 0)}</dd>
      <dt>WooCommerce in region</dt><dd>${fmt(p.woocommerce || 0)}</dd>
      <dt>Audited</dt><dd>${fmt((p.audited || 0) + (p.reused || 0))}</dd>
      <dt>Qualified leads</dt><dd>${fmt(p.qualified || 0)}</dd>
    </dl>
    ${p.quotaReached ? '<div class="notice">Monthly audit quota reached; remaining stores were not audited.</div>' : ''}
    ${p.searchErrors ? `<div class="notice">${fmt(p.searchErrors)} search call${p.searchErrors > 1 ? 's' : ''} failed. ${esc(p.lastSearchError || '')}</div>` : ''}
    ${p.phase === 'done' && !p.candidates ? `<div class="notice">${p.searchResults
      ? `The search returned ${fmt(p.searchResults)} results, but all were marketplaces or excluded sites.`
      : 'The search returned no websites.'} Use short product keywords such as “linen dresses”; pick the country with the region buttons.</div>` : ''}
    ${p.emptyQueries?.length ? `<details class="empty-queries"><summary>${fmt(p.emptyQueries.length)} search${p.emptyQueries.length > 1 ? 'es' : ''} found nothing</summary>${p.emptyQueries.map((q) => `<div class="mono">${esc(q)}</div>`).join('')}</details>` : ''}
    ${skippedHtml(p.skipped)}
    <p><a class="btn small" href="#/leads/${s.id}">View leads →</a> ${s.scan ? `<a class="btn small" href="#/scan/${s.scan.id}">Scan log</a>` : ''}</p>
  </div>`;
}

const OUTCOME_LABEL = {
  qualified: 'Qualified lead', healthy: 'Audited, no rebuild signal', woocommerce: 'WooCommerce found', 'not-audited': 'Not audited',
  blocked: 'Blocked by bot protection', unreachable: 'Unreachable', parked: 'Parked domain', 'server-error': 'Server error',
  'not-wordpress': 'Not WordPress', 'no-woocommerce': 'WordPress, no WooCommerce', 'out-of-region': 'Outside selected regions', error: 'Check crashed',
};

function skippedHtml(skipped = {}) {
  const entries = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return `<p class="muted" style="margin:14px 0 6px">Skipped</p><dl>${entries.map(([k, n]) => `<dt>${esc(OUTCOME_LABEL[k] || k)}</dt><dd>${fmt(n)}</dd>`).join('')}</dl>`;
}

async function renderScanLog(id) {
  const { scan, candidates } = await api(`/api/scans/${id}/candidates`);
  const p = scan.progress;
  $app.innerHTML = `<div class="page">
    <div class="page-head"><div class="crumbs"><a href="#/leads/${scan.searchId}">${esc(scan.name)}</a> / Scan log</div>
      <span class="status ${esc(scan.status)}">${esc(scan.status)}</span></div>
    ${scan.error ? `<div class="notice" style="margin-bottom:14px">${esc(scan.error)}</div>` : ''}
    ${p.emptyQueries?.length ? `<div class="notice" style="margin-bottom:14px">These searches found nothing:${p.emptyQueries.map((q) => `<div class="mono">${esc(q)}</div>`).join('')}</div>` : ''}
    ${p.searchErrors ? `<div class="notice" style="margin-bottom:14px">${fmt(p.searchErrors)} search calls failed. ${esc(p.lastSearchError || '')}</div>` : ''}
    <p class="muted">${p.queries ? `${fmt(p.queriesDone || 0)}/${fmt(p.queries)} search queries · ` : ''}${fmt(p.candidates || 0)} websites found · ${fmt(p.checked || 0)} checked · ${fmt(p.woocommerce || 0)} WooCommerce in region · ${fmt((p.audited || 0) + (p.reused || 0))} audited</p>
    ${candidates.length ? `<table class="table"><thead><tr><th>Website</th><th>Outcome</th><th>Detail</th><th>Region</th></tr></thead><tbody>
      ${candidates.map((c) => `<tr ${c.auditId ? `data-href="#/audit/${c.auditId}"` : ''}><td class="store-name">${esc(c.domain)}</td><td>${esc(OUTCOME_LABEL[c.outcome] || c.outcome)}</td>
        <td class="muted">${esc(c.reason || '')}</td><td>${esc(c.region || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty"><strong>No websites were checked</strong>The search returned nothing, or the scan stopped before checking any site. See the message above.</div>'}
  </div>`;
  $app.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

function watchProgress(searchId) {
  clearTimers();
  const tick = async () => {
    const el = document.getElementById('progress');
    if (!el) return clearTimers();
    try {
      const s = await api(`/api/searches/${searchId}`);
      el.innerHTML = progressHtml(s);
      if (s.scan?.status === 'done' || s.scan?.status === 'failed') { clearTimers(); refreshQuota(); }
    } catch { clearTimers(); store.set('lf:activeSearch', null); }
  };
  tick();
  timers.push(setInterval(tick, 2000));
}

/* ---------- Leads ---------- */

async function renderLeads(id) {
  const searches = await api('/api/searches');
  if (!searches.length) {
    $app.innerHTML = `<div class="page"><div class="empty"><strong>No searches yet</strong>Run a scan to collect leads.<p><a class="btn primary" href="#/">New search</a></p></div></div>`;
    return;
  }
  const search = searches.find((s) => String(s.id) === String(id)) || searches[0];
  const q = store.get(`lf:filters:${search.id}`, { region: '', signal: '', risk: '' });
  const qs = () => new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const running = search.scan && !['done', 'failed'].includes(search.scan.status);

  const sel = (key, label, options) => `<select data-filter="${key}" aria-label="${label}"><option value="">${label}: ${key === 'risk' ? 'Any' : key === 'region' ? 'All' : 'Any'}</option>${options.map(([v, l]) => `<option value="${v}" ${q[key] === v ? 'selected' : ''}>${label}: ${esc(l)}</option>`).join('')}</select>`;

  $app.innerHTML = `<div class="page">
    <div class="page-head">
      <h1>${esc(search.name)}</h1><span class="count" id="count"></span>
      ${running ? '<span class="status running">Scanning…</span>' : ''}
      <div class="actions">
        ${searches.length > 1 ? `<select class="search-switch filters-select" id="switch" aria-label="Search">${searches.map((s) => `<option value="${s.id}" ${s.id === search.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
        <a class="btn primary small" id="csv" href="#">Export CSV</a>
      </div>
    </div>
    <div class="filters">
      ${sel('region', 'Region', Object.entries(meta.regions).map(([k]) => [k, k]))}
      ${sel('signal', 'Signal', Object.entries(meta.signals).map(([k, s]) => [k, s.label]))}
      ${sel('risk', 'Risk', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}
      <span class="sort">Sorted by est. monthly revenue at risk</span>
    </div>
    <div id="rows"></div>
  </div>`;

  const sw = document.getElementById('switch');
  if (sw) sw.addEventListener('change', () => { location.hash = `#/leads/${sw.value}`; });
  $app.querySelectorAll('[data-filter]').forEach((s) => s.addEventListener('change', () => { q[s.dataset.filter] = s.value; store.set(`lf:filters:${search.id}`, q); draw(); }));

  async function draw() {
    const rows = await api(`/api/searches/${search.id}/leads?${qs()}`);
    document.getElementById('csv').href = `/api/searches/${search.id}/leads.csv?${qs()}`;
    document.getElementById('count').textContent = `${fmt(rows.length)} qualified lead${rows.length === 1 ? '' : 's'}`;
    const el = document.getElementById('rows');
    if (!rows.length) {
      const why = search.scan && !running ? ` <a href="#/scan/${search.scan.id}">Open the scan log</a> to see why each website was skipped.` : '';
      el.innerHTML = `<div class="empty"><strong>${running ? 'Scan in progress' : 'No leads match'}</strong>${running ? 'Qualified stores appear here as audits finish.' : `Try loosening the filters or the rebuild signals.${why}`}
        ${search.scan?.error ? `<div class="notice">${esc(search.scan.error)}</div>` : ''}</div>`;
      return;
    }
    el.innerHTML = `<table class="table leads">
      <thead><tr><th>Store</th><th>Region</th><th>Main signal</th><th>Health</th><th class="num">Revenue at risk</th></tr></thead>
      <tbody>${rows.map((l) => `<tr data-href="#/audit/${l.auditId}">
        <td><a class="store-name" href="#/audit/${l.auditId}">${esc(l.domain)}</a><div class="store-sub">${esc(l.industryLabel || '')}</div></td>
        <td>${esc(l.region || '—')}</td>
        <td><span class="signal ${l.health >= 40 ? 'amber' : ''}">${esc(l.mainSignal || '—')}</span></td>
        <td><div class="health"><span class="track"><i style="width:${l.health}%;background:${healthColor(l.health)}"></i></span>${l.health}</div></td>
        <td class="num risk">${moneyShort(l.revenueAtRisk)}</td></tr>`).join('')}</tbody></table>
      <div class="lead-cards">${rows.map((l) => `<a class="lead-card" href="#/audit/${l.auditId}">
        <span class="store-name">${esc(l.domain)}</span><span class="risk">${moneyShort(l.revenueAtRisk)}</span>
        <span class="store-sub">${esc(l.region || '')} · ${esc(l.industryLabel || '')}</span><span></span>
        <span class="signal ${l.health >= 40 ? 'amber' : ''}">${esc(l.mainSignal || '')}</span></a>`).join('')}</div>`;
    el.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') location.hash = tr.dataset.href; }));
  }
  await draw();
  if (running) timers.push(setInterval(async () => {
    const s = await api(`/api/searches/${search.id}`);
    await draw();
    if (['done', 'failed'].includes(s.scan?.status)) { clearTimers(); renderLeads(search.id); }
  }, 4000));
}

/* ---------- Audit ---------- */

async function renderAudit(id) {
  const a = await api(`/api/audits/${id}`);
  const f = a.facts;
  const m = f.model || {};
  const fact = (label, value, sub) => `<div class="fact"><span class="eyebrow">${label}</span><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const days = (iso) => (iso ? Math.round((new Date(iso) - Date.now()) / 864e5) : null);
  const sslDays = days(f.ssl?.validTo);
  const domDays = days(f.domain_registration?.expiresAt);
  const v = f.versions || {};

  $app.innerHTML = `<div class="page">
    <div class="page-head">
      <div class="crumbs"><a href="#/leads">Leads</a> / ${esc(a.domain)} / Audit</div>
      <div class="actions no-print">
        <a class="btn small" href="https://${esc(a.domain)}" target="_blank" rel="noopener noreferrer">Visit site</a>
        <button class="btn small" id="pdf">Download PDF</button>
      </div>
    </div>
    <div class="audit-head">
      <div>
        <span class="eyebrow">Estimated revenue at risk</span>
        <div class="big">${money(a.revenueAtRisk)} <small>/ month</small></div>
        <p class="model-note">Modelled from estimated traffic (${fmt(m.visits || 0)} visits/mo, ${m.visitsSource === 'tranco' ? 'Tranco rank' : 'catalogue size'}), ${((m.conversion || 0) * 100).toFixed(1)}% industry conversion and ${money(m.aov || 0)} order value, applied to the issues below. Treat as a range, not a measurement.</p>
      </div>
      <div class="cats">${Object.entries(a.categories).map(([k, n]) => `<span>${CAT_LABEL[k]}</span><span class="track"><i style="width:${n}%;background:${healthColor(n)}"></i></span><span class="n">${n}</span>`).join('')}</div>
    </div>
    ${a.findings.length ? `<div class="findings">${a.findings.map((x, i) => `<div class="finding">
      <span class="idx">${String(i + 1).padStart(2, '0')}</span>
      <div class="main"><div class="t">${esc(x.title)}</div><div class="d">${esc(x.detail)}</div></div>
      <span class="cat">${CAT_LABEL[x.category]}<span class="sev-inline"> · ${x.severity[0].toUpperCase() + x.severity.slice(1)}</span></span>
      <span class="badge-cell"><span class="badge ${x.severity}">${x.severity[0].toUpperCase() + x.severity.slice(1)}</span></span>
      <span class="amt risk">${money(x.revenue)}</span></div>`).join('')}</div>` : '<div class="empty"><strong>No issues found</strong>This store looks healthy.</div>'}
    <h2 class="section">What we checked</h2>
    <div class="facts">
      ${fact('Status', esc(f.status === 'offline' ? 'Offline' : f.status === 'erroring' ? 'Erroring' : 'Live'), f.archived ? `Archived copy: <a href="${esc(f.archived.url)}" target="_blank" rel="noopener">${esc(f.archived.timestamp.slice(0, 8))}</a>` : esc(f.origin || ''))}
      ${fact('Region · industry', `${esc(a.region || '—')} · ${esc(a.industryLabel || '—')}`, `Health score ${a.health}/100`)}
      ${fact('SSL certificate', f.ssl ? (f.ssl.reachable ? (sslDays < 0 ? `Expired ${-sslDays}d ago` : `Valid · ${sslDays}d left`) : 'No HTTPS') : '—', esc(f.ssl?.issuer || f.ssl?.error || ''))}
      ${fact('Domain', f.domain_registration ? (f.domain_registration.registered === false ? 'Not registered' : domDays != null ? (domDays < 0 ? `Expired ${-domDays}d ago` : `Expires in ${domDays}d`) : 'Registered') : 'RDAP unavailable', f.domain_registration?.expiresAt?.slice(0, 10) || '')}
      ${fact('WooCommerce', esc(v.woocommerce || 'version hidden'), v.woocommerceLatest ? `Latest ${esc(v.woocommerceLatest)}${v.woocommerceReleasesBehind != null ? ` · ${v.woocommerceReleasesBehind} releases behind` : ''}` : '')}
      ${fact('WordPress', esc(v.wordpress || 'version hidden'), v.wordpressLatest ? `Latest ${esc(v.wordpressLatest)}` : '')}
      ${fact('Theme', esc(f.theme?.name || '—'), f.theme ? (f.theme.lastUpdated ? `Last updated ${esc(f.theme.lastUpdated.slice(0, 10))}` : f.theme.onWordPressOrg ? '' : 'Custom or premium theme') : '')}
      ${fact('Plugins', f.plugins ? `${f.plugins.length} detected` : '—', f.plugins ? `${f.plugins.filter((p) => p.outdated).length} outdated · ${f.plugins.filter((p) => p.vulnerabilities?.length).length} vulnerable` : '')}
      ${fact('Checkout test', esc(f.checkout?.verdict || '—'), esc(f.checkout?.note || (f.checkout?.paymentMethods ? `Gateways: ${f.checkout.paymentMethods.join(', ')}` : '')))}
      ${fact('Mobile performance', f.performance?.lcpMs ? `LCP ${(f.performance.lcpMs / 1000).toFixed(1)}s` : f.performance?.ttfbMs ? `TTFB ${(f.performance.ttfbMs / 1000).toFixed(1)}s` : '—', f.performance?.source === 'pagespeed' ? `PageSpeed score ${f.performance.score ?? '—'}` : 'PageSpeed unavailable')}
      ${fact('Catalogue', f.store?.productCount ? `${fmt(f.store.productCount)} products` : '—', f.store?.medianPrice ? `Median price ${f.store.medianPrice} ${esc(f.store.currency || '')}` : '')}
      ${fact('Audited', esc(a.createdAt.slice(0, 16).replace('T', ' ')), 'UTC')}
    </div>
  </div>`;
  document.getElementById('pdf').addEventListener('click', () => {
    const t = document.title;
    document.title = `${a.domain} audit`;
    window.print();
    document.title = t;
  });
}

/* ---------- Audits & exports ---------- */

async function renderAudits() {
  const rows = await api('/api/audits');
  $app.innerHTML = `<div class="page"><div class="page-head"><h1>Audits</h1><span class="count">${fmt(rows.length)} most recent</span></div>
    ${rows.length ? `<table class="table"><thead><tr><th>Store</th><th>Region</th><th>Main signal</th><th>Health</th><th>Audited</th><th class="num">Revenue at risk</th></tr></thead><tbody>
    ${rows.map((l) => `<tr data-href="#/audit/${l.auditId}"><td><a class="store-name" href="#/audit/${l.auditId}">${esc(l.domain)}</a><div class="store-sub">${esc(l.industryLabel || '')}</div></td><td>${esc(l.region || '—')}</td>
      <td><span class="signal ${l.health >= 40 ? 'amber' : ''}">${esc(l.mainSignal || 'No issues')}</span></td><td><div class="health"><span class="track"><i style="width:${l.health}%;background:${healthColor(l.health)}"></i></span>${l.health}</div></td>
      <td class="muted">${esc(l.auditedAt.slice(0, 10))}</td><td class="num risk">${moneyShort(l.revenueAtRisk)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><strong>No audits yet</strong>Audits appear here once a scan runs.</div>'}</div>`;
  $app.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
}

async function renderExports() {
  const searches = await api('/api/searches');
  $app.innerHTML = `<div class="page"><div class="page-head"><h1>Exports</h1><span class="count">Saved searches and CSV downloads</span></div>
    ${searches.length ? `<div class="searches">${searches.map((s) => `<div class="search-row">
      <div><h3><a href="#/leads/${s.id}">${esc(s.name)}</a></h3><div class="store-sub">${fmt(s.qualified)} qualified · last run ${esc(s.lastRunAt?.slice(0, 16) || 'never')} UTC
        ${s.scan ? ` · <span class="status ${s.scan.status}">${esc(s.scan.status)}</span>` : ''}</div></div>
      <label class="switch"><input type="checkbox" data-recurring="${s.id}" ${s.recurring ? 'checked' : ''}> Weekly</label>
      <span>${s.scan ? `<a class="btn small" href="#/scan/${s.scan.id}">Log</a> ` : ''}<button class="btn small" data-run="${s.id}">Re-run</button></span>
      <a class="btn small primary" href="/api/searches/${s.id}/leads.csv">CSV</a>
    </div>`).join('')}</div>` : '<div class="empty"><strong>Nothing to export yet</strong>Run a search first.</div>'}</div>`;
  $app.querySelectorAll('[data-recurring]').forEach((c) => c.addEventListener('change', async () => {
    await api(`/api/searches/${c.dataset.recurring}`, { method: 'PATCH', body: { recurring: c.checked } });
    toast(c.checked ? 'Will re-run weekly' : 'Recurring run turned off');
  }));
  $app.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/searches/${b.dataset.run}/run`, { method: 'POST' });
    toast('Scan started');
    renderExports();
  }));
}

/* ---------- Router ---------- */

async function route() {
  clearTimers();
  if (!meta) await refreshQuota();
  const [, view = '', id] = location.hash.replace(/^#/, '').split('/');
  const nav = { '': 'search', leads: 'leads', scan: 'leads', audit: 'audits', audits: 'audits', exports: 'exports' }[view] || 'search';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  window.scrollTo(0, 0);
  try {
    if (view === 'leads') await renderLeads(id);
    else if (view === 'scan') await renderScanLog(id);
    else if (view === 'audit') await renderAudit(id);
    else if (view === 'audits') await renderAudits();
    else if (view === 'exports') await renderExports();
    else renderSearch();
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="empty"><strong>Something went wrong</strong>${esc(e.message)}</div></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
