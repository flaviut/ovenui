import { defaults } from './thermal.js';
import { toResponse } from './calibration.js';
const key = 'controleo3-thermal-settings-v1';
export function loadSettings(storage) {
  try {
    const saved = JSON.parse(storage.getItem(key));
    const config = { ...defaults };
    for (const name of Object.keys(defaults)) {
      if (Number.isFinite(saved?.config?.[name]) && (name === 'ambient' || saved.config[name] > 0)) config[name] = saved.config[name];
    }
    return { config, fit: saved?.fit && typeof saved.fit.method === 'string' ? saved.fit : null };
  } catch { return { config: { ...defaults }, fit: null }; }
}
export function saveSettings(storage, config, fit) {
  try { storage.setItem(key, JSON.stringify({ config, fit })); return true; }
  catch { return false; }
}
export function loadResponseSettings(storage) {
  const previous = loadSettings(storage);
  let response = toResponse({ ...previous.config, ambient: 25 });
  let fit = previous.fit;
  try {
    const saved = JSON.parse(storage.getItem('controleo3-simulation-v2'));
    if (saved?.response && ['heatingRate', 'coolingHalfTime'].every(k => Number.isFinite(saved.response[k]) && saved.response[k] > 0)) {
      response = saved.response; fit = saved.fit;
    }
  } catch {}
  return { response, fit: fit?.heatingRate ? fit : null };
}
export function saveResponseSettings(storage, response, fit) {
  try { storage.setItem('controleo3-simulation-v2', JSON.stringify({ response, fit })); return true; }
  catch { return false; }
}
