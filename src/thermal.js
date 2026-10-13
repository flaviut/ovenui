import { commands, stripComment, validate } from './validator.js';

export const defaults = { ambient: 25, resistance: 0.5, capacity: 10000, power: 2000 };

// Exact solution for a lumped thermal RC circuit with constant heater input.
export function rcStep(temperature, seconds, { ambient, resistance, capacity, power }, duty) {
  const equilibrium = ambient + resistance * power * duty;
  return equilibrium + (temperature - equilibrium) * Math.exp(-seconds / (resistance * capacity));
}

export function simulate(source, parameters = defaults) {
  const config = { ...defaults, ...parameters };
  if (!Number.isFinite(config.ambient) || !['resistance', 'capacity', 'power'].every(k => Number.isFinite(config[k]) && config[k] > 0))
    throw new Error('Enter a finite ambient temperature and positive R, C, and heater power.');
  if (![config.resistance * config.capacity, config.resistance * config.power].every(n => Number.isFinite(n) && n > 0))
    throw new Error('R × C and R × power must be finite, positive values.');
  if (validate(source).some(d => d.severity === 'error')) throw new Error('Fix the syntax errors to see the plots.');
  const keys = Object.keys(commands).sort((a, b) => b.length - a.length);
  const points = [{ time: 0, ideal: config.ambient, estimated: config.ambient }];
  const notes = new Set();
  let temperature = config.ambient, ideal = config.ambient, time = 0;
  let duty = 0, cap = 1, mode = 'manual', maximum = 260, halted = false;
  const maxTime = 7 * 24 * 3600;
  function advance(seconds, targetAt = null, until = null) {
    const start = time;
    // Exact plant solution with controller updates once per simulated second.
    const step = 1;
    const limit = Math.min(seconds, maxTime - time);
    let elapsed = 0;
    while (elapsed < limit && !halted) {
      if (until && until(temperature)) break;
      let dt = Math.min(step, limit - elapsed);
      if (targetAt) {
        const target = targetAt(elapsed + dt / 2);
        // Feed-forward heat loss plus proportional feedback (60 s correction).
        duty = Math.max(0, Math.min(cap, (target - config.ambient) / (config.resistance * config.power)
          + (target - temperature) * config.capacity / (config.power * 60)));
      }
      // For a fixed-duty threshold wait, solve the crossing time analytically.
      if (until) {
        const equilibrium = config.ambient + config.resistance * config.power * duty;
        const ratio = (until.threshold - equilibrium) / (temperature - equilibrium);
        if (ratio > 0 && ratio < 1) dt = Math.min(dt, -config.resistance * config.capacity * Math.log(ratio) + 1e-6);
      }
      temperature = rcStep(temperature, dt, config, duty);
      elapsed += dt; time = start + elapsed;
      ideal = targetAt ? targetAt(elapsed) : null;
      if (temperature > maximum) {
        notes.add(`Estimate exceeds maximum temperature (${maximum}°C). Simulation stops at the abort point.`);
        halted = true;
      }
      // Keep charts small while preserving every segment endpoint.
      if (time - points.at(-1).time >= 10 || elapsed >= limit || halted || (until && until(temperature)))
        points.push({ time, ideal, estimated: temperature });
    }
    if (time > points.at(-1).time) points.push({ time, ideal, estimated: temperature });
    if (until && !until(temperature) && !halted) {
      notes.add('Temperature wait was not reached within the seven-day simulation limit. Plot stops here.'); halted = true;
    }
    if (time >= maxTime && !halted) { notes.add('Plot stops at the seven-day simulation limit.'); halted = true; }
  }
  for (const [index, raw] of source.split('\n').entries()) {
    if (halted) break;
    const line = stripComment(raw).trim().toLowerCase();
    const command = keys.find(k => line.startsWith(k) && (line.length === k.length || /[\s"\d:=]/.test(line[k.length])));
    if (!command || commands[command] === 'string' || index === 0) continue;
    const numbers = (line.slice(command.length).match(/\d+/g) || []).map(Number);
    if (command === 'maximum temperature') maximum = numbers[0];
    else if (command === 'maximum duty') cap = numbers.reduce((a, b) => a + Math.min(b, 100), 0) / 300;
    else if (command === 'element duty cycle') {
      mode = 'manual'; duty = numbers.reduce((a, b) => a + Math.min(b, 100), 0) / 300;
      ideal = null; points.push({ time, ideal, estimated: temperature });
    } else if (command === 'ramp temperature' || command === 'maintain') {
      mode = 'controlled';
      const from = ideal ?? temperature, target = numbers[0], duration = Math.max(1, numbers[1]);
      if (target >= maximum) notes.add(`Target ${target}°C reaches or exceeds the ${maximum}°C maximum temperature.`);
      if (target > config.ambient + config.resistance * config.power * cap)
        notes.add(`Target ${target}°C exceeds the model's full-power equilibrium at the current duty limit.`);
      if (command === 'maintain') points.push({ time, ideal: target, estimated: temperature });
      else points.push({ time, ideal: from, estimated: temperature });
      advance(duration, command === 'maintain' ? () => target : t => from + (target - from) * t / duration);
    } else if (command === 'wait for' || command.startsWith('wait until')) {
      if (mode === 'controlled') { duty = 0; mode = 'manual'; notes.add('A wait after ramp/maintain disables heating, as in the firmware.'); }
      ideal = null; points.push({ time, ideal, estimated: temperature });
      if (command === 'wait for') advance(numbers[0]);
      else {
        const threshold = command === 'wait until below' ? Math.max(25, numbers[0]) : Math.min(maximum, numbers[0]);
        const until = command === 'wait until below' ? t => t < threshold : t => t > threshold;
        until.threshold = threshold;
        const equilibrium = config.ambient + config.resistance * config.power * duty;
        if (!until(temperature) && !until(equilibrium)) { notes.add(`Line ${index + 1}: temperature wait cannot be reached with this heater input and ambient temperature. Plot stops here.`); halted = true; }
        else if (!until(temperature)) advance(maxTime - time, null, until);
      }
    } else if (command === 'user taps screen') {
      notes.add(`Line ${index + 1}: plot stops at user taps screen because its duration is unknown.`); halted = true;
    } else if (/door|fan|bias/.test(command)) notes.add('Door, fan, and element bias effects are not modeled. R stays constant; manual element powers are equally weighted.');
  }
  return { points, notes: [...notes], duration: time, tau: config.resistance * config.capacity };
}
