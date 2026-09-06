# ============================================================================
#  DPS-150 Web Console - one-stop management (deps check / run / build / test / clean)
#  Usage: make help
# ============================================================================
SHELL      := /bin/bash
.ONESHELL:
PORT       ?= 4173
# DEV_PORT(5173) is used by vite dev
WSPORT     ?= 8787
BAUD       ?= 115200
DEV        ?= /dev/ttyACM0
RUN_DIR    := .run
# "up-to-date" marker for node_modules (npm >=7 writes it). Any target that needs
# node deps lists this file target, so a first/missing/outdated install is handled
# automatically instead of failing with a cryptic npx/npm error.
NODE_STAMP := node_modules/.package-lock.json
# udev rule installed by `make udev` (permanent /dev/ttyACM* permissions)
UDEV_RULE  := /etc/udev/rules.d/99-fnirsi-dps.rules
PREVIEW_LOG := $(RUN_DIR)/preview.log
BRIDGE_LOG  := $(RUN_DIR)/bridge.log
NODE_MIN   := 18
PY         := python3

.PHONY: help doctor deps dev build typecheck test test-watch \
        preview-start preview-stop preview-status bridge-start bridge-stop bridge-status \
        up down status logs perm udev \
        smoke ui-full-proxy device-full test-suite clean distclean

help: ## Show this help
	@echo "DPS-150 Web Console - common commands:"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[1;32m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Defaults: PORT=$(PORT) WSPORT=$(WSPORT) BAUD=$(BAUD) DEV=$(DEV)  (override with make ... PORT=8080)"

# ---------------------------------------------------------------- Dependency checks --
node_check:
	@command -v node >/dev/null 2>&1 || { echo "✗ Missing Node.js (${NODE_MIN}+). Install: https://nodejs.org or a package manager (e.g. nvm install --lts)"; exit 1; }
	@v=$$(node -p "process.versions.node.split('.')[0]"); \
	  if [ "$$v" -lt "$(NODE_MIN)" ]; then echo "✗ Node.js version too low ($$v < $(NODE_MIN))"; exit 1; fi
	@command -v npx >/dev/null 2>&1 || { echo "✗ Missing npx (ships with Node)"; exit 1; }

python_check:
	@command -v $(PY) >/dev/null 2>&1 || { echo "✗ Missing python3. Install: sudo apt install python3 or https://python.org"; exit 1; }

pyserial_check:
	@$(PY) -c "import serial" 2>/dev/null || { echo "✗ Missing pyserial. Run: pip3 install pyserial"; exit 1; }

playwright_check:
	@node -e "require('playwright')" 2>/dev/null || { echo "✗ Missing playwright (node dep). Run: make deps"; exit 1; }
	@node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 || { echo "✗ Missing Chromium (playwright). Run: npx playwright install chromium"; exit 1; }

device_check:
	@if [ ! -e $(DEV) ]; then \
	  echo "✗ Device $(DEV) not found."; \
	  echo "  1. Plug in the DPS-150 USB (WSL: usbipd attach --wsl; VM: USB passthrough)."; \
	  echo "  2. If no /dev/ttyACM* ever appears, the cdc_acm kernel driver may be missing or not loaded: sudo modprobe cdc_acm  (see README)."; \
	  echo "  3. Found a node under another name? Retry with: make DEV=/dev/ttyACM1 …"; \
	  exit 1; \
	fi
	@if [ ! -r $(DEV) ] || [ ! -w $(DEV) ]; then \
	  echo "✗ $(DEV) not readable/writable by user '$(USER)'."; \
	  echo "  Permanent fix: make udev   (installs a udev rule; needs sudo)"; \
	  echo "  Session fix:   make perm  (or: sudo chmod 666 $(DEV))"; \
	  exit 1; \
	fi

# Real file target, not .PHONY: npm install only runs when the manifests changed
# or node_modules was removed. Kept cheap on every later invocation.
$(NODE_STAMP): package.json package-lock.json
	@echo "⏳ Installing node dependencies (npm install) ..."
	@npm install --no-audit --no-fund

deps: node_check $(NODE_STAMP) ## Install/update node deps (npm install)
	@echo "✓ node deps ready"

doctor: node_check python_check ## Environment check (node/python/pyserial/playwright/cdc_acm/udev/device)
	@echo "== node toolchain =="
	echo "  node:       $$(node -v 2>/dev/null)   npm: $$(npm -v 2>/dev/null)"
	echo "  python:     $$($(PY) --version 2>&1)"
	$(PY) -c "import serial; print('  pyserial:   ok', serial.VERSION)" 2>/dev/null || echo "  pyserial:   ✗ not installed (pip3 install pyserial)"
	node -e "console.log('  playwright: ok', require('playwright/package.json').version)" 2>/dev/null || echo "  playwright: ✗ not installed (make deps, then: npx playwright install chromium)"
	echo "== linux serial driver (cdc_acm) =="
	if [ -d /sys/bus/usb/drivers/cdc_acm ]; then echo "  cdc_acm:    ✓ driver present (kernel built-in or module loaded)"; \
	elif command -v modinfo >/dev/null 2>&1 && modinfo cdc_acm >/dev/null 2>&1; then echo "  cdc_acm:    △ module available but NOT loaded — udev auto-loads it on plug-in; otherwise: sudo modprobe cdc_acm"; \
	else echo "  cdc_acm:    ✗ not available in this kernel (needs CONFIG_USB_ACM) — the device will not appear"; fi
	if ls /dev/ttyACM* /dev/ttyUSB* >/dev/null 2>&1; then echo "  serial:     found: $$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | tr '\n' ' ')"; else echo "  serial:     (no ttyACM/ttyUSB node — plug in the DPS-150)"; fi
	echo "== device & permissions =="
	if [ -e $(DEV) ]; then ls -l $(DEV) | awk '{print "  device:     "$$1" "$$3"."$$4" "$$NF}'; echo "              needs read+write for your user — session: make perm · permanent: make udev"; else echo "  device:     $(DEV) not found (override: make … DEV=/dev/ttyACM1)"; fi
	echo "== udev rule =="
	if [ -f $(UDEV_RULE) ]; then echo "  udev:       ✓ $(UDEV_RULE)"; else echo "  udev:       no DPS-150 rule yet — run: make udev (sudo); non-udev systems: see README"; fi

# ---------------------------------------------------------------- Build / test --
typecheck: node_check $(NODE_STAMP) ## Type check (auto-installs deps on first use)
	npx tsc --noEmit

build: node_check $(NODE_STAMP) ## Type check + production build (dist/; auto npm install)
	npm run build

test: node_check $(NODE_STAMP) ## Run unit tests (vitest)
	npx vitest run

test-watch: node_check $(NODE_STAMP) ## Unit tests (watch)
	npx vitest

# ---------------------------------------------------------------- Run (services) --
dev: node_check $(NODE_STAMP) ## Front-end dev server (vite dev, foreground; auto npm install)
	npm run dev

$(RUN_DIR):
	@mkdir -p $(RUN_DIR)

preview-start: node_check $(RUN_DIR) ## Start web service (vite preview, background; log .run/preview.log)
	@set -e
	# Already running healthily? Pass through (idempotent — and do NOT rebuild in that case)
	if curl -sf -o /dev/null http://127.0.0.1:$(PORT)/; then echo "✓ preview already running http://localhost:$(PORT)/"; exit 0; fi
	# Free the port if it is held by a stale/dead process
	fuser -k $(PORT)/tcp 2>/dev/null || true
	sleep 1
	# Build only when we are really (re)starting; deps auto-install via `make build`
	$(MAKE) build
	for i in 1 2 3; do
	  setsid nohup npx vite preview --host 127.0.0.1 --port $(PORT) --strictPort > $(PREVIEW_LOG) 2>&1 < /dev/null &
	  sleep 4
	  if curl -sf -o /dev/null http://127.0.0.1:$(PORT)/; then
	    echo "✓ preview started: http://localhost:$(PORT)/  (log: $(PREVIEW_LOG))"
	    exit 0
	  fi
	  fuser -k $(PORT)/tcp 2>/dev/null || true
	  sleep 1
	done
	echo "✗ preview failed to start (after 3 retries), logs below:"; tail -n 10 $(PREVIEW_LOG)
	exit 1

preview-stop: ## Stop web service
	@fuser -k $(PORT)/tcp 2>/dev/null; sleep 1; echo "preview stopped (port $(PORT))"

preview-status: ## Web service status
	@if curl -s -o /dev/null http://127.0.0.1:$(PORT)/; then echo "✓ preview: http://localhost:$(PORT)/"; else echo "✗ preview not running"; fi

bridge-start: python_check pyserial_check device_check node_check $(NODE_STAMP) $(RUN_DIR) ## Start serial bridge (WebSocket, background; log .run/bridge.log)
	@set -e
	@node -e "require('ws')" 2>/dev/null || { echo "✗ ws dependency missing. Run: make deps"; exit 1; }
	# Already running? Just report success (idempotent)
	if (exec 3<>/dev/tcp/127.0.0.1/$(WSPORT)) 2>/dev/null; then exec 3>&- 3<&-; echo "✓ bridge already running ws://127.0.0.1:$(WSPORT)"; exit 0; fi
	fuser -k $(WSPORT)/tcp 2>/dev/null || true
	pkill -f "[s]erialpipe.py" 2>/dev/null || true
	sleep 1
	for i in 1 2 3; do
	  SERIAL="$(DEV)" setsid nohup node tools/bridge.cjs $(BAUD) $(WSPORT) > $(BRIDGE_LOG) 2>&1 < /dev/null &
	  sleep 3
	  if (exec 3<>/dev/tcp/127.0.0.1/$(WSPORT)) 2>/dev/null; then exec 3>&- 3<&-; echo "✓ bridge started: ws://127.0.0.1:$(WSPORT) (device $(DEV) @ $(BAUD))"; exit 0; fi
	  fuser -k $(WSPORT)/tcp 2>/dev/null || true
	  pkill -f "[s]erialpipe.py" 2>/dev/null || true
	  sleep 1
	done
	echo "✗ bridge failed to start (after 3 retries), logs below:"; tail -n 10 $(BRIDGE_LOG)
	exit 1

bridge-stop: ## Stop serial bridge (incl. python subprocess)
	@fuser -k $(WSPORT)/tcp 2>/dev/null; pkill -f "[s]erialpipe.py" 2>/dev/null; sleep 1; echo "bridge stopped (port $(WSPORT))"

bridge-status: ## Bridge status
	@if (exec 3<>/dev/tcp/127.0.0.1/$(WSPORT)) 2>/dev/null; then exec 3>&- 3<&-; echo "✓ bridge: ws://127.0.0.1:$(WSPORT)"; else echo "✗ bridge not running"; fi

up: ## One-click start: web + serial bridge (common entry)
	@set -e
	$(MAKE) preview-start
	$(MAKE) bridge-start
	@echo ""
	@echo "Open browser: http://localhost:$(PORT)/  (choose the \"Proxy (ws bridge)\" connection to reach the device)"
	@echo "Stop: make down"

down: preview-stop bridge-stop ## Stop web + bridge

status: preview-status bridge-status ## Service status summary
	@if [ -e $(DEV) ]; then ls -l $(DEV) | awk '{print "Device:", $$1, $$3"."$$4, $$NF}'; else echo "Device: not found $(DEV)"; fi

logs: ## View service logs (press q to quit)
	@echo "===== preview ====="; tail -n 30 $(PREVIEW_LOG) 2>/dev/null || echo "(none)"
	@echo "===== bridge =====";  tail -n 30 $(BRIDGE_LOG) 2>/dev/null || echo "(none)"

perm: ## Give your user access to $(DEV) now (session-only; auto sudo). Permanent: make udev
	@if [ ! -e $(DEV) ]; then \
	  echo "✗ $(DEV) not found."; \
	  if ls /dev/ttyACM* /dev/ttyUSB* >/dev/null 2>&1; then echo "  (found: $$(ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null | tr '\n' ' ') — retry: make perm DEV=…)"; \
	  else echo "  No ttyACM/ttyUSB node at all — is the DPS-150 plugged in and the cdc_acm driver loaded? (make doctor)"; fi; \
	  exit 1; \
	fi
	@if [ -r $(DEV) ] && [ -w $(DEV) ]; then echo "✓ $(DEV) already readable/writable"; \
	elif chmod 666 $(DEV) 2>/dev/null; then echo "✓ $(DEV) now accessible (mode 666, session only)"; \
	elif command -v sudo >/dev/null 2>&1; then sudo chmod 666 $(DEV) && echo "✓ $(DEV) now accessible via sudo (mode 666, session only)" || { echo "✗ sudo chmod failed — run as root: chmod 666 $(DEV)"; exit 1; }; \
	else echo "✗ Need root. Run: sudo chmod 666 $(DEV)"; exit 1; fi
	@echo "Note: replugging the device resets the mode (back to root-owned)."
	@echo "Recommended permanent fix: make udev   (udev rule; non-udev systems: see README)"

udev: ## Install a udev rule so the DPS-150 /dev/ttyACM node is user-accessible (sudo)
	@if [ ! -d /etc/udev/rules.d ] || ! command -v udevadm >/dev/null 2>&1; then \
	  echo "✗ This system does not provide udev/udevadm."; \
	  echo "  Non-udev systems (busybox mdev / static /dev / …): configure your device manager instead — see README “Linux device access”."; \
	  exit 1; \
	fi
	@if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
	@[ -n "$$SUDO" ] || [ "$$(id -u)" = "0" ] || { echo "✗ Neither root nor sudo available — install the rule manually (see README)"; exit 1; }
	@echo "Installing $(UDEV_RULE) — sudo may ask for your password ..."
	@printf '%s\n' 'SUBSYSTEM=="tty", ATTRS{idVendor}=="2e3c", ATTRS{idProduct}=="5740", MODE="0666"' | $$SUDO tee $(UDEV_RULE) >/dev/null \
	  || { echo "✗ Could not write $(UDEV_RULE) (sudo denied / not permitted). Install manually — see README"; exit 1; }
	@$$SUDO udevadm control --reload-rules \
	  || { echo "✗ udevadm control --reload-rules failed."; exit 1; }
	@$$SUDO udevadm trigger --subsystem-match=tty 2>/dev/null || true
	@echo "✓ Installed: $(UDEV_RULE)"
	@echo "  Unplug/replug the DPS-150 (or: sudo udevadm trigger), then verify: make doctor"

# ---------------------------------------------------------------- Automated verification --
smoke: node_check $(NODE_STAMP) playwright_check ## Headless smoke (page mount/tabs/theme; starts preview if needed)
	@set -e
	$(MAKE) preview-start
	node e2e/smoke.cjs

ui-full-proxy: node_check $(NODE_STAMP) playwright_check ## Full real-device UI automation (via proxy, headless; requires device)
	@set -e
	$(MAKE) preview-start
	$(MAKE) bridge-start
	PROXY=1 node e2e/ui-full.cjs

device-full: python_check pyserial_check device_check ## Device-layer full-feature verification (python, incl. 1.0V/50mA no-load RUN segment)
	$(PY) tools/selftest_full.py --run-test

test-suite: node_check $(NODE_STAMP) python_check playwright_check $(RUN_DIR) ## Run full automated test suite and generate report (docs/TEST_REPORT.md)
	node tools/run-suite.mjs

# ---------------------------------------------------------------- Clean --
clean: ## Clean build artifacts and logs
	rm -rf dist $(RUN_DIR)
	@echo "Cleaned dist/ and .run/"

distclean: clean ## Deep clean (including node_modules)
	rm -rf node_modules
	@echo "Cleaned node_modules (run make deps to reinstall)"
