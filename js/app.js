import { WebSerialTransport } from './transport/webserial.js';
import { WebUsbFtdiTransport } from './transport/webusb-ftdi.js';
import { SimulatorTransport } from './transport/simulator.js';
import { KLine } from './kline.js';
import { testCable } from './cabletest.js';
import { OBD } from './obd.js';
import { PIDS, BOOST, GAUGE_DEFAULTS, OBD_STANDARDS, pidLabel } from './pids.js';
import { describeDtc } from './dtc-codes.js';
import { hex, sleep } from './util.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(`r53scan:${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`r53scan:${k}`, JSON.stringify(v)); } catch {} },
};

const TRANSPORTS = [
  { id: 'webserial', label: 'USB cable — Web Serial (Chrome/Edge on a computer)', cls: WebSerialTransport },
  { id: 'webusb', label: 'USB OTG — WebUSB (Chrome on Android)', cls: WebUsbFtdiTransport },
  { id: 'sim', label: 'Simulator (no car needed)', cls: SimulatorTransport },
];

const S = {
  transport: null, kline: null, obd: null,
  supported: new Set(),
  live: false, busy: false,
  selected: new Set(store.get('gauges', GAUGE_DEFAULTS)),
  hist: new Map(), stats: new Map(),
  rec: null,
};

// ---------------------------------------------------------------- log
const logLines = [];
function log(kind, msg) {
  const line = `${new Date().toISOString().slice(11, 23)}  ${kind.toUpperCase().padEnd(5)} ${msg}`;
  logLines.push(line);
  if (logLines.length > 5000) logLines.splice(0, 1000);
  const box = $('log');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.append(el('div', `l-${kind}`, line));
  while (box.childElementCount > 2000) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- status/UI state
function setStatus(state, text) {
  $('status').dataset.state = state;
  $('statusText').textContent = text;
}
function hint(text) { $('hint').textContent = text || ''; }

function refreshButtons() {
  const on = !!S.kline?.connected;
  $('connectBtn').textContent = S.transport ? 'Disconnect' : 'Connect';
  $('connectBtn').classList.toggle('primary', !S.transport);
  $('connectBtn').disabled = S.busy && !S.transport;
  $('testBtn').disabled = S.busy || !!S.transport;
  for (const id of ['liveBtn', 'pickBtn', 'recBtn', 'readCodesBtn', 'freezeBtn', 'clearBtn']) $(id).disabled = !on;
  $('liveBtn').textContent = S.live ? 'Stop' : 'Start';
  $('liveBtn').classList.toggle('on', S.live);
  $('recBtn').textContent = S.rec ? `Stop & save (${S.rec.length})` : 'Record';
  $('recBtn').classList.toggle('on', !!S.rec);
  for (const id of ['transport', 'protocol', 'dtr', 'rts', 'interByte', 'idle', 'simProto']) $(id).disabled = !!S.transport;
}

// ---------------------------------------------------------------- connect / disconnect
async function connect() {
  const def = TRANSPORTS.find((t) => t.id === $('transport').value);
  const opts = {
    dtr: $('dtr').checked, rts: $('rts').checked,
    interByteMs: +$('interByte').value || 0, idleMs: +$('idle').value || 60,
  };
  store.set('settings', { transport: def.id, protocol: $('protocol').value, ...opts, simProto: $('simProto').value });
  S.busy = true;
  hint('');
  setStatus('busy', 'Opening port…');
  let t;
  try {
    t = def.id === 'sim' ? new SimulatorTransport({ protocol: $('simProto').value }) : new def.cls();
    t.onError = (e) => log('error', `Transport: ${e.message}`);
    t.onNote = (m) => log('info', m);
    await t.open({ baud: 10400, dtr: opts.dtr, rts: opts.rts });
    S.transport = t;
    refreshButtons();
    log('info', `Opened ${t.name} at 10400 baud (DTR ${opts.dtr ? 'on' : 'off'}, RTS ${opts.rts ? 'on' : 'off'})`);
    setStatus('busy', 'Waking the ECU…');
    hint('Ignition must be ON (engine can be running). The 5-baud wake-up takes a few seconds.');
    const k = new KLine(t, { log, interByteMs: opts.interByteMs, idleMs: opts.idleMs });
    k.onLost = () => { hint('Connection lost. Check the cable and ignition, then reconnect.'); disconnect(true); };
    const info = await k.connect($('protocol').value);
    S.kline = k;
    S.obd = new OBD(k);
    log('info', `Connected using ${info.label} (key bytes ${hex(info.keyBytes)})`);
    setStatus('on', info.label);
    hint('');
    S.busy = false;
    refreshButtons();
    await afterConnect(info);
  } catch (e) {
    S.busy = false;
    const msg = e.name === 'NotFoundError' ? 'No device selected.' : e.message;
    log('error', msg);
    setStatus('err', 'Not connected');
    hint(troubleshoot(e, def.id));
    await disconnect(true);
  }
}

function troubleshoot(e, tid) {
  if (e.name === 'NotFoundError') return 'No device selected. Plug in the cable and pick it from the list (FT232R USB UART).';
  if (e.name === 'SecurityError' || e.name === 'NetworkError') {
    return tid === 'webusb'
      ? 'The browser could not claim the USB device. On a computer use the Web Serial option instead; on Android make sure no other app is using the cable.'
      : 'The port is busy or blocked. Close other apps using the cable (INPA, other tabs) and try again.';
  }
  if (/echo/i.test(e.message)) return e.message;
  if (/wake|answer|sync/i.test(e.message)) {
    return 'The ECU did not answer. Check: ignition ON, cable fully seated, the cable switch in the pre-2007 position (pins 7+8 bridged; try the other position too), then try toggling DTR/RTS under Advanced. Raw bytes are in the Log tab.';
  }
  return '';
}

async function runCableTest() {
  const def = TRANSPORTS.find((t) => t.id === $('transport').value);
  S.busy = true;
  refreshButtons();
  hint('');
  setStatus('busy', 'Testing cable…');
  const t = def.id === 'sim' ? new SimulatorTransport({ protocol: $('simProto').value }) : new def.cls();
  try {
    t.onError = (e) => log('error', `Transport: ${e.message}`);
    t.onNote = (m) => log('info', m);
    await t.open({ baud: 10400, dtr: false, rts: false });
    log('info', `Opened ${t.name} at 10400 baud for the cable test`);
    const r = await testCable(t, log);
    if (r.working.length === 1) {
      $('dtr').checked = r.working[0].dtr;
      $('rts').checked = r.working[0].rts;
    }
    setStatus(r.working.length && r.afterBreak ? 'off' : 'err', r.working.length && r.afterBreak ? 'Cable OK' : 'Cable problem');
    hint(r.verdict);
  } catch (e) {
    const msg = e.name === 'NotFoundError' ? 'No device selected.' : e.message;
    log('error', `Cable test: ${msg}`);
    setStatus('err', 'Not connected');
    hint(troubleshoot(e, def.id) || msg);
  } finally {
    try { await t.close(); } catch {}
    S.busy = false;
    refreshButtons();
  }
}

async function disconnect(quiet = false) {
  S.live = false;
  S.kline?.close();
  try { await S.transport?.close(); } catch {}
  if (S.transport && !quiet) log('info', 'Disconnected');
  S.transport = S.kline = S.obd = null;
  if ($('status').dataset.state !== 'err') setStatus('off', 'Disconnected');
  for (const t of document.querySelectorAll('.tile')) t.classList.add('stale');
  refreshButtons();
}

async function afterConnect(info) {
  const obd = S.obd;
  setStatus('busy', 'Reading capabilities…');
  S.supported = await obd.supportedPids();
  log('info', `Supported PIDs: ${[...S.supported].map((p) => p.toString(16).padStart(2, '0')).join(' ')}`);
  if (S.supported.has(0x0b)) {
    const how = await obd.calibrateBaro(S.supported);
    log('info', `Barometric pressure ${obd.baro.toFixed(0)} kPa (${how}) — used for boost`);
  }
  setStatus('on', info.label);
  await refreshInfo(info);
  buildPicker();
  buildTiles();
  $('liveEmpty').hidden = true;
  if (S.supported.has(0x01)) {
    try { renderMil(await obd.monitorStatus()); } catch (e) { log('warn', e.message); }
  }
  startLive();
}

// ---------------------------------------------------------------- live data
const usable = (pid) => (PIDS[pid]?.virtual ? S.supported.has(PIDS[pid].needs) : S.supported.has(pid));
const shown = () => [...S.selected].filter((p) => PIDS[p] && usable(p));

function buildPicker() {
  const box = $('picker');
  box.replaceChildren();
  const pids = Object.keys(PIDS).map(Number).filter(usable);
  for (const pid of pids) {
    const lab = el('label', 'check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = S.selected.has(pid);
    cb.onchange = () => {
      if (cb.checked) S.selected.add(pid); else S.selected.delete(pid);
      store.set('gauges', [...S.selected]);
      buildTiles();
    };
    lab.append(cb, document.createTextNode(` ${PIDS[pid].name}`));
    box.append(lab);
  }
  if (!pids.length) box.append(el('span', 'muted', 'The ECU reported no live PIDs.'));
}

function buildTiles() {
  const box = $('tiles');
  box.replaceChildren();
  for (const pid of shown()) {
    const d = PIDS[pid];
    const tile = el('div', `tile${d.text ? ' wide' : ''}`);
    tile.dataset.pid = pid;
    tile.title = d.name;
    tile.append(el('div', 'name', d.short));
    const val = el('div', `val${d.text ? ' text' : ''}`, '—');
    tile.append(val);
    if (!d.text) {
      const bar = el('div', 'bar');
      bar.append(el('i'));
      const range = el('div', 'range');
      range.append(el('span', 'lo', ''), el('span', 'hi', ''));
      tile.append(bar, el('canvas'), range);
    }
    box.append(tile);
    const last = S.hist.get(pid)?.at(-1);
    if (last != null) paint(pid, last);
  }
}

function paint(pid, v) {
  const tile = document.querySelector(`.tile[data-pid="${pid}"]`);
  if (!tile) return;
  const d = PIDS[pid];
  tile.classList.remove('stale');
  const val = tile.querySelector('.val');
  if (d.text) { val.textContent = v; return; }
  val.replaceChildren(document.createTextNode(v.toFixed(d.digits)), el('small', null, d.unit));
  const frac = Math.max(0, Math.min(1, (v - d.min) / (d.max - d.min)));
  tile.querySelector('.bar i').style.width = `${(frac * 100).toFixed(1)}%`;
  const st = S.stats.get(pid);
  if (st) {
    tile.querySelector('.lo').textContent = `min ${st.min.toFixed(d.digits)}`;
    tile.querySelector('.hi').textContent = `max ${st.max.toFixed(d.digits)}`;
  }
  spark(tile.querySelector('canvas'), S.hist.get(pid) || [], d);
}

let accent;
function spark(cv, data, d) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (hi - lo < (d.max - d.min) * 0.05) { const m = (hi + lo) / 2, r = (d.max - d.min) * 0.025; lo = m - r; hi = m + r; }
  accent ??= getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  g.strokeStyle = accent;
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.beginPath();
  data.forEach((v, i) => {
    const x = (i / (60 - 1)) * w;
    const y = h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

function record(pid, v) {
  if (typeof v === 'number') {
    const h = S.hist.get(pid) || [];
    h.push(v);
    if (h.length > 60) h.shift();
    S.hist.set(pid, h);
    const st = S.stats.get(pid) || { min: v, max: v };
    st.min = Math.min(st.min, v);
    st.max = Math.max(st.max, v);
    S.stats.set(pid, st);
  }
  paint(pid, v);
}

async function startLive() {
  if (S.live || !S.obd) return;
  S.live = true;
  refreshButtons();
  let n = 0, fails = 0, t0 = performance.now();
  while (S.live && S.obd) {
    const pids = shown();
    const reads = new Set(pids.map((p) => (PIDS[p].virtual ? PIDS[p].needs : p)));
    if (!reads.size) { await sleep(300); continue; }
    const row = S.rec ? { time: new Date().toISOString() } : null;
    for (const pid of reads) {
      if (!S.live || !S.obd) break;
      try {
        const v = await S.obd.readPid(pid);
        fails = 0;
        n++;
        if (S.selected.has(pid)) record(pid, v);
        if (row) row[pid] = v;
        if (pid === 0x0b && pids.includes(BOOST)) {
          const b = S.obd.boostPsi(v);
          record(BOOST, b);
          if (row) row[BOOST] = b;
        }
      } catch (e) {
        log('warn', `${PIDS[pid].short}: ${e.message}`);
        if (++fails >= 6) {
          log('error', 'Too many failed reads — live data stopped');
          S.live = false;
        }
      }
    }
    if (row && S.rec) S.rec.push(row);
    const dt = performance.now() - t0;
    if (dt > 1500) {
      $('rate').textContent = `${((n * 1000) / dt).toFixed(1)} readings/s`;
      n = 0;
      t0 = performance.now();
    }
    refreshButtons();
  }
  S.live = false;
  $('rate').textContent = '';
  refreshButtons();
}

function toggleRecord() {
  if (!S.rec) { S.rec = []; refreshButtons(); return; }
  const rows = S.rec;
  S.rec = null;
  refreshButtons();
  if (!rows.length) return;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'time');
  const head = ['time', ...cols.map((c) => `${PIDS[c].short} (${PIDS[c].unit ?? ''})`)];
  const lines = [head, ...rows.map((r) => [r.time, ...cols.map((c) => (typeof r[c] === 'number' ? r[c].toFixed(PIDS[c].digits + 1) : r[c] ?? ''))])];
  download(`r53-log-${stamp()}.csv`, lines.map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
}

// ---------------------------------------------------------------- codes
async function action(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { log('error', e.message); hint(e.message); } finally { refreshButtons(); }
}

function renderMil(mon) {
  $('milLamp').dataset.on = String(mon.mil);
  $('milText').textContent = `Check engine light: ${mon.mil ? 'ON' : 'off'}`;
  $('milSub').textContent = `${mon.count} emissions code${mon.count === 1 ? '' : 's'} reported by the ECU`;
  renderReadiness(mon.tests);
}

function renderDtcs(id, codes, pending) {
  const ul = $(id);
  ul.replaceChildren();
  if (!codes.length) {
    ul.append(el('li', 'ok', 'No codes'));
    return;
  }
  for (const c of codes) {
    const li = el('li', `code${pending ? ' pending' : ''}`);
    li.append(el('span', 'c', c), el('span', null, describeDtc(c).text));
    ul.append(li);
  }
}

async function readCodes() {
  const obd = S.obd;
  if (S.supported.has(0x01)) renderMil(await obd.monitorStatus());
  const stored = await obd.readDtcs(3);
  renderDtcs('stored', stored, false);
  log('info', `Stored codes: ${stored.join(', ') || 'none'}`);
  try {
    const pending = await obd.readDtcs(7);
    renderDtcs('pending', pending, true);
    log('info', `Pending codes: ${pending.join(', ') || 'none'}`);
  } catch (e) {
    $('pending').replaceChildren(el('li', 'muted', 'This ECU does not report pending codes'));
  }
}

async function readFreeze() {
  const box = $('freeze');
  box.replaceChildren(el('h3', null, 'Freeze frame'));
  const ff = await S.obd.freezeFrame();
  if (!ff) { box.append(el('p', 'muted', 'No freeze frame stored.')); return; }
  box.append(el('p', null, `Snapshot taken when ${ff.dtc} (${describeDtc(ff.dtc).text}) was set:`));
  const tbl = el('table', 'ff');
  for (const { def, value } of ff.values) {
    const tr = el('tr');
    tr.append(el('td', null, def.name), el('td', null, typeof value === 'number' ? `${value.toFixed(def.digits)} ${def.unit}` : value));
    tbl.append(tr);
  }
  box.append(tbl);
}

async function clearCodes() {
  const dlg = $('clearDlg');
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
  if (dlg.returnValue !== 'ok') return;
  await S.obd.clearDtcs();
  log('info', 'Trouble codes cleared');
  $('freeze').replaceChildren();
  await sleep(500);
  await readCodes();
}

// ---------------------------------------------------------------- vehicle info
async function refreshInfo(info) {
  const rows = [
    ['Interface', S.transport.name],
    ['Protocol', info.label],
    ['Key bytes', hex(info.keyBytes)],
  ];
  if (S.supported.has(0x1c)) {
    try { const raw = await S.obd.readRaw(0x1c); rows.push(['OBD standard', OBD_STANDARDS[raw[0]] ?? `code ${raw[0]}`]); } catch {}
  }
  try { rows.push(['VIN', (await S.obd.vin()) || 'blank']); } catch { rows.push(['VIN', 'not reported (common before 2005)']); }
  if (S.supported.has(0x0b)) rows.push(['Baro for boost', `${S.obd.baro.toFixed(0)} kPa`]);
  const dl = $('infoList');
  dl.replaceChildren();
  for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));

  const chips = $('supported');
  chips.replaceChildren();
  for (const p of [...S.supported].filter((p) => p % 0x20)) chips.append(el('span', 'chip', pidLabel(p)));
}

function renderReadiness(tests) {
  const ul = $('readiness');
  ul.replaceChildren();
  if (!tests.length) ul.append(el('li', 'muted', 'None reported'));
  for (const t of tests) {
    const li = el('li');
    li.append(el('span', null, t.name), el('span', t.complete ? 'done' : 'todo', t.complete ? 'Ready' : 'Not ready'));
    ul.append(li);
  }
}

// ---------------------------------------------------------------- misc
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function download(name, text, type) {
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function init() {
  const sel = $('transport');
  for (const t of TRANSPORTS) {
    const o = el('option', null, t.label + (t.cls.supported() ? '' : ' — not available in this browser'));
    o.value = t.id;
    o.disabled = !t.cls.supported();
    sel.append(o);
  }
  const saved = store.get('settings', {});
  const isAndroid = /Android/i.test(navigator.userAgent);
  const best = isAndroid && WebUsbFtdiTransport.supported() ? 'webusb' : WebSerialTransport.supported() ? 'webserial' : WebUsbFtdiTransport.supported() ? 'webusb' : 'sim';
  sel.value = TRANSPORTS.find((t) => t.id === saved.transport)?.cls.supported() ? saved.transport : best;
  if (saved.protocol) $('protocol').value = saved.protocol;
  if (saved.simProto) $('simProto').value = saved.simProto;
  $('dtr').checked = !!saved.dtr;
  $('rts').checked = !!saved.rts;
  if (saved.interByteMs != null) $('interByte').value = saved.interByteMs;
  if (saved.idleMs) $('idle').value = saved.idleMs;
  if (!WebSerialTransport.supported() && !WebUsbFtdiTransport.supported()) {
    hint('This browser can’t talk to USB devices. Use Chrome or Edge (desktop) or Chrome on Android. The simulator still works.');
  }

  $('connectBtn').onclick = () => (S.transport ? disconnect() : connect());
  $('testBtn').onclick = runCableTest;
  $('liveBtn').onclick = () => (S.live ? (S.live = false) : startLive());
  $('pickBtn').onclick = () => { $('picker').hidden = !$('picker').hidden; $('pickBtn').classList.toggle('on', !$('picker').hidden); };
  $('recBtn').onclick = toggleRecord;
  $('readCodesBtn').onclick = (e) => action(e.currentTarget, readCodes);
  $('freezeBtn').onclick = (e) => action(e.currentTarget, readFreeze);
  $('clearBtn').onclick = (e) => action(e.currentTarget, clearCodes);
  $('copyLog').onclick = () => navigator.clipboard?.writeText(logLines.join('\n'));
  $('saveLog').onclick = () => download(`r53-log-${stamp()}.txt`, logLines.join('\n'), 'text/plain');
  $('clearLog').onclick = () => { logLines.length = 0; $('log').replaceChildren(); };
  $('logBytes').onchange = (e) => $('log').classList.toggle('hide-bytes', !e.target.checked);
  for (const b of document.querySelectorAll('.tab-btn')) {
    b.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'live') for (const p of shown()) { const h = S.hist.get(p); if (h?.length) paint(p, h.at(-1)); }
    };
  }
  navigator.serial?.addEventListener('disconnect', () => { if (S.transport instanceof WebSerialTransport) { log('error', 'Cable unplugged'); disconnect(true); } });
  navigator.usb?.addEventListener('disconnect', () => { if (S.transport instanceof WebUsbFtdiTransport) { log('error', 'Cable unplugged'); disconnect(true); } });
  refreshButtons();
  log('info', 'Ready. Plug the cable into the car, turn the ignition on, then Connect.');
}

init();
