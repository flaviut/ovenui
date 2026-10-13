import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, rcStep, simulate } from './thermal.js';
const profile = body => `Controleo3\n# ${'x'.repeat(100)}\nname "Test"\nmaximum temperature 1000\n${body}\n`;
test('RC has the analytic one-time-constant step and passive decay', () => {
  const config = { ambient: 20, resistance: 0.5, capacity: 200, power: 1000 };
  assert.ok(Math.abs(rcStep(20, 100, config, 1) - (20 + 500 * (1 - Math.exp(-1)))) < 1e-9);
  assert.ok(Math.abs(rcStep(120, 100, config, 0) - (20 + 100 * Math.exp(-1))) < 1e-9);
  assert.ok(Math.abs(rcStep(rcStep(120, 50, config, 0), 50, config, 0) - rcStep(120, 100, config, 0)) < 1e-9);
});
test('ramps and holds have correct ideal endpoints and a lagging estimate', () => {
  const result = simulate(profile('ramp temperature to 150C in 60 seconds\nmaintain 150C for 30 seconds'));
  assert.equal(result.duration, 90);
  assert.equal(result.points.at(-1).ideal, 150);
  assert.ok(result.points.at(-1).estimated < 150);
  assert.equal(result.tau, defaults.resistance * defaults.capacity);
  assert.ok(result.points.every(p => Number.isFinite(p.estimated) && Number.isFinite(p.time)));
});
test('manual full-power heating follows the RC solution and has no ideal target', () => {
  const result = simulate(profile('element duty cycle 100/100/100\nwait for 100'));
  assert.ok(Math.abs(result.points.at(-1).estimated - rcStep(25, 100, defaults, 1)) < 1e-8);
  assert.equal(result.points.at(-1).ideal, null);
});
test('cooling threshold ends at its analytic crossing time', () => {
  const config = { ambient: 25, resistance: 1, capacity: 100, power: 100 };
  const source = profile('element duty cycle 100/100/100\nwait for 100\nelement duty cycle 0/0/0\nwait until below 50');
  const hot = rcStep(25, 100, config, 1);
  const expected = 100 + 100 * Math.log((hot - 25) / 25);
  const result = simulate(source, config);
  assert.ok(Math.abs(result.duration - expected) < 0.01);
  assert.ok(result.points.at(-1).estimated < 50);
});
test('unreachable waits and user input stop later stages', () => {
  const result = simulate(profile('element duty cycle 0/0/0\nwait until above 100\nmaintain 500 for 100'));
  assert.equal(result.duration, 0);
  assert.match(result.notes.join(' '), /cannot be reached/);
  assert.equal(simulate(profile('wait for 10\nuser taps screen\nwait for 100')).duration, 10);
});
test('abort temperatures and invalid configuration are surfaced', () => {
  const result = simulate(profile('maximum temperature 30\nelement duty cycle 100/100/100\nwait for 100'));
  assert.ok(result.duration < 100);
  assert.match(result.notes.join(' '), /abort point/);
  assert.throws(() => simulate(profile('wait for 10'), { resistance: 0 }), /positive/);
  assert.throws(() => simulate('Controleo3\nname "Test"\nbad command'), /syntax/);
});
