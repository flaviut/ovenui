// Command signatures from Controleo3/examples/ReflowWizard/ReadProfiles.ino.
export const commands = {
  name: 'string', title: 'string', display: 'string',
  deviation: 1, 'maximum temperature': 1, 'initialize timer': 1,
  'start timer': 0, 'stop timer': 0, 'maximum duty': 3,
  'open door': 1, 'close door': 1, bias: 3,
  'convection fan on': 0, 'convection fan off': 0,
  'cooling fan on': 0, 'cooling fan off': 0,
  'ramp temperature': 2, 'element duty cycle': 3,
  'wait for': 1, 'wait until above': 1, 'wait until below': 1,
  'play tune': 0, 'play beep': 0, 'door percentage': 2,
  maintain: 2, 'user taps screen': 0, 'show graph': 2,
  'graph divider': 1, 'start plotting': 1,
};
const lengths = { name: 31, title: 20, display: 30 };
const sorted = Object.keys(commands).sort((a, b) => b.length - a.length);

export function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && (line[i] === '#' || line.slice(i, i + 2) === '//')) return line.slice(0, i);
  }
  return line;
}

export function validate(source) {
  const diagnostics = [];
  let offset = 0, names = 0;
  const lines = source.split('\n');
  const add = (line, message, severity = 'error') => diagnostics.push({
    from: offset, to: offset + line.replace(/\r$/, '').length, message, severity,
  });
  lines.forEach((raw, index) => {
    const line = stripComment(raw).trim();
    if (index === 0) {
      if (raw.replace(/\r$/, '') !== 'Controleo3') add(raw, 'The first line must be exactly Controleo3.');
    } else if (line) {
      const lower = line.toLowerCase();
      const command = sorted.find(key => lower.startsWith(key) &&
        (lower.length === key.length || /[\s"\d:=]/.test(lower[key.length])));
      if (!command) add(raw, 'Unknown command. Open the command reference for valid names.');
      else {
        const args = line.slice(command.length).trim();
        if (command === 'name') {
          if (++names > 1) add(raw, 'A profile can have only one name.');
        } else if (!names) add(raw, 'Add name "Your profile" before other commands.');
        if (commands[command] === 'string') {
          const match = args.match(/^(?:[:=]\s*)?"([^"\r\n]*)"\s*$/);
          if (!match) add(raw, `${command} needs a string enclosed in double quotes.`);
          else if (new TextEncoder().encode(match[1]).length > lengths[command])
            add(raw, `${command} is truncated by the firmware after ${lengths[command]} bytes.`, 'warning');
        } else {
          const numbers = args.match(/\d+/g) || [];
          if (commands[command] === 0 && args) add(raw, `${command} takes no arguments.`);
          else if (numbers.length !== commands[command])
            add(raw, `${command} needs ${commands[command]} number${commands[command] === 1 ? '' : 's'}; found ${numbers.length}.`);
          else if (/-\s*\d|\d\.\d/.test(args)) add(raw, 'Use whole, non-negative numbers.');
          else if (numbers.some(n => Number(n) > 65535)) add(raw, 'Numbers must be between 0 and 65535.');
          // Firmware ignores non-digit delimiters, including units and connecting words.
        }
      }
    }
    offset += raw.length + 1;
  });
  if (!names) diagnostics.push({ from: 0, to: Math.min(10, source.length), severity: 'error', message: 'Missing profile name: add name "Your profile".' });
  if (new TextEncoder().encode(source).length < 100)
    diagnostics.push({ from: 0, to: Math.min(10, source.length), severity: 'warning', message: 'The firmware ignores files smaller than 100 bytes. Add a comment before exporting.' });
  return diagnostics;
}
