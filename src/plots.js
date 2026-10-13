import { simulate } from './thermal.js';
import { loadResponseSettings, saveResponseSettings } from './settings.js';
import { toThermal } from './calibration.js';

const ns = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, text) => {
  const node = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
};

function draw(container, result, maxY) {
  const width = 800, height = 280, left = 60, right = 18, top = 18, bottom = 42;
  const duration = Math.max(60, result.duration);
  const x = t => left + t / duration * (width - left - right);
  const y = t => height - bottom - Math.max(0, t) / maxY * (height - top - bottom);
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Ideal and simulated temperature in degrees Celsius versus time in minutes' });
  for (let i = 0; i <= 4; i++) {
    const temperature = maxY * i / 4;
    svg.append(el('line', { x1: left, y1: y(temperature), x2: width - right, y2: y(temperature), stroke: '#e4eaf0' }));
    svg.append(el('text', { x: left - 10, y: y(temperature) + 4, 'text-anchor': 'end' }, Math.round(temperature)));
    const time = duration * i / 4;
    svg.append(el('text', { x: x(time), y: height - bottom + 20, 'text-anchor': 'middle' }, (time / 60).toFixed(duration < 600 ? 1 : 0)));
  }
  svg.append(el('text', { x: left, y: 12 }, '°C'));
  svg.append(el('text', { x: width / 2, y: height - 3, 'text-anchor': 'middle' }, 'Time (minutes)'));
  // Retain breaks in the ideal line while reducing dense traces for rendering.
  const stride = Math.max(1, Math.ceil(result.points.length / 2000));
  for (const [key, color] of [['ideal', '#276ca0'], ['estimated', '#c47b16']]) {
  let path = '', active = false;
  result.points.forEach((p, i) => {
    if (p[key] === null) { active = false; return; }
    const boundary = !active || i === result.points.length - 1 || result.points[i + 1]?.[key] === null || result.points[i - 1]?.time === p.time;
    if (!boundary && i % stride) return;
    path += `${active ? 'L' : 'M'}${x(p.time).toFixed(2)},${y(p[key]).toFixed(2)} `;
    active = true;
  });
  svg.append(el('path', { d: path, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'data-series': key, ...(key === 'ideal' ? { 'stroke-dasharray': '7 4' } : {}) }));
  }
  const tracker = el('line', { y1: top, y2: height - bottom, stroke: '#9aaab7', 'stroke-dasharray': '4 4', visibility: 'hidden' });
  svg.append(tracker);
  const readout = document.createElement('p'); readout.className = 'plot-readout';
  readout.textContent = 'Move over the chart to read time and temperature.';
  svg.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect();
    const seconds = Math.max(0, Math.min(duration, ((event.clientX - box.left) / box.width * width - left) / (width - left - right) * duration));
    // Binary search the nearest sampled point.
    let lo = 0, hi = result.points.length - 1;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (result.points[mid].time < seconds) lo = mid + 1; else hi = mid; }
    const p = result.points[lo];
    tracker.setAttribute('x1', x(p.time)); tracker.setAttribute('x2', x(p.time)); tracker.setAttribute('visibility', 'visible');
    readout.textContent = `${(p.time / 60).toFixed(1)} min · Ideal ${p.ideal === null ? 'no target' : `${p.ideal.toFixed(1)}°C`} · Simulation ${p.estimated.toFixed(1)}°C`;
  });
  svg.addEventListener('pointerleave', () => tracker.setAttribute('visibility', 'hidden'));
  container.replaceChildren(svg, readout);
}

export function createPlots(getSource) {
  const form = document.querySelector('#thermal-settings');
  let storage = null;
  try { storage = localStorage; } catch {}
  const saved = loadResponseSettings(storage);
  for (const [key, value] of Object.entries(saved.response)) form.elements[key].value = value;
  const getResponse = () => Object.fromEntries(['heatingRate', 'coolingHalfTime'].map(key => [key, form.elements[key].value === '' ? NaN : Number(form.elements[key].value)]));
  const getConfig = () => toThermal(getResponse());
  const persist = fit => {
    const response = getResponse();
    if (!Object.values(response).every(v => Number.isFinite(v) && v > 0)) return false;
    const success = saveResponseSettings(storage, response, fit);
    document.querySelector('#settings-storage').textContent = success ? 'Simulation settings saved on this device. Room temperature is assumed to be 25°C.' : 'Local storage is unavailable; settings will not survive a reload.';
    return success;
  };
  document.querySelector('#calibration-summary').textContent = saved.fit ? `Last calibration: ${saved.fit.filename || 'CSV log'}. ${saved.fit.method}` : 'Simulation uses example settings. Calibrate it with a heating/cooling log.';
  let timer;
  function render() {
    clearTimeout(timer);
    const message = document.querySelector('#plot-status');
    try {
      const config = getConfig();
      const result = simulate(getSource(), config);
      const max = result.points.reduce((value, p) => Math.max(value, p.ideal ?? 0, p.estimated), 100);
      const maxY = Math.ceil(max / 50) * 50;
      draw(document.querySelector('#temperature-plot'), result, maxY);
      message.textContent = `Program duration ${(result.duration / 60).toFixed(1)} min`;
      const notes = document.querySelector('#plot-notes');
      notes.replaceChildren(...result.notes.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
      if (!result.duration) message.textContent += ' · Add a ramp, hold, or timed wait to see a curve.';
    } catch (error) {
      document.querySelector('#temperature-plot').replaceChildren();
      document.querySelector('#plot-notes').replaceChildren();
      message.textContent = error.message;
    }
  }
  form.addEventListener('input', () => { persist(saved.fit); if (saved.fit) document.querySelector('#calibration-summary').textContent = 'Simulation settings edited after calibration.'; clearTimeout(timer); timer = setTimeout(render, 200); });
  form.addEventListener('submit', event => { event.preventDefault(); render(); });
  render();
  persist(saved.fit);
  return () => { clearTimeout(timer); timer = setTimeout(render, 250); };
}
