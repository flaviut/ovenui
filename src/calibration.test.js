import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, fitLog, toResponse, toThermal, suggestSections, calibrateResponse, suggestCalibrationSections, calibrateSection } from './calibration.js';
import { rcStep } from './thermal.js';
import { loadSettings, saveSettings, loadResponseSettings, saveResponseSettings } from './settings.js';
import { encodeLog, decodeLog } from './log-storage.js';
const config = { ambient: 25, power: 2000, resistance: 0.4, capacity: 2000 };
function coolingCSV() {
  return 'A different program\r\n' + Array.from({ length: 101 }, (_, i) => `${i * 10},${(25 + 200 * Math.exp(-i * 10 / 800)).toFixed(2)}`).join('\r\n');
}
test('native Controleo3 format accepts a profile-name preamble, CRLF, and BOM', () => {
  const log = parseLog('\uFEFF' + coolingCSV());
  assert.equal(log.hasDuty, false); assert.equal(log.rows.length, 101);
  assert.equal(log.rows[0].temperature, 225);
  assert.equal(parseLog(coolingCSV().replace('A different program', '123')).label, '123');
});
test('cooling fit recovers tau and C conditionally on retained R', () => {
  const fit = fitLog(parseLog(coolingCSV()), config, { from: 0, to: 1000, heaterOff: true });
  assert.equal(fit.resistance, 0.4);
  assert.ok(Math.abs(fit.tau - 800) < 0.1);
  assert.ok(Math.abs(fit.capacity - 2000) < 0.3);
  assert.ok(fit.rmse < 0.02);
  const otherR = fitLog(parseLog(coolingCSV()), { ...config, resistance: 0.8 }, { from: 0, to: 1000, heaterOff: true });
  assert.ok(Math.abs(otherR.capacity - 1000) < 0.2);
});
test('measured arbitrary heater duty identifies both R and C', () => {
  let temperature = 25; const rows = [];
  for (let time = 0; time <= 3000; time++) {
    const duty = [0.8, 0.2, 0, 1, 0.35, 0][Math.min(5, Math.floor(time / 500))];
    rows.push(`${time},${temperature.toFixed(3)},${duty * 100}`);
    temperature = rcStep(temperature, 1, config, duty);
  }
  const log = parseLog('Other program\n"Time (s)","Temperature (C)","Duty (%)"\n' + rows.join('\n'));
  const fit = fitLog(log, { ...config, resistance: 1, capacity: 10000 }, { from: 0, to: 3000 });
  assert.ok(Math.abs(fit.resistance / config.resistance - 1) < 0.005);
  assert.ok(Math.abs(fit.capacity / config.capacity - 1) < 0.005);
  assert.ok(fit.rmse < 0.1);
  assert.equal(log.hasDuty, true);
});
test('fraction duty and reordered columns are accepted', () => {
  const log = parseLog('temperature,time,duty_fraction\n100,0,0.5\n99,10,0\n98,20,0\n97,30,0\n96,40,0\n95,50,0');
  assert.equal(log.rows[0].duty, 0.5);
  assert.equal(log.rows[0].temperature, 100);
});
test('rejects missing columns, malformed rows, duplicate/reset times, and impossible duty', () => {
  for (const text of [
    'time,temperature,duty (%)\n0,100,200',
    'time,temperature\n0,100\n0,99',
    'time,temperature\n10,100\n0,99',
    'time,temperature\n0,100\n1,',
    'time,temperature\n0,100\n1,NaN',
    'time,temperature\n0,100\n1,Infinity',
    '0,100,0\n1,99,0',
  ]) assert.throws(() => parseLog(text));
});
test('requires explicit heater-off confirmation, cooling, and sufficient variation', () => {
  const log = parseLog(coolingCSV());
  assert.throws(() => fitLog(log, config, { from: 0, to: 1000 }), /Confirm/);
  assert.throws(() => fitLog(log, config, { from: 0, to: 20, heaterOff: true }), /30 seconds/);
  assert.throws(() => fitLog({ ...log, rows: log.rows.map(r => ({ ...r, temperature: 100 })) }, config, { from: 0, to: 1000, heaterOff: true }), /variation/);
  assert.throws(() => fitLog({ ...log, rows: log.rows.map(r => ({ ...r, temperature: 25 + r.time / 5 })) }, config, { from: 0, to: 1000, heaterOff: true }), /above ambient/);
  assert.throws(() => fitLog(log, config, { from: 100, to: 0, heaterOff: true }), /valid start/);
});
test('settings and fit metadata survive storage round trips; corruption and unavailable storage are safe', () => {
  const map = new Map(); const storage = { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v) };
  const fit = fitLog(parseLog(coolingCSV()), config, { from: 0, to: 1000, heaterOff: true });
  assert.equal(saveSettings(storage, config, fit), true);
  assert.deepEqual(loadSettings(storage), { config, fit });
  map.set([...map.keys()][0], '{broken');
  assert.equal(loadSettings(storage).fit, null);
  assert.equal(saveSettings(null, config, fit), false);
  assert.ok(loadSettings(null).config.capacity > 0);
});
test('annotated full-power heating and heater-off cooling recover observable response', () => {
  const rows = []; let temperature = 25;
  for (let time = 0; time <= 2000; time++) {
    rows.push(`${time},${temperature.toFixed(3)}`);
    temperature = rcStep(temperature, 1, config, time < 800 ? 1 : 0);
  }
  const log = parseLog('Calibration\n' + rows.join('\n'));
  const suggested = suggestSections(log);
  assert.ok(suggested.heating.to <= 820 && suggested.heating.to >= 780);
  assert.ok(suggested.cooling.from >= 780 && suggested.cooling.to > 1900);
  const current = { heatingRate: 5, coolingHalfTime: 10 };
  const selection = { heating: { from: 0, to: 800, confirmed: true }, cooling: { from: 800, to: 2000, confirmed: true } };
  const result = calibrateResponse(log, current, selection);
  assert.ok(Math.abs(result.heatingRate - 60) < 0.02);
  assert.ok(Math.abs(result.coolingHalfTime - 800 * Math.LN2 / 60) < 0.01);
  assert.ok(result.rmse < 0.01);
  const coolingOnly = calibrateResponse(log, current, { cooling: selection.cooling });
  assert.equal(coolingOnly.heatingRate, 5);
  assert.match(coolingOnly.method, /Heating speed kept/);
  assert.throws(() => calibrateResponse(log, current, {}), /Mark a heater-off/);
});
test('one continuous warmup/cooldown section calibrates both without checkboxes', () => {
  const rows = []; let temperature = 25;
  for (let time = 0; time <= 2000; time++) {
    rows.push(`${time},${temperature.toFixed(3)}`);
    temperature = rcStep(temperature, 1, config, time < 800 ? 1 : 0);
  }
  const log = parseLog('Single cycle\n' + rows.join('\n'));
  const suggested = suggestCalibrationSections(log);
  assert.equal(suggested[0].label, 'Warmup and cooldown');
  const result = calibrateSection(log, { heatingRate: 5, coolingHalfTime: 10 }, { from: 0, to: 2000 });
  assert.ok(Math.abs(result.heatingRate - 60) < 0.02);
  assert.ok(result.rmse < 0.01);
  const cooling = calibrateSection(log, { heatingRate: 5, coolingHalfTime: 10 }, { from: 800, to: 2000 });
  assert.equal(cooling.heatingRate, 5);
  assert.throws(() => calibrateSection(log, { heatingRate: 5, coolingHalfTime: 10 }, { from: 0, to: 700 }), /Include a cooldown/);
});
test('long multi-stage logs yield separate suggestions that exclude long holds', () => {
  let temperature = 25; const rows = [];
  for (let time = 0; time <= 30000; time += 5) {
    rows.push(`${time},${temperature.toFixed(3)}`);
    const duty = time < 900 ? 1 : time < 9000 ? (temperature - 25) / (config.resistance * config.power) : time < 12500 ? 0 : time < 13500 ? 1 : time < 20000 ? (temperature - 25) / (config.resistance * config.power) : 0;
    temperature = rcStep(temperature, 5, config, duty);
  }
  const log = parseLog('Long staged cycle\n' + rows.join('\n'));
  const phases = suggestSections(log);
  assert.ok(phases.heatingCandidates.length >= 2);
  assert.ok(phases.coolingCandidates.length >= 2);
  for (const section of phases.heatingCandidates) assert.ok(section.to - section.from < 2000, 'hold must not be included in a heating suggestion');
  for (const section of phases.coolingCandidates) assert.ok(section.from >= 8990, 'cooling starts within one smoothing window of the stage boundary');
  const suggestions = suggestCalibrationSections(log);
  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.every(s => s.label === 'Cooldown'), 'a long hold must prevent pairing warmup and cooldown');
});
test('compressed local-storage logs preserve samples exactly and reopen older drafts', async () => {
  const csv = coolingCSV();
  const saved = await encodeLog(csv);
  assert.equal(await decodeLog(saved), csv);
  assert.ok(saved.encoded.length < csv.length);
  assert.equal(await decodeLog({ csv }), csv);
});
test('response settings preserve the thermal model and migrate/persist without requiring R/C controls', () => {
  const response = toResponse(config), normalized = toThermal(response);
  assert.ok(Math.abs(rcStep(100, 300, config, 0.7) - rcStep(100, 300, normalized, 0.7)) < 1e-9);
  assert.equal(normalized.ambient, 25);
  const map = new Map(), storage = { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v) };
  saveSettings(storage, config, null);
  assert.deepEqual(loadResponseSettings(storage).response, response);
  const fit = { ...response, method: 'Heating and cooling calibrated.' };
  assert.equal(saveResponseSettings(storage, response, fit), true);
  assert.deepEqual(loadResponseSettings(storage), { response, fit });
});
