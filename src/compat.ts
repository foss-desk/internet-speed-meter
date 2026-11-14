// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Clutter from 'gi://Clutter';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// St.BoxLayout gained `orientation` in GNOME 48 and lost `vertical` in GNOME 51.
export const VERTICAL = parseInt(Config.PACKAGE_VERSION) >= 48
    ? { orientation: Clutter.Orientation.VERTICAL }
    : { vertical: true };
