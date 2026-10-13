import { parseLog, calibrateSection, suggestCalibrationSections } from './calibration.js';
import { loadResponseSettings, saveResponseSettings } from './settings.js';
import { encodeLog, decodeLog } from './log-storage.js';
import './style.css';

const ns = 'http://www.w3.org/2000/svg';
const node = (tag, attrs = {}, text) => {
  const n = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
};
const file = document.querySelector('#log-file'), form = document.querySelector('#calibration-form');
const status = document.querySelector('#log-status'), summary = document.querySelector('#fit-summary');
const startSlider = document.querySelector('#selection-start'), endSlider = document.querySelector('#selection-end');
const picker = document.querySelector('#section-suggestion');
let storage = null; try { storage = localStorage; } catch {}
let log = null, filename = '', logRecord = null, section = null, suggestions = [], view = null, svg = null, trace = null;
const width = 800, height = 360, left = 60, right = 18, top = 18, bottom = 42;
const fullFrom = () => log.rows[0].time, fullTo = () => log.rows.at(-1).time;
const x = t => left + (t - view.from) / (view.to - view.from) * (width - left - right);
function showFit(fit) {
  if (!fit) return;
  summary.textContent = `${fit.filename || 'Log'} · Heating ${fit.heatingRate.toFixed(1)}°C/min · Cooling half-time ${fit.coolingHalfTime.toFixed(1)} min · Typical difference ${fit.rmse.toFixed(1)}°C. ${fit.method}`;
}
showFit(loadResponseSettings(storage).fit);
function saveDraft() {
  try { storage.setItem('controleo3-calibration-log-v1', JSON.stringify({ ...logRecord, filename, section, view })); }
  catch { status.textContent = 'Log and selection could not be saved on this browser.'; }
}
function nearest(time) {
  let a = 0, b = log.rows.length - 1;
  while (a < b) { const mid = Math.floor((a + b) / 2); if (log.rows[mid].time < time) a = mid + 1; else b = mid; }
  return log.rows[a];
}
function syncControls() {
  if (document.activeElement !== form.elements.from) form.elements.from.value = section ? (section.from / 60).toFixed(3) : '';
  if (document.activeElement !== form.elements.to) form.elements.to.value = section ? (section.to / 60).toFixed(3) : '';
  for (const slider of [startSlider, endSlider]) { slider.min = view.from; slider.max = view.to; }
  startSlider.value = section?.from ?? view.from; endSlider.value = section?.to ?? view.to;
  const index = section ? suggestions.findIndex(s => Math.abs(s.from - section.from) < 0.1 && Math.abs(s.to - section.to) < 0.1) : -1;
  picker.value = index < 0 ? '' : String(index);
  document.querySelector('#selection-readout').textContent = section ? `${(section.from / 60).toFixed(1)}–${(section.to / 60).toFixed(1)} min · ${nearest(section.from).temperature.toFixed(0)}°C → ${nearest(section.to).temperature.toFixed(0)}°C` : 'Select a section on the plot or with the sliders.';
  document.querySelector('#view-readout').textContent = `Showing ${(view.from / 60).toFixed(1)}–${(view.to / 60).toFixed(1)} min of ${(fullTo() / 60).toFixed(1)} min`;
  document.querySelector('#view-earlier').disabled = view.from <= fullFrom();
  document.querySelector('#view-later').disabled = view.to >= fullTo();
  document.querySelector('#zoom-selection').disabled = !section;
}
function updateRegion() {
  if (!svg) return;
  svg.querySelectorAll('.selection-region').forEach(n => n.remove());
  if (section) {
    const a = Math.max(view.from, section.from), b = Math.min(view.to, section.to);
    if (b > a) {
      svg.insertBefore(node('rect', { class: 'selection-region', x: x(a), y: top, width: x(b) - x(a), height: height - top - bottom, fill: '#276ca0', opacity: 0.16, 'pointer-events': 'none' }), trace);
      for (const time of [a, b]) svg.insertBefore(node('line', { class: 'selection-region', x1: x(time), x2: x(time), y1: top, y2: height - bottom, stroke: '#276ca0', 'stroke-width': 2, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }), trace);
    }
  }
  syncControls();
}
function setSection(value) { section = value; updateRegion(); }
function setView(from, to) {
  const span = Math.min(fullTo() - fullFrom(), Math.max(30, to - from));
  const a = Math.max(fullFrom(), Math.min(from, fullTo() - span));
  view = { from: a, to: a + span }; drawLog(); saveDraft();
}
function focusSection() {
  if (!section) return;
  const pad = Math.max(15, (section.to - section.from) * 0.15);
  setView(section.from - pad, section.to + pad);
}
function adjustBoundary(which, value) {
  const old = section || { ...view };
  const clamped = Math.max(fullFrom(), Math.min(fullTo(), value));
  const from = which === 'start' ? Math.max(fullFrom(), Math.min(clamped, old.to - 1)) : old.from;
  const to = which === 'end' ? Math.min(fullTo(), Math.max(clamped, old.from + 1)) : old.to;
  setSection({ from, to });
  if (from < view.from || to > view.to) focusSection();
  saveDraft();
}
startSlider.addEventListener('input', () => adjustBoundary('start', Number(startSlider.value)));
endSlider.addEventListener('input', () => adjustBoundary('end', Number(endSlider.value)));
document.querySelectorAll('[data-adjust]').forEach(button => button.addEventListener('click', () => {
  const [which, delta] = button.dataset.adjust.split(':');
  const value = which === 'start' ? section?.from ?? Number(startSlider.value) : section?.to ?? Number(endSlider.value);
  adjustBoundary(which, value + Number(delta));
}));
picker.addEventListener('change', () => {
  if (picker.value === '') return;
  const selected = suggestions[Number(picker.value)];
  setSection({ from: selected.from, to: selected.to }); focusSection(); saveDraft();
});
function activate(button, action) {
  let lastTouch = -Infinity;
  button.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || button.disabled) return;
    lastTouch = performance.now(); event.preventDefault(); action();
  });
  button.addEventListener('click', event => {
    if (event.detail === 0 || performance.now() - lastTouch > 750) action();
  });
}
activate(document.querySelector('#zoom-selection'), focusSection);
activate(document.querySelector('#show-full-log'), () => setView(fullFrom(), fullTo()));
for (const [id, direction] of [['view-earlier', -1], ['view-later', 1]]) activate(document.querySelector('#' + id), () => {
  const shift = (view.to - view.from) / 2 * direction; setView(view.from + shift, view.to + shift);
});
function drawOverview() {
  const overview = node('svg', { viewBox: '0 0 800 65', role: 'img', 'aria-label': 'Full log overview with the visible time range highlighted' });
  const range = log.rows.reduce((r, p) => [Math.min(r[0], p.temperature), Math.max(r[1], p.temperature)], [25, 100]);
  const ox = t => 10 + (t - fullFrom()) / (fullTo() - fullFrom()) * 780;
  const oy = temperature => 55 - (temperature - range[0]) / (range[1] - range[0]) * 45;
  let path = ''; const stride = Math.max(1, Math.ceil(log.rows.length / 1000));
  log.rows.forEach((r, i) => { if (i % stride === 0 || i === log.rows.length - 1) path += `${path ? 'L' : 'M'}${ox(r.time).toFixed(2)},${oy(r.temperature).toFixed(2)} `; });
  overview.append(node('rect', { x: ox(view.from), y: 5, width: ox(view.to) - ox(view.from), height: 55, fill: '#e3eff8', stroke: '#8bb3d0' }));
  overview.append(node('path', { d: path, fill: 'none', stroke: '#407c68', 'stroke-width': 1.5 }));
  document.querySelector('#log-overview').replaceChildren(overview);
}
function drawLog() {
  const visible = log.rows.filter(r => r.time >= view.from && r.time <= view.to);
  const range = visible.reduce((r, p) => [Math.min(r[0], p.temperature), Math.max(r[1], p.temperature)], [25, 100]);
  const minimum = Math.floor(range[0] / 25) * 25, maximum = Math.ceil(range[1] / 25) * 25;
  const y = t => height - bottom - (t - minimum) / (maximum - minimum) * (height - top - bottom);
  svg = node('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Calibration log. Drag to mark one section. Use the sliders or time inputs for precise selection.' });
  for (let i = 0; i <= 4; i++) {
    const t = minimum + (maximum - minimum) * i / 4;
    svg.append(node('line', { x1: left, y1: y(t), x2: width - right, y2: y(t), stroke: '#e4eaf0' }));
    svg.append(node('text', { x: left - 10, y: y(t) + 4, 'text-anchor': 'end' }, Math.round(t)));
    const time = view.from + (view.to - view.from) * i / 4;
    svg.append(node('text', { x: x(time), y: height - bottom + 20, 'text-anchor': 'middle' }, (time / 60).toFixed(1)));
  }
  svg.append(node('text', { x: left, y: 12 }, '°C'));
  svg.append(node('text', { x: width / 2, y: height - 3, 'text-anchor': 'middle' }, 'Time (minutes)'));
  const stride = Math.max(1, Math.ceil(visible.length / 3000)); let path = '';
  visible.forEach((r, i) => { if (i % stride === 0 || i === visible.length - 1) path += `${path ? 'L' : 'M'}${x(r.time).toFixed(2)},${y(r.temperature).toFixed(2)} `; });
  trace = node('path', { d: path, fill: 'none', stroke: '#407c68', 'stroke-width': 2.5, 'pointer-events': 'none' }); svg.append(trace);
  let dragStart = null;
  const timeAt = event => {
    const box = svg.getBoundingClientRect();
    return view.from + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * width - left) / (width - left - right))) * (view.to - view.from);
  };
  svg.addEventListener('pointerdown', event => { if (event.button !== 0) return; dragStart = timeAt(event); svg.setPointerCapture(event.pointerId); event.preventDefault(); });
  svg.addEventListener('pointermove', event => { if (dragStart !== null) { const time = timeAt(event); setSection({ from: Math.min(dragStart, time), to: Math.max(dragStart, time) }); } });
  const finish = () => { if (dragStart !== null) { dragStart = null; saveDraft(); } };
  svg.addEventListener('pointerup', finish); svg.addEventListener('pointercancel', finish);
  document.querySelector('#calibration-plot').replaceChildren(svg); updateRegion(); drawOverview();
}
function openLog(text, name, draft = null) {
  const parsed = parseLog(text);
  log = parsed; filename = name;
  suggestions = suggestCalibrationSections(log);
  section = draft?.section || (draft?.selections?.heating && draft?.selections?.cooling ? { from: draft.selections.heating.from, to: draft.selections.cooling.to } : draft?.selections?.cooling) || (suggestions[0] ? { from: suggestions[0].from, to: suggestions[0].to } : null);
  view = { from: fullFrom(), to: fullTo() };
  if (draft?.view && draft.view.from >= fullFrom() && draft.view.to <= fullTo() && draft.view.to > draft.view.from) view = draft.view;
  document.querySelector('#calibration-workspace').hidden = false;
  document.querySelector('#log-name').textContent = name;
  picker.replaceChildren(); const custom = document.createElement('option'); custom.value = ''; custom.textContent = 'Custom section'; picker.append(custom);
  suggestions.forEach((s, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `${s.label} · ${(s.from / 60).toFixed(1)}–${(s.to / 60).toFixed(1)} min`; picker.append(option); });
  drawLog();
  status.textContent = draft ? 'Saved log and selection restored.' : suggestions.length ? `${suggestions.length} suggested section${suggestions.length === 1 ? '' : 's'} found. One is selected.` : 'No clear cooldown found. Mark a suitable section manually.';
}
document.querySelector('#import-log').addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const selected = file.files[0]; if (!selected) return;
  try {
    if (selected.size > 10 * 1024 * 1024) throw new Error('Choose a CSV log smaller than 10 MB.');
    const text = await selected.text();
    parseLog(text);
    const record = await encodeLog(text);
    openLog(text, selected.name); logRecord = record; saveDraft();
  }
  catch (error) { status.textContent = error.message; }
  file.value = '';
});
form.addEventListener('input', () => {
  if (form.elements.from.value === '' || form.elements.to.value === '') return;
  section = { from: Number(form.elements.from.value) * 60, to: Number(form.elements.to.value) * 60 };
  updateRegion(); saveDraft();
});
form.addEventListener('submit', event => {
  event.preventDefault(); if (!log) return;
  try {
    if (form.elements.from.value === '' || form.elements.to.value === '') throw new Error('Enter the start and end of the calibration section.');
    const result = { ...calibrateSection(log, loadResponseSettings(storage).response, section), filename, timestamp: new Date().toISOString() };
    const stored = saveResponseSettings(storage, { heatingRate: result.heatingRate, coolingHalfTime: result.coolingHalfTime }, result);
    showFit(result); saveDraft(); status.textContent = stored ? 'Calibration saved. Open Program to use it.' : 'Storage unavailable. Calibration could not be saved.';
  } catch (error) { status.textContent = error.message; }
});
async function restoreLog() {
  try {
    const draft = JSON.parse(storage.getItem('controleo3-calibration-log-v1'));
    if (draft?.csv || draft?.encoded) { const text = await decodeLog(draft); openLog(text, draft.filename, draft); logRecord = draft.csv ? { csv: draft.csv } : { encoding: draft.encoding, encoded: draft.encoded }; }
  } catch (error) { status.textContent = error.message || 'Saved log could not be reopened. Upload it again.'; }
}
restoreLog();
