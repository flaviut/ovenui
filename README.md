# ovenui

Two browser pages, no backend or account:

- **Program:** paste a Controleo3 program, see inline errors, compare ideal and simulated temperature on one chart, and copy or download `PROFILE.TXT`.
- **Calibrate simulation:** import a CSV log from any program, choose one suggested calibration section, adjust it, and save calibration. Zoom to the selection, pan through a long cycle, or return to the full log overview. Drag on the chart, use the large sliders below it, nudge boundaries by ten seconds, or enter times. Mobile selection values appear above the plot.

Drafts, simulation settings, the last calibration, the imported CSV, and its markings stay in local storage on that browser. Files are processed locally. The CSV import limit is 10 MB; saved logs are compressed before being stored; storage failure is reported. The site is published at https://controleo-profile-editor.oai614916.chatgpt.site.

## Run and check

Requires Node.js 20.19+ or 22.12+.

```sh
npm ci
npm run dev
npm test
npm run build
```

Serve `dist/` on any static host. Both `index.html` and `calibrate.html` are built; relative asset paths support repository subdirectories.

## Calibration

The interface uses **heating speed near room temperature** (°C/min) and **cooling half-time** (minutes). Room temperature is fixed at 25°C. R and C are not user controls.

Native Controleo3 CSVs have a profile-name line followed by `seconds,temperature` rows. The app splits sustained rising and falling stages, excluding holds, and suggests adjacent warmup/cooldown sections plus cooling-only alternatives. The suggestions picker exposes separate sections in multi-stage logs; zoom, pan, and the overview make long cycles easier to select. Only one continuous range is selected at a time. Suggestions do not establish heater state: the page explains that native logs must come from known full-power heating and heater-off cooling with unchanged door/fan state. There are no confirmation checkboxes. Selecting and using a section defines those assumptions. A warmup followed by cooldown uses its peak as the transition; cooling-only ranges preserve heating strength. Long holds prevent automatic pairing of heating and cooling across the hold.

Cooling regression fits `ln(T-25)` against time, estimating the decay constant. With that decay known, a full-power warmup within the selected range identifies heating strength through the exact step response. A cooling-only calibration preserves the previous heating strength and explicitly reports that it remains uncalibrated. This avoids claiming that temperature-only data identify physical R and C separately.

Extended logs may include `time,temperature,duty (%)` headers, with measured total duty 0–100%; `duty_fraction` accepts 0–1. Duty applies from a row to the next row. Integral least squares identifies heating gain and thermal decay. Time must increase without duplicates or resets. Fits require six samples, 30 seconds, and 5°C of temperature variation. Native cooling samples must be at least 2°C above ambient. Nonphysical, insufficiently excited, or poor fits are rejected. Forward temperature prediction error is reported as a typical temperature difference.

## Simulation and syntax limits

The underlying single-node model is `C dT/dt = P duty - (T-25)/R`, expressed through heating gain and cooling half-time. It uses exact constant-input thermal updates with an approximate controller recalculated once per second. This is not the firmware PID or a validated firing schedule. Door/fan changes, radiation, separate glass temperature, and varying heat loss are not modeled. Element duty triplets assume equally powered elements.

Ideal temperature shows ramp and hold targets; manual duty and temperature waits have no ideal target. Waits use simulated temperature for duration. Simulation stops at an estimated maximum-temperature abort, unreachable wait, user input, or seven days.

Syntax signatures and string limits follow [Controleo3's parser](https://github.com/engineertype/Controleo3/blob/76404dde356d32f53dbd56d96584679f8278034c/examples/ReflowWizard/ReadProfiles.ino) and `ReflowWizard.h`. Use `Controleo3` as the first line, then `name "Your profile"`, then one instruction per line. Commands are case insensitive; strings use double quotes; `#` and `//` introduce comments outside strings. Unlike the permissive firmware scanner, the editor reports unknown commands, extra/missing arguments, missing names, negative/decimal numbers, and overflow. Firmware string truncation and files below 100 bytes produce warnings.

Built with CodeMirror and Vite.

A synthetic warmup/cooldown log is included in `examples/demo-controleo-log.csv` for testing calibration. It represents 18°C/min initial heating and a 20-minute cooling half-time.
