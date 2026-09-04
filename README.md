# FNIRSI DPS-150 Web Console

A pure-frontend web console for the FNIRSI DPS-150 / DPS-150P programmable DC power supply, built for Chromium-based browsers that support [Web Serial](https://developer.chrome.com/articles/serial/). No backend, no native install — open the page and drive the device from a browser.

> **Non-official project.** FNIRSI is a registered trademark of Shenzhen FNIRSI Technology Co., Ltd. This project is an independent, community-built tool based on publicly available community information; it is not affiliated with or endorsed by the manufacturer, and accuracy/reliability is not guaranteed. Use at your own risk.
>
> 中文版: [docs/zh/README.md](docs/zh/README.md) · Detailed API: [docs/en/API.md](docs/en/API.md) / [docs/zh/API.md](docs/zh/API.md)

## Highlights

- **Live instrument dashboards** — real-time voltage / current / power / temperature telemetry, status lamps (output, CV/CC mode, protection), set-point entry with upper-limit clamping, output on/off with confirmation.
- **Long-run recording** — curves with adjustable display window (pan/zoom), IndexedDB-backed sessions (seconds up to a week, adaptive sampling), CSV export.
- **Presets & protection** — edit/save M1–M6 presets and apply to main setpoint; configure OVP/OCP/OPP/OTP/LVP thresholds.
- **Scan** — voltage / current sweep wizard (step + fixed axis), pre-run confirmation, V-I characteristic plot, results table and CSV export.
- **Sequencer** — table of (V, A, delay) steps with manual/auto execution (loop, start/end index), pre-run confirmation, safe interruption, auto output-off on completion.
- **DSL script area** — edit / syntax-check / run / stop scripts with samples, save, and import/export; full async control API.
- **Settings** — theme (dark/light), baud rate, sampling rate, session capacity cap, confirmation strength, auto-run interruption policy; recipe management (load from device, default, undo, delete, apply).
- **Automation API** — `window.dps150` in the browser console (connect, set, output, presets, protection, brightness/volume, metering, snapshot, event subscription). See [API](docs/en/API.md).
- **Internationalization** — Simplified Chinese and English.

## Quick start

```bash
npm install
npm run dev        # dev server (open in Chrome/Edge, needs localhost/HTTPS)
npm test           # protocol unit tests
npm run build      # production build in dist/
```

Open the printed URL, select **USB (Web Serial)** (or a serial bridge) on the top bar, and connect. Test in an unloaded / low-voltage / low-current state first.

## One-command management (Makefile)

Dependencies: node/npm, python3 (+pyserial), and Playwright Chromium for automated tests. `make doctor` checks and tells you what is missing.

| Command | Purpose |
|---|---|
| `make up` | Start web server (4173) + serial bridge (8787), print the address (idempotent) |
| `make down` | Stop both |
| `make status` / `make logs` | Service status / view logs |
| `make dev` | Frontend dev server (vite dev, foreground) |
| `make build` / `make typecheck` / `make test` | Build / typecheck / unit tests |
| `make smoke` | Headless smoke (needs `make up` first) |
| `make ui-full-proxy` | Full device UI automation (via proxy, headless) |
| `node e2e/edge.cjs` (needs proxy) | Edge suite: invalid input not written / auto-task mutual exclusion / busy disables manual / tooltip / language switch |
| `make device-full` | Device-layer full verification (incl. 1V/50mA no-load RUN) |
| `make perm` | Relax `/dev/ttyACM0` permissions (may need sudo) |
| `make clean` / `make distclean` | Clean build output / also remove node_modules |

Override with `make up PORT=8080 BAUD=9600`; bridge port with `WSPORT=…`. In the browser, open `http://localhost:4173` and select "proxy (ws bridge)".

## Architecture & robustness

- **Activity state machine (Activity Gate)** — `idle / connecting / auto` mutual exclusion for connection and auto tasks (sequence/scan/script); forbids concurrent tasks and manual writes during a run; stop uses request-confirm to avoid deadlock; disconnect stops tasks first. Unit-tested.
- **Defensive validation** — immediate voltage/current input validation (invalid = red box + hint, not written); per-line value validation before sequence/scan/DSL runs; output/setpoint separating zones and a second confirmation.
- **Status alerts** — protection trigger → lamp red fast blink + highlight + hover tooltip (OVP/OCP/OPP/OTP/LVP/CC/CV).
- **i18n** — Simplified Chinese / English; switchable from the footer button or the settings language dropdown (page rebuilt per language).

## Implemented (current progress)

- Protocol core: `src/protocol/` — frame encode/decode, checksum, byte-stream parser with re-sync, RX dispatch, snapshot decode, register constants (22 unit tests).
- Serial transport: `src/serial/` — WebSerial wrapper (read/write/error/disconnect).
- Device controller: `src/device/controller.ts` — session/init/info, write-then-readback, write serialization, push timing statistics.
- Meter page: connect, live telemetry, status lamps, set V/A (clamped), output on/off (with confirm), protocol log.
- Record page: live curve (adjustable window / pause / clear), long-run sampling (IndexedDB sessions, adjustable sample rate & capacity cap), session CSV export, curve PNG/CSV export.
- Presets: M1–M6 edit/save/apply; Protection: OVP/OCP/OPP/OTP/LVP settings.
- Scan page: voltage/current scan wizard, pre-run confirm, V-I plot, results table & CSV export.
- Sequence page: table executor (V,A,delay) — manual/auto (loop/start-end), pre-run confirm, non-interrupting, device-abnormal policy (per settings), auto output-off on completion.
- Script page: edit/syntax-check/run/stop, sample, save + import/export (async on the main thread, full API).
- Settings page: theme/baud/sample rate/capacity/confirmation strength/auto-run interruption; recipe management.
- Storage: `src/storage/` — localStorage settings/recipes (undo + load default), IndexedDB session records, CSV export.
- Automation API: `window.dps150` + `docs/en/API.md` / `docs/zh/API.md`.
- Theme: dark/light, HP-instrument style; palette inspired by [tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen) (MIT).
- UI preview screenshots (real-device data): `docs/screens/*.png`.

## System requirements

WebSerial can only reach the USB serial port enumerated on the **OS running the browser**:

- Windows Chrome/Edge: if the device is bound to WSL via usbipd, run `usbipd list` to find it, then `usbipd attach --wsl --busid <BUSID>` (drop `--wsl` when on the wsl side), then open the page → Connect → select the device.
- Linux Chrome in WSLg: the device appears as `/dev/ttyACM0`; try direct connect first; if Chrome cannot enumerate, use the Windows-side option.
- After connecting, first verify the "Meter → Set → Output" loop at low voltage / small current / no load (with confirmation).

## Local serial bridge & WSL notes

The hardware e2e suites run through a local serial proxy (the browser WebSerial path has a known WSL quirk). For tests only:

```bash
node tools/bridge.cjs 115200 8787            # serial -> WebSocket
PROXY=1 node e2e/ui-full.cjs                  # full UI verification (real device, headless)
python3 tools/selftest_full.py --run-test     # device-layer full verification
```

Manual browser use: pick **proxy (ws bridge)** on the top bar and fill `ws://127.0.0.1:8787` (choice is remembered); USB direct = **USB (WebSerial)**. Device permission: after unplug/replug the node often returns to root:600; `sudo chmod 666 /dev/ttyACM0`.

## Disclaimer & credits

- Non-official project; FNIRSI is a registered trademark, not affiliated.
- Credits: [tinysa-webgen](https://git.sr.ht/~bytewolf/tinysa-webgen) (theme, MIT), [cho45/fnirsi-dps-150](https://github.com/cho45/fnirsi-dps-150) (protocol verification, MIT), [miuser00/fnirst-power-cli](https://github.com/miuser00/fnirst-power-cli) (protocol reference, MIT).
- Operating real loads with this project is at your own risk (as with the CLI / official software).

## License

MIT — see [LICENSE](LICENSE). Bundled fonts (LXGW WenKai) are licensed under the SIL Open Font License 1.1; see `public/fonts/README.txt`.
