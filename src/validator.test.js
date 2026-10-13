import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from './validator.js';
const profile = body => `Controleo3\n# ${'A'.repeat(100)}\nname "Test"\n${body}\n`;
const errors = text => validate(text).filter(d => d.severity === 'error');
test('accepts firmware-style units, separators, mixed case, and quoted comments', () => {
  assert.deepEqual(validate(profile('Ramp temperature to 150C in 60 seconds\nmaximum duty 80/80/80\ndisplay "# // text"\nplay tune // done')), []);
});
test('reports typos on the correct line', () => {
  const source = profile('door close 2');
  const d = errors(source)[0];
  assert.match(d.message, /Unknown command/);
  assert.equal(source.slice(d.from, d.to), 'door close 2');
});
test('catches missing arguments, quotes, extra arguments, and overflow', () => {
  for (const command of ['ramp temperature 100', 'maximum duty 100 100', 'name "unfinished', 'play beep 1', 'wait for 65536', 'wait for -1', 'wait for 1.5']) {
    assert.ok(errors(profile(command)).length > 0, command);
  }
});
test('requires exact header and one name before commands', () => {
  assert.ok(errors(profile('play tune').replace('Controleo3', 'controleo3')).length);
  assert.ok(errors(profile('name "Duplicate"')).some(d => /only one/.test(d.message)));
  assert.ok(errors('Controleo3\nplay tune').some(d => /before other/.test(d.message)));
  assert.deepEqual(errors(profile('play tune').replaceAll('\n', '\r\n')), []);
});
test('warns on firmware truncation and ignored short files', () => {
  assert.ok(validate(profile(`title "${'x'.repeat(21)}"`)).some(d => d.severity === 'warning'));
  assert.ok(validate('Controleo3\nname "Test"').some(d => /100 bytes/.test(d.message)));
});
