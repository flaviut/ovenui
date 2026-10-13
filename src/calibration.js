// Standard Controleo3 logs: profile name, then seconds,temperature in °C.
// Extended logs may include duty (%) or duty_fraction for system identification.
function csvCells(line) {
  const cells = []; let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('Unclosed quote in CSV.');
  cells.push(cell.trim()); return cells;
}
const headerName = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const numeric = s => s !== '' && Number.isFinite(Number(s));

export function parseLog(text) {
  if (text.length > 10 * 1024 * 1024) throw new Error('Choose a CSV log smaller than 10 MB.');
  const rows = [];
  let columns = null, fraction = false, hasDuty = false, label = '';
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const cells = csvCells(line);
    if (!rows.length && !columns) {
      const names = cells.map(headerName);
      const time = names.findIndex(n => ['time', 'times', 'timeseconds', 'seconds', 'elapsed', 'elapseds', 'elapsedseconds', 'secondsfromstart'].includes(n));
      const temperature = names.findIndex(n => ['temperature', 'temperaturec', 'tempc', 'temp', 'actualtemperature', 'actualtemperaturec'].includes(n));
      if (time >= 0 && temperature >= 0) {
        const duty = names.findIndex(n => ['duty', 'dutypercent', 'dutycycle', 'heaterduty', 'heaterdutypercent', 'dutyfraction'].includes(n));
        columns = { time, temperature, duty }; hasDuty = duty >= 0;
        fraction = duty >= 0 && names[duty] === 'dutyfraction';
        continue;
      }
      if (time >= 0 || temperature >= 0 || names.some(n => /^(time|temperature)(min|minutes|f|fahrenheit)$/.test(n)))
        throw new Error('CSV headers must identify time in seconds and temperature in °C. Use time,temperature,duty (%).');
      // Native logs begin with one profile-name line, with no column header.
      if ((cells.length === 1 || !numeric(cells[0])) && !label) { label = cells.join(', '); continue; }
      if (cells.length !== 2) throw new Error('Use native seconds,temperature rows, or a header with time,temperature,duty (%).');
      columns = { time: 0, temperature: 1, duty: -1 };
    }
    const { time, temperature, duty } = columns;
    if (![time, temperature, ...(hasDuty ? [duty] : [])].every(i => numeric(cells[i] ?? '')))
      throw new Error(`CSV row ${index + 1} contains missing or non-numeric values.`);
    const row = { time: Number(cells[time]), temperature: Number(cells[temperature]), duty: hasDuty ? Number(cells[duty]) / (fraction ? 1 : 100) : null };
    if (row.time < 0 || row.temperature < -273.15) throw new Error(`CSV row ${index + 1} has an invalid time or temperature. Use seconds and °C.`);
    if (hasDuty && (row.duty < 0 || row.duty > 1)) throw new Error(`CSV row ${index + 1}: duty must be 0–100%, or 0–1 for duty_fraction.`);
    if (rows.length && row.time <= rows.at(-1).time) throw new Error(`CSV row ${index + 1}: time must increase. Use one continuous log, without duplicates or timer resets.`);
    rows.push(row);
  }
  if (rows.length < 6) throw new Error('At least six time/temperature samples are needed.');
  return { rows, hasDuty, label };
}

export function fitLog(log, config, { from, to, heaterOff = false }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('Choose a valid start and end time.');
  if (!Number.isFinite(config.ambient) || !Number.isFinite(config.power) || config.power <= 0 || !Number.isFinite(config.resistance) || config.resistance <= 0)
    throw new Error('Set valid ambient temperature, heater power, and R before fitting.');
  const rows = log.rows.filter(r => r.time >= from && r.time <= to);
  if (rows.length < 6 || rows.at(-1).time - rows[0].time < 30) throw new Error('Select at least six samples spanning 30 seconds or more.');
  const minimum = rows.reduce((value, r) => Math.min(value, r.temperature), Infinity);
  const maximum = rows.reduce((value, r) => Math.max(value, r.temperature), -Infinity);
  if (maximum - minimum < 5) throw new Error('Select an interval with at least 5°C of temperature variation.');
  const coolingOnly = !log.hasDuty || rows.slice(0, -1).every(r => r.duty === 0);
  let resistance, capacity, tau, method;
  if (coolingOnly) {
    if (!log.hasDuty && !heaterOff) throw new Error('Confirm that the heater was off throughout the selected interval.');
    if (rows.some(r => r.temperature <= config.ambient + 2)) throw new Error('Select cooling samples at least 2°C above ambient.');
    const t0 = rows[0].time;
    const meanT = rows.reduce((s, r) => s + r.time - t0, 0) / rows.length;
    const meanY = rows.reduce((s, r) => s + Math.log(r.temperature - config.ambient), 0) / rows.length;
    let xy = 0, xx = 0;
    for (const r of rows) {
      const t = r.time - t0 - meanT;
      xy += t * (Math.log(r.temperature - config.ambient) - meanY); xx += t * t;
    }
    const slope = xy / xx;
    if (!(slope < 0)) throw new Error('The selected interval is not cooling. Select a heater-off cooling interval.');
    tau = -1 / slope; resistance = config.resistance; capacity = tau / resistance;
    method = 'Cooling-only: τ fitted; R retained; C = τ / R.';
  } else {
    // Integral energy balance avoids differentiating quantized temperature data:
    // ΔT = (P/C) ∫duty dt - (1/RC) ∫(T-ambient) dt.
    const window = Math.min(30, Math.max(1, (rows.at(-1).time - rows[0].time) / 50));
    const blocks = []; let heat = 0, loss = 0, start = 0;
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], current = rows[i], dt = current.time - prev.time;
      heat += prev.duty * dt;
      loss += ((prev.temperature + current.temperature) / 2 - config.ambient) * dt;
      if (current.time - rows[start].time >= window || i === rows.length - 1) {
        blocks.push({ heat, loss, delta: current.temperature - rows[start].temperature });
        start = i; heat = 0; loss = 0;
      }
    }
    let hh = 0, ll = 0, hl = 0, hy = 0, ly = 0;
    for (const b of blocks) { hh += b.heat ** 2; ll += b.loss ** 2; hl += b.heat * b.loss; hy += b.heat * b.delta; ly += b.loss * b.delta; }
    const determinant = hh * ll - hl ** 2;
    if (blocks.length < 3 || !Number.isFinite(determinant) || hh === 0 || ll === 0 || determinant / (hh * ll) < 0.0001)
      throw new Error('This section needs more heating or cooling variation. Select a longer section, or use a heater-off cooling section.');
    const gain = (hy * ll - ly * hl) / determinant;
    const decay = -(ly * hh - hy * hl) / determinant;
    if (!(gain > 0 && decay > 0)) throw new Error('This section does not match steady heating and cooling. Check the selected section and recorded heater output.');
    capacity = config.power / gain; tau = 1 / decay; resistance = tau / capacity;
    method = 'R and C fitted using measured heater duty and the configured heater power.';
  }
  if (![resistance, capacity, tau].every(n => Number.isFinite(n) && n > 0)) throw new Error('Could not calibrate from this section. Choose another section.');
  let predicted = rows[0].temperature, squared = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].time - rows[i - 1].time;
    const equilibrium = config.ambient + resistance * config.power * (log.hasDuty ? rows[i - 1].duty : 0);
    predicted = equilibrium + (predicted - equilibrium) * Math.exp(-dt / tau);
    squared += (predicted - rows[i].temperature) ** 2;
  }
  return { resistance, capacity, tau, rmse: Math.sqrt(squared / (rows.length - 1)), samples: rows.length, from: rows[0].time, to: rows.at(-1).time, method };
}

// These are observable response settings, not separately identified physical R/C.
export function toResponse(config) {
  return { heatingRate: 60 * config.power / config.capacity, coolingHalfTime: Math.LN2 * config.resistance * config.capacity / 60 };
}
export function toThermal(response) {
  const gain = response.heatingRate / 60, tau = response.coolingHalfTime * 60 / Math.LN2;
  if (![gain, tau].every(v => Number.isFinite(v) && v > 0)) throw new Error('Enter positive heating speed and cooling time.');
  // Fixed normalization. Only heating gain and cooling time affect the simulation.
  const power = 2000, capacity = power / gain;
  return { ambient: 25, power, capacity, resistance: tau / capacity };
}

export function suggestSections(log) {
  // Smooth short-term quantization/noise, then find sustained rises and falls.
  const span = log.rows.at(-1).time - log.rows[0].time;
  const bin = Math.min(30, Math.max(10, span / 4000));
  const groups = []; let start = 0;
  for (let i = 1; i <= log.rows.length; i++) {
    if (i === log.rows.length || log.rows[i].time - log.rows[start].time >= bin) {
      const part = log.rows.slice(start, i);
      groups.push({ time: part[Math.floor(part.length / 2)].time, temperature: part.reduce((s, r) => s + r.temperature, 0) / part.length });
      start = i;
    }
  }
  const find = direction => {
    let first = null;
    const candidates = [];
    function consider(last) {
      if (first === null || last <= first) return;
      const a = groups[first], b = groups[last];
      const change = direction * (b.temperature - a.temperature), duration = b.time - a.time;
      if (change >= 5 && duration >= 30 && (direction > 0 || b.temperature > 27))
        candidates.push({ from: a.time, to: b.time, change });
    }
    for (let i = 1; i < groups.length; i++) {
      const delta = direction * (groups[i].temperature - groups[i - 1].temperature);
      const slope = delta / (groups[i].time - groups[i - 1].time);
      if (slope < 0.001 || (direction < 0 && groups[i].temperature <= 27)) {
        consider(i - 1); first = null;
      } else {
        if (first === null) first = i - 1;
        // Separate a sustained stage change from the preceding stage. Natural
        // exponential slowdown is gradual; heater changes create a sharp step.
        if (i - first >= 4) {
          const recent = direction * (groups[i].temperature - groups[i - 2].temperature) / (groups[i].time - groups[i - 2].time);
          const previous = direction * (groups[i - 2].temperature - groups[i - 4].temperature) / (groups[i - 2].time - groups[i - 4].time);
          if (previous > 0 && recent > 0 && (recent / previous > 2.5 || recent / previous < 0.4)) {
            consider(i - 2); first = i - 2;
          }
        }
      }
    }
    if (groups.length) consider(groups.length - 1);
    return candidates.sort((a, b) => b.change - a.change);
  };
  const heatingCandidates = find(1), coolingCandidates = find(-1);
  return { heating: heatingCandidates[0] || null, cooling: coolingCandidates[0] || null, heatingCandidates, coolingCandidates };
}

export function calibrateResponse(log, current, selection) {
  const config = toThermal(current);
  if (log.hasDuty) {
    if (!selection.measured) throw new Error('Mark a section to use.');
    const fit = fitLog(log, config, selection.measured);
    const coolingOnly = /Cooling-only/.test(fit.method);
    const response = toResponse({ ...config, ...fit });
    if (coolingOnly) response.heatingRate = current.heatingRate;
    if (fit.rmse > 5) throw new Error('The simulation does not match this section closely enough. Check the selected section and heater output.');
    return { ...response, rmse: fit.rmse, method: coolingOnly ? 'Cooling updated; heating speed kept.' : 'Heating and cooling calibrated from recorded heater output.', samples: fit.samples, from: fit.from, to: fit.to };
  }
  if (!selection.cooling) throw new Error('Mark a heater-off cooling section.');
  const cooling = fitLog(log, config, { ...selection.cooling, heaterOff: true });
  const coolingResponse = toResponse({ ...config, ...cooling });
  let heatingRate = current.heatingRate, heatingError = null;
  if (selection.heating) {
    const rows = log.rows.filter(r => r.time >= selection.heating.from && r.time <= selection.heating.to);
    if (rows.length < 6 || rows.at(-1).time - rows[0].time < 30) throw new Error('The heating section needs at least six samples over 30 seconds.');
    if (rows.at(-1).temperature - rows[0].temperature < 5) throw new Error('Select a heating section that rises by at least 5°C.');
    // Once cooling fixes tau, the full-power heating curve has just one unknown:
    // its equilibrium rise. Fit that scalar with the exact step response.
    const tau = cooling.tau, t0 = rows[0].time, initial = rows[0].temperature - 25;
    let xx = 0, xy = 0;
    for (const row of rows) {
      const decay = Math.exp(-(row.time - t0) / tau), x = 1 - decay;
      xx += x * x; xy += x * (row.temperature - 25 - initial * decay);
    }
    const equilibriumRise = xy / xx;
    heatingRate = 60 * equilibriumRise / tau;
    if (!Number.isFinite(heatingRate) || heatingRate <= 0) throw new Error('This section does not look like full-power heating. Choose a different section.');
    heatingError = Math.sqrt(rows.reduce((sum, row) => {
      const decay = Math.exp(-(row.time - t0) / tau);
      const predicted = 25 + initial * decay + equilibriumRise * (1 - decay);
      return sum + (predicted - row.temperature) ** 2;
    }, 0) / rows.length);
  }
  const rmse = Math.max(cooling.rmse, heatingError ?? 0);
  if (rmse > 5) throw new Error(`These sections do not match a steady heating/cooling curve (typical difference ${rmse.toFixed(1)}°C). Check the selected times and whether heater, door, or fans changed.`);
  return { heatingRate, coolingHalfTime: coolingResponse.coolingHalfTime, rmse, method: heatingError === null ? 'Cooling calibrated. Heating speed kept; add a known full-power heating section to calibrate it.' : 'Heating and cooling calibrated.', from: cooling.from, to: cooling.to, samples: cooling.samples };
}

export function suggestCalibrationSections(log) {
  if (log.hasDuty) return [{ from: log.rows[0].time, to: log.rows.at(-1).time, label: 'Recorded heater output' }];
  const stages = suggestSections(log);
  const paired = [], coolingOnly = [];
  for (const cool of stages.coolingCandidates) {
    const heat = stages.heatingCandidates.find(h => h.to <= cool.from && cool.from - h.to <= 90);
    if (heat) paired.push({ from: heat.from, to: cool.to, label: 'Warmup and cooldown', change: heat.change + cool.change });
    coolingOnly.push({ from: cool.from, to: cool.to, label: 'Cooldown', change: cool.change });
  }
  return [...paired.sort((a, b) => b.change - a.change), ...coolingOnly.sort((a, b) => b.change - a.change)];
}

export function calibrateSection(log, current, section) {
  if (!section || !Number.isFinite(section.from) || !Number.isFinite(section.to) || section.to <= section.from) throw new Error('Select one calibration section.');
  if (log.hasDuty) return calibrateResponse(log, current, { measured: section });
  const rows = log.rows.filter(r => r.time >= section.from && r.time <= section.to);
  if (rows.length < 6) throw new Error('Select a longer section with at least six samples.');
  let peak = 0;
  rows.forEach((r, i) => { if (r.temperature > rows[peak].temperature) peak = i; });
  if (rows[peak].temperature - rows.at(-1).temperature < 5) throw new Error('Include a cooldown of at least 5°C in the selected section.');
  const hasHeating = rows[peak].temperature - rows[0].temperature >= 5 && rows[peak].time - rows[0].time >= 30;
  return calibrateResponse(log, current, {
    heating: hasHeating ? { from: rows[0].time, to: rows[peak].time } : null,
    cooling: { from: rows[peak].time, to: rows.at(-1).time },
  });
}
