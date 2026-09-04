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
PREVIEW_LOG := $(RUN_DIR)/preview.log
BRIDGE_LOG  := $(RUN_DIR)/bridge.log
NODE_MIN   := 18
PY         := python3

.PHONY: help doctor deps dev build typecheck test test-watch \
        preview-start preview-stop preview-status bridge-start bridge-stop bridge-status \
        up down status logs perm \
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
	@node -e "require('playwright')" 2>/dev/null || { echo "✗ Missing playwright (node dep). Run: npm install"; exit 1; }
	@node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 || { echo "✗ Missing Chromium (playwright). Run: npx playwright install chromium"; exit 1; }

device_check:
	@test -e $(DEV) || { echo "✗ Device $(DEV) not found. Plug in DPS-150 USB (check usbipd attach / VM passthrough), then: sudo chmod 666 $(DEV)"; exit 1; }
	@test -r $(DEV) -a -w $(DEV) || { echo "✗ $(DEV) not readable/writable. Run: sudo chmod 666 $(DEV)"; exit 1; }

deps: node_check ## Install/update node deps (npm install)
	@test -d node_modules || npm install
	@echo "✓ node deps ready"

doctor: node_check python_check ## Environment check (versions/deps/device)
	@echo "node:   $$(node -v 2>/dev/null)  npm: $$(npm -v 2>/dev/null)"
	@$(PY) --version 2>/dev/null
	@$(PY) -c "import serial; print('pyserial', serial.VERSION)" 2>/dev/null || echo "pyserial: not installed (pip3 install pyserial)"
	@node -e "console.log('playwright:', require('playwright/package.json').version)" 2>/dev/null || echo "playwright: not installed (npm install)"
	@if [ -e $(DEV) ]; then ls -l $(DEV); else echo "Device: not found $(DEV)"; fi

# ---------------------------------------------------------------- Build / test --
typecheck: node_check ## Type check
	npx tsc --noEmit

build: node_check ## Type check + production build (dist/)
	npm run build

test: node_check ## Run unit tests (vitest)
	npx vitest run

test-watch: node_check ## Unit tests (watch)
	npx vitest

# ---------------------------------------------------------------- Run (services) --
dev: node_check ## Front-end dev server (vite dev, foreground)
	npm run dev

$(RUN_DIR):
	@mkdir -p $(RUN_DIR)

preview-start: node_check build $(RUN_DIR) ## Start web service (vite preview, background; log .run/preview.log)
	@# If already running healthily, pass through (idempotent)
	if curl -sf -o /dev/null http://127.0.0.1:$(PORT)/; then echo "✓ preview already running http://localhost:$(PORT)/"; exit 0; fi
	# If the port is held by a non-healthy process, clean it up first
	fuser -k $(PORT)/tcp 2>/dev/null || true
	sleep 1
	for i in 1 2 3; do
	  setsid nohup npx vite preview --host 127.0.0.1 --port $(PORT) --strictPort > $(PREVIEW_LOG) 2>&1 < /dev/null &
	  sleep 4
	  if curl -sf -o /dev/null http://127.0.0.1:$(PORT)/; then
	    echo "✓ preview started: http://localhost:$(PORT)/"
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

bridge-start: python_check pyserial_check device_check $(RUN_DIR) ## Start serial bridge (WebSocket, background; log .run/bridge.log)
	@node -e "require('ws')" 2>/dev/null || { echo "✗ Missing ws dep. Run: npm install"; exit 1; }
	# If already running, just report success
	if (exec 3<>/dev/tcp/127.0.0.1/$(WSPORT)) 2>/dev/null; then exec 3>&- 3<&-; echo "✓ bridge already running ws://127.0.0.1:$(WSPORT)"; exit 0; fi
	fuser -k $(WSPORT)/tcp 2>/dev/null || true
	pkill -f "[s]erialpipe.py" 2>/dev/null || true
	sleep 1
	for i in 1 2 3; do
	  setsid nohup node tools/bridge.cjs $(BAUD) $(WSPORT) > $(BRIDGE_LOG) 2>&1 < /dev/null &
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

perm: ## Release device permissions (may need sudo, will prompt)
	@if [ -e $(DEV) ]; then chmod 666 $(DEV) 2>/dev/null && echo "✓ $(DEV) released" || echo "Need sudo, run: sudo chmod 666 $(DEV)"; else echo "✗ Device $(DEV) not found, plug it in first"; fi

# ---------------------------------------------------------------- Automated verification --
smoke: node_check playwright_check ## Headless smoke (page mount/tabs/theme, requires make up first)
	$(MAKE) preview-start
	node e2e/smoke.cjs

ui-full-proxy: node_check playwright_check ## Full real-device UI automation (via proxy, headless; requires device)
	$(MAKE) preview-start
	$(MAKE) bridge-start
	PROXY=1 node e2e/ui-full.cjs

device-full: python_check pyserial_check device_check ## Device-layer full-feature verification (python, incl. 1.0V/50mA no-load RUN segment)
	$(PY) tools/selftest_full.py --run-test

test-suite: node_check python_check playwright_check $(RUN_DIR) ## Run full automated test suite and generate report (docs/TEST_REPORT.md)
	node tools/run-suite.mjs

# ---------------------------------------------------------------- Clean --
clean: ## Clean build artifacts and logs
	rm -rf dist $(RUN_DIR)
	@echo "Cleaned dist/ and .run/"

distclean: clean ## Deep clean (including node_modules)
	rm -rf node_modules
	@echo "Cleaned node_modules (run make deps to reinstall)"
