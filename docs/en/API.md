# DPS-150 Web Console — Automation API Guide

> 中文版: [docs/zh/API.md](../zh/API.md)

> This project is a **pure frontend** implementation (Web Serial, Chromium browsers). Besides the GUI, we expose the **full device capability** as a browser JavaScript API, so you can automate from the DevTools console, bookmark scripts, or the "Advanced · Script" area.

## Entry point

After the page loads, `window.dps150` is ready:

```js
dps150;                 // inspect the object (with method docs)
dps150.state;           // live device state snapshot (read-only)
```

> The automation runs in **your current browser session**, sharing the same device connection and state as the page UI — naturally consistent, no race conditions; writes are serialized by the controller.

## Quick start (console example)

```js
// 1. connect (system device picker opens, select the DPS-150)
await dps150.connect();

// 2. read current state (setpoint / measured / protection / limits…)
dps150.state.settings.voltageSet;   // current voltage setpoint
dps150.state.limits.maxVoltage;     // voltage upper limit (≈ input voltage − 0.2)

// 3. set voltage / current (auto-clamped to the limit and read back)
await dps150.setVoltage(12.0);
await dps150.setCurrent(1.0);

// 4. enable / disable output (confirm load safety first!)
await dps150.enableOutput();
await dps150.disableOutput();

// 5. subscribe to telemetry, print for 3 s
const off = dps150.onTelemetry((s) => console.log(s.telemetry.vout, s.telemetry.iout));
setTimeout(off, 3000);

// 6. disconnect
await dps150.disconnect();
```

## Common methods and conventions

| Method | Description |
|---|---|
| `connect()` / `disconnect()` | Connect (OS port picker) / disconnect (send session close, then close port) |
| `setVoltage(v)` / `setCurrent(a)` | Set voltage (V) / current limit (A); auto-clamped to limits; write-then-readback snapshot |
| `enableOutput()` / `disableOutput()` / `setOutput(run)` | Output RUN / STOP (⚠ dangerous; confirm load safety in your script) |
| `setPreset(n, v, a)` | Write preset slot M1–M6 (does not change the main setpoint) |
| `loadPreset(n)` | Load preset: write slot + mirror to main setpoint (official behavior) |
| `setProtection(kind, value)` | `kind ∈ ovp\|ocp\|opp\|otp\|lvp` (write protection threshold and read back) |
| `setBrightness(v)` / `setVolume(v)` | Brightness / volume (device supports; confirmed working) |
| `setMetering(on)` | Metering switch (D8); when on and output RUN, the device pushes D9/DA each cycle |
| `refresh()` | Actively pull a full FF snapshot and refresh `state` |
| `state` (property) | `DeviceState`: `info / telemetry / status / limits / settings / presets / protections / telemetryPeriodMs` |
| `onTelemetry(cb)` `onState(cb)` `onLog(cb)` | Event subscriptions, return unsubscribe; `cb(state)` fires each frame/state update |

State fields at a glance:

```js
state.info            // { modelName:"DPS-150P", hwVersion:"V1.0", fwVersion:"V1.6", ident:1 }
state.telemetry       // { inputVoltage, outputVoltage, outputCurrent, outputPower, temperature, capacityAh, energyWh, ts }
state.status          // { output:"RUN"|"STOP", protection:"OK"|"OVP"|"OCP"|"OPP"|"OTP"|"LVP", mode:"CC"|"CV" }
state.limits          // { maxVoltage, maxCurrent }   (pushed by device E2/E3)
state.settings        // { voltageSet, currentSet, brightness, volume, meteringOn }
state.presets         // [{voltage,current}×6]  M1..M6
state.protections     // { ovp, ocp, opp, otp, lvp }
```

## Script examples (can be tried directly in the console)

```js
// Example 1: safely run a "low-voltage smoke sequence" (write setpoint with output off)
(async () => {
  if (!dps150.connected) await dps150.connect();
  await dps150.setVoltage(1.0);
  await dps150.setCurrent(0.05);
  console.log('ready at 1.0V/50mA');
})();

// Example 2: subscribe and accumulate telemetry for 10 s, compute the average
(async () => {
  if (!dps150.connected) await dps150.connect();
  let n = 0, sum = 0;
  const off = dps150.onTelemetry(s => { sum += s.telemetry.vout || 0; n++; });
  await new Promise(r => setTimeout(r, 10000));
  off();
  console.log(`avg vout = ${(sum / n).toFixed(3)} V (${n} samples)`);
})();

// Example 3: write a protection value and restore it (safe with output off)
await dps150.setProtection('ovp', 25);
await dps150.setProtection('ovp', dps150.state.protections.ovp); // restore original
```

## Notes

- **Confirm dangerous operations**: The GUI shows a confirmation dialog for sensitive actions such as enabling output; in scripts, add your own confirmation logic (e.g., warn with `console.log` before running). Examples should always run at **low voltage + small current limit + confirmed no-load / safe load**.
- The protocol is based on publicly available community information; actual behavior may differ — verify against the real device. Accuracy is not guaranteed.
- Automation is tied to the browser page lifecycle: refresh/close disconnects (the controller performs session-close cleanup). For long unattended runs, keep the page open (consider browser background-throttling settings).
