# ──────────────────────────────────────────────────────────────────────────────
# Internet Speed Meter — Build System
# ──────────────────────────────────────────────────────────────────────────────
#
# Targets:
#   make            — Clean, compile TypeScript, assemble dist/
#   make install    — Build + install to GNOME Shell extensions directory
#   make pack       — Build + create distributable .zip for extensions.gnome.org
#   make test       — Install + launch a nested GNOME Shell for testing
#   make uninstall  — Remove the extension from the local installation
#   make clean      — Remove build artifacts
#
# ──────────────────────────────────────────────────────────────────────────────

UUID       := speed-meter@mojahid.lunecode.com
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR    := src
DIST_DIR   := dist
SCHEMA_DIR := $(DIST_DIR)/schemas

# Toolchain (overridable via environment or command-line arguments)
SHEXLI     ?= $(shell command -v shexli 2>/dev/null || (test -x $(HOME)/.local/bin/shexli && echo $(HOME)/.local/bin/shexli))

.PHONY: all build install pack test uninstall clean logs

# ─── Default ──────────────────────────────────────────────────────────────────

all: clean build

# ─── Build ────────────────────────────────────────────────────────────────────

build:
	@echo "▸ Installing dependencies…"
	@npm install --silent
	@echo "▸ Compiling TypeScript…"
	@npm run build --silent
	@echo "▸ Copying static assets…"
	@cp $(SRC_DIR)/metadata.json $(DIST_DIR)/
	@cp $(SRC_DIR)/stylesheet.css $(DIST_DIR)/
	@mkdir -p $(SCHEMA_DIR)
	@cp $(SRC_DIR)/schemas/*.xml $(SCHEMA_DIR)/
	@echo "▸ Compiling GSettings schemas…"
	@glib-compile-schemas $(SCHEMA_DIR)/
	@echo "✔ Build complete → $(DIST_DIR)/"

# ─── Install ─────────────────────────────────────────────────────────────────

install: build
	@rm -rf $(EXT_DIR)
	@mkdir -p $(EXT_DIR)
	@cp -r $(DIST_DIR)/* $(EXT_DIR)/
	@echo "✔ Installed to $(EXT_DIR)"
	@echo "  Run: gnome-extensions enable $(UUID)"

# ─── Package ─────────────────────────────────────────────────────────────────

pack: build
	@echo "▸ Creating distribution archive…"
	@rm -f $(UUID).zip
	@cd $(DIST_DIR) && zip -r ../$(UUID).zip . -x "*.map" "schemas/gschemas.compiled"
	@echo "✔ Package created → $(UUID).zip"
	@if [ -n "$(SHEXLI)" ]; then \
		echo "▸ Running Shexli static analysis…"; \
		$(SHEXLI) $(UUID).zip; \
	fi

# ─── Test (Nested Shell) ─────────────────────────────────────────────────────

test: install
	@echo "▸ Launching nested GNOME Shell…"
	@dbus-run-session gnome-shell --nested --wayland &
	@sleep 3
	@gnome-extensions enable $(UUID)
	@echo "✔ Extension enabled in nested session"

# ─── Logs ─────────────────────────────────────────────────────────────────────

logs:
	@echo "▸ Streaming GNOME Shell logs (filtered for $(UUID))…"
	@journalctl -f -o cat | grep --line-buffered -i "speed-meter\|speed meter"

# ─── Uninstall ────────────────────────────────────────────────────────────────

uninstall:
	@rm -rf $(EXT_DIR)
	@echo "✔ Extension removed from $(EXT_DIR)"

# ─── Clean ────────────────────────────────────────────────────────────────────

clean:
	@rm -rf $(DIST_DIR)
	@rm -f $(UUID).zip
	@echo "✔ Clean"
