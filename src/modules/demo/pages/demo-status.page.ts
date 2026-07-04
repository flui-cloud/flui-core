export const DEMO_STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Flui — the app that lives on two clouds</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b0e14; color: #e6e9ef;
  }
  header { padding: 28px 24px 12px; }
  h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: #8b93a7; margin-top: 4px; font-size: 13px; }
  main { padding: 12px 24px 48px; max-width: 1000px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .card {
    background: #131722; border: 1px solid #212636; border-radius: 12px; padding: 16px 18px;
  }
  .label { color: #8b93a7; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .value { font-size: 26px; font-weight: 650; margin-top: 6px; letter-spacing: -0.02em; }
  .value.small { font-size: 18px; }
  .ok { color: #3ecf8e; } .bad { color: #f26d6d; } .warn { color: #f2c14e; } .muted { color: #8b93a7; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 13px; font-weight: 600;
    background: #1c2333; border: 1px solid #2a3350;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.live { background: #3ecf8e; box-shadow: 0 0 0 0 rgba(62,207,142,.6); animation: pulse 1.6s infinite; }
  .dot.idle { background: #8b93a7; }
  .dot.mig { background: #f2c14e; }
  .dot.fail { background: #f26d6d; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(62,207,142,.5)} 70%{box-shadow:0 0 0 8px rgba(62,207,142,0)} 100%{box-shadow:0 0 0 0 rgba(62,207,142,0)} }
  #log {
    margin-top: 16px; background: #0d1017; border: 1px solid #212636; border-radius: 12px;
    padding: 12px 14px; height: 260px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; line-height: 1.7;
  }
  #log .t { color: #5b6478; }
  #log .e { color: #7aa2f7; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #8b93a7; margin: 24px 0 8px; }
  code { background: #1c2333; padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<header>
  <h1>The app that lives on two clouds</h1>
  <div class="sub">A single app, migrated back and forth between two cloud providers on a loop — live. This page is served by the Flui master, which never moves.</div>
  <div class="row">
    <span id="stateDot" class="dot idle"></span>
    <span id="stateText" class="badge">connecting…</span>
    <span id="providerBadge" class="badge muted">provider —</span>
    <span id="ipBadge" class="badge muted">ip —</span>
  </div>
</header>
<main>
  <div class="grid">
    <div class="card"><div class="label">Requests served</div><div id="served" class="value ok">—</div></div>
    <div class="card"><div class="label">Lost during migration</div><div id="lost" class="value">—</div></div>
    <div class="card"><div class="label">Success rate</div><div id="rate" class="value">—</div></div>
    <div class="card"><div class="label">Migrations completed</div><div id="cycles" class="value">—</div></div>
    <div class="card"><div class="label">Last migration</div><div id="lastMig" class="value small muted">—</div></div>
    <div class="card"><div class="label">Active migration</div><div id="active" class="value small muted">—</div></div>
  </div>
  <h2>Live event feed</h2>
  <div id="log"></div>
</main>
<script>
  var BASE = location.pathname.replace(/\\/+$/, '');
  var logEl = document.getElementById('log');
  function log(ev, data) {
    var line = document.createElement('div');
    var t = new Date().toLocaleTimeString();
    line.innerHTML = '<span class="t">' + t + '</span> <span class="e">' + ev + '</span> ' +
      (data ? escapeHtml(typeof data === 'string' ? data : JSON.stringify(data)) : '');
    logEl.appendChild(line);
    while (logEl.childNodes.length > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function escapeHtml(s){return s.replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function fmtDur(ms){ if(ms==null) return '—'; var s=Math.round(ms/1000); if(s<90) return s+'s'; return Math.round(s/60)+'m '+(s%60)+'s'; }

  function paint(s) {
    var dot = document.getElementById('stateDot');
    var st = document.getElementById('stateText');
    st.textContent = s.enabled ? s.state : 'disabled';
    dot.className = 'dot ' + (!s.enabled ? 'idle' : s.state === 'migrating' ? 'mig' : s.state === 'failed' ? 'fail' : s.windowOpen ? 'mig' : 'live');
    document.getElementById('providerBadge').textContent = 'provider ' + (s.current.provider || '—');
    document.getElementById('ipBadge').textContent = 'ip ' + (s.current.ip || '—');
    document.getElementById('served').textContent = (s.counters.served || 0).toLocaleString();
    var lost = s.counters.lostDuringMigration || 0;
    var lostEl = document.getElementById('lost');
    lostEl.textContent = lost.toLocaleString();
    lostEl.className = 'value ' + (lost === 0 ? 'ok' : 'bad');
    document.getElementById('rate').textContent = s.counters.successRatePct == null ? '—' : s.counters.successRatePct + '%';
    document.getElementById('cycles').textContent = (s.cycleCount || 0).toLocaleString();
    document.getElementById('lastMig').textContent = s.lastCycleAt ? (fmtDur(s.lastCycleDurationMs) + ' · ' + new Date(s.lastCycleAt).toLocaleTimeString()) : '—';
    document.getElementById('active').textContent = s.activeMigration ? (s.activeMigration.status || 'running') : '—';
  }
  function refresh() {
    fetch(BASE + '/status').then(function(r){return r.json();}).then(paint).catch(function(){});
  }
  refresh();
  setInterval(refresh, 4000);
  try {
    var es = new EventSource(BASE + '/events');
    es.onmessage = function(m) {
      try { var p = JSON.parse(m.data); log(p.type || 'event', p.data); if (p.type !== 'heartbeat') refresh(); }
      catch (e) { log('event', m.data); }
    };
    es.onerror = function(){ /* browser auto-reconnects */ };
  } catch (e) {}
</script>
</body>
</html>`;
