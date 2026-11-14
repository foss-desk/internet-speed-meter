// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SpeedIndicator } from './indicator.js';

export default class SpeedMeterExtension extends Extension {
    private _indicator: SpeedIndicator | null = null;

    enable(): void {
        this._indicator = new SpeedIndicator(this.getSettings(), this.metadata.name, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable(): void {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
