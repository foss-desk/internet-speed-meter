# make            clean, compile TypeScript, assemble dist/
# make install    build and copy into ~/.local/share/gnome-shell/extensions
# make pack       build and zip for extensions.gnome.org
# make pot        regenerate po/$(UUID).pot
# make check      run the unit tests in tests/ with gjs
# make test       build and run it in a nested GNOME Shell with its own settings
# make uninstall  remove the local installation
# make clean      remove build artifacts

UUID       := speed-meter@mojahid.lunecode.com
EXT_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR    := src
DIST_DIR   := dist
SCHEMA_DIR := $(DIST_DIR)/schemas
TEST_HOME  := $(CURDIR)/.test-home
VERSION    := $(shell sed -n 's/^  "version": "\(.*\)",/\1/p' package.json)

# Local static analyzer that approximates the extensions.gnome.org review; optional.
SHEXLI     ?= $(shell command -v shexli 2>/dev/null || (test -x $(HOME)/.local/bin/shexli && echo $(HOME)/.local/bin/shexli))

.PHONY: all build install pack check test uninstall clean logs pot

all: clean build

build:
	@echo "Installing dependencies…"
	@npm ci --silent
	@echo "Compiling TypeScript…"
	@npm run build --silent
	@cp $(SRC_DIR)/metadata.json $(DIST_DIR)/
	@cp $(SRC_DIR)/stylesheet.css $(DIST_DIR)/
	@mkdir -p $(SCHEMA_DIR)
	@cp $(SRC_DIR)/schemas/*.xml $(SCHEMA_DIR)/
	@glib-compile-schemas --strict $(SCHEMA_DIR)/
	@for po in $(wildcard po/*.po); do \
		lang=$$(basename $$po .po); \
		mkdir -p $(DIST_DIR)/locale/$$lang/LC_MESSAGES; \
		msgfmt -o $(DIST_DIR)/locale/$$lang/LC_MESSAGES/$(UUID).mo $$po; \
	done
	@echo "Built into $(DIST_DIR)/"

install: build
	@rm -rf $(EXT_DIR)
	@mkdir -p $(EXT_DIR)
	@cp -r $(DIST_DIR)/* $(EXT_DIR)/
	@echo "Installed to $(EXT_DIR)"
	@echo "Run: gnome-extensions enable $(UUID)"

pack: build
	@rm -f $(UUID).zip
	@cd $(DIST_DIR) && zip -qr ../$(UUID).zip . -x "*.map" "schemas/gschemas.compiled"
	@echo "Created $(UUID).zip"
	@if [ -n "$(SHEXLI)" ]; then \
		$(SHEXLI) $(UUID).zip; \
	fi

# xgettext has no TypeScript parser, so strings are extracted from the compiled JS.
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
	@echo "Updated po/$(UUID).pot"

check: build
	@gjs -m tests/run.js

# dbus-run-session gives the nested shell its own bus, so `gnome-extensions enable` must run
# inside that session. The XDG dirs keep it away from the real dconf database and extensions.
# GNOME 49+ replaced --nested with --devkit.
test: build
	@rm -rf $(TEST_HOME)
	@mkdir -p $(TEST_HOME)/data/gnome-shell/extensions/$(UUID) $(TEST_HOME)/config $(TEST_HOME)/cache
	@cp -r $(DIST_DIR)/* $(TEST_HOME)/data/gnome-shell/extensions/$(UUID)/
	@XDG_DATA_HOME=$(TEST_HOME)/data XDG_CONFIG_HOME=$(TEST_HOME)/config XDG_CACHE_HOME=$(TEST_HOME)/cache \
		dbus-run-session -- sh -c '\
			gnome-shell $$(gnome-shell --help 2>&1 | grep -q -- --devkit && echo --devkit || echo --nested) --wayland & \
			sleep 3; gnome-extensions enable $(UUID); wait'

logs:
	@journalctl -f -o cat | grep --line-buffered -i "speed-meter\|speed meter"

uninstall:
	@rm -rf $(EXT_DIR)
	@echo "Removed $(EXT_DIR)"

clean:
	@rm -rf $(DIST_DIR) $(TEST_HOME)
	@rm -f $(UUID).zip
