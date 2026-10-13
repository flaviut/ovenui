import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { linter, lintGutter } from '@codemirror/lint';
import { commands, validate } from './validator.js';
import { createPlots } from './plots.js';
import './style.css';

const sample = `Controleo3
# Example syntax only — adapt for your own oven.
name "Example profile"
maximum temperature 260
maximum duty 80/80/80
close door over 2 seconds
convection fan on
display "Preheat"
ramp temperature to 150C in 60 seconds
maintain 150C for 30 seconds
display "Cooling"
element duty cycle 0/0/0
open door over 10 seconds
wait until below 50C
play tune
`;

class ErrorMessage extends WidgetType {
  constructor(message, severity) { super(); this.message = message; this.severity = severity; }
  eq(other) { return other.message === this.message && other.severity === this.severity; }
  toDOM() {
    const node = document.createElement('div');
    node.className = `inline-message ${this.severity}`;
    node.textContent = this.message;
    return node;
  }
}

const inlineErrors = EditorView.decorations.compute(['doc'], state => Decoration.set(
  validate(state.doc.toString()).map(d => Decoration.widget({
    widget: new ErrorMessage(d.message, d.severity), block: true, side: 1,
  }).range(state.doc.lineAt(d.from).to)).sort((a, b) => a.from - b.from), true
));

const status = document.querySelector('#status');
function updateStatus(source) {
  const diagnostics = validate(source);
  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  status.textContent = errors ? `${errors} error${errors === 1 ? '' : 's'}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'No syntax errors';
  status.dataset.state = errors ? 'error' : warnings ? 'warning' : 'valid';
}
let draft = sample;
let updatePlots = () => {};
try { draft = localStorage.getItem('controleo3-draft') ?? sample; } catch {}
const view = new EditorView({
  parent: document.querySelector('#editor'),
  state: EditorState.create({ doc: draft, extensions: [
    basicSetup, lintGutter(), linter(v => validate(v.state.doc.toString()), { delay: 150 }), inlineErrors,
    EditorView.contentAttributes.of({ 'aria-label': 'Controleo3 program', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      const source = update.state.doc.toString();
      updateStatus(source);
      updatePlots();
      try { localStorage.setItem('controleo3-draft', source); } catch {}
    }),
  ] }),
});
updateStatus(draft);
updatePlots = createPlots(() => view.state.doc.toString());
const feedback = document.querySelector('#feedback');
document.querySelector('#copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(view.state.doc.toString()); feedback.textContent = 'Copied.'; }
  catch { feedback.textContent = 'Clipboard unavailable. Select the program and copy with Ctrl/Cmd+C.'; }
});
document.querySelector('#download').addEventListener('click', () => {
  const blob = new Blob([view.state.doc.toString()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'PROFILE.TXT'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  feedback.textContent = 'Downloaded PROFILE.TXT.';
});
const argumentLabels = {
  deviation: 'Temperature difference (°C)', 'maximum temperature': 'Temperature (°C)',
  'initialize timer': 'Seconds', 'maximum duty': 'Bottom / top / boost (%)',
  'open door': 'Duration (seconds)', 'close door': 'Duration (seconds)',
  bias: 'Bottom / top / boost weights', 'ramp temperature': 'Target (°C), duration (seconds)',
  'element duty cycle': 'Bottom / top / boost (%)', 'wait for': 'Duration (seconds)',
  'wait until above': 'Temperature (°C)', 'wait until below': 'Temperature (°C)',
  'door percentage': 'Opening (%), duration (seconds)', maintain: 'Temperature (°C), duration (seconds)',
  'show graph': 'Maximum temperature (°C), duration (seconds)', 'graph divider': 'Temperature (°C)',
  'start plotting': 'Start time (seconds)',
};
for (const [name, count] of Object.entries(commands)) {
  const row = document.createElement('div');
  const code = document.createElement('code'); code.textContent = name;
  const args = document.createElement('span');
  args.textContent = count === 'string' ? `"text" · ${name === 'name' ? 31 : name === 'title' ? 20 : 30} bytes max` : argumentLabels[name] || 'No arguments';
  row.append(code, args); document.querySelector('#reference').append(row);
}
