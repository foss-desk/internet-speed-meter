# ──────────────────────────────────────────────────────────────────────────────
# Internet Speed Meter — Build System
# ──────────────────────────────────────────────────────────────────────────────
#
# Targets:
#   make            — Clean, compile TypeScript, assemble dist/
#   make install    — Build + install to GNOME Shell extensions directory
#   make pack       — Build + create distributable .zip for extensions.gnome.org
#   make pot        — Regenerate the translation template po/$(UUID).pot
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
VERSION    := $(shell sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)

# Toolchain (overridable via environment or command-line arguments)
SHEXLI     ?= $(shell command -v shexli 2>/dev/null || (test -x $(HOME)/.local/bin/shexli && echo $(HOME)/.local/bin/shexli))

.PHONY: all build install pack test uninstall clean logs pot

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
	@for po in $(wildcard po/*.po); do \
		lang=$$(basename $$po .po); \
		mkdir -p $(DIST_DIR)/locale/$$lang/LC_MESSAGES; \
		msgfmt -o $(DIST_DIR)/locale/$$lang/LC_MESSAGES/$(UUID).mo $$po; \
	done
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

# ─── Translations ────────────────────────────────────────────────────────────
# Extracts from the compiled JS (xgettext has no TypeScript parser) and the schema.

pot: build
	@mkdir -p po
	@xgettext --from-code=UTF-8 --keyword=_ --keyword=N_ --add-comments=Translators: \
		--package-name="Internet Speed Meter" --package-version="$(VERSION)" \
		--copyright-holder="MD Mojahid" --msgid-bugs-address="aammojahid@gmail.com" \
		-o po/$(UUID).pot $(DIST_DIR)/*.js $(SRC_DIR)/schemas/*.gschema.xml
	@sed -i \
		-e '1s/.*/# Translation template for Internet Speed Meter (GNOME Shell extension)./' \
		-e '2s/.*/# Copyright (C) 2026 MD Mojahid/' \
		-e '3s/.*/# This file is distributed under the same license as the Internet Speed Meter package (GPL-3.0-or-later)./' \
		-e '4s/.*/# MD Mojahid <aammojahid@gmail.com>, 2026./' \
		po/$(UUID).pot
	@echo "✔ Template updated → po/$(UUID).pot"

# ─── Test (Nested Shell) ─────────────────────────────────────────────────────

test: install
	@echo "▸ Launching nested GNOME Shell…"
	@# GNOME 49+ replaced --nested with --devkit
	@dbus-run-session gnome-shell $$(gnome-shell --help 2>&1 | grep -q -- --devkit && echo --devkit || echo --nested) --wayland &
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
