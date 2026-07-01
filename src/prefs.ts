// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpeedMeterPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        // --- General Settings Group ---
        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure how network speed is measured and displayed.',
        });
        page.add(generalGroup);

        // Refresh Interval
        const refreshRow = new Adw.ActionRow({
            title: 'Refresh Interval (ms)',
            subtitle: 'Lower values are more responsive but use more CPU (default: 1500)',
        });
        const refreshSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 500,
                upper: 5000,
                step_increment: 100,
                page_increment: 500,
                value: settings.get_int('refresh-interval'),
            }),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('refresh-interval', refreshSpin.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        refreshRow.add_suffix(refreshSpin);
        generalGroup.add(refreshRow);

        // Use Bits instead of Bytes
        const bitsRow = new Adw.SwitchRow({
            title: 'Display in Bits (Mbps/Kbps)',
            subtitle: 'Show speeds in bits per second instead of bytes',
        });
        settings.bind('use-bits', bitsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(bitsRow);

        // --- Visibility Settings Group ---
        const visibilityGroup = new Adw.PreferencesGroup({
            title: 'Visibility',
            description: 'Choose which information to show in the top panel.',
        });
        page.add(visibilityGroup);

        // Show Download
        const downloadRow = new Adw.SwitchRow({
            title: 'Show Download Speed',
        });
        settings.bind('show-download', downloadRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(downloadRow);

        // Show Upload
        const uploadRow = new Adw.SwitchRow({
            title: 'Show Upload Speed',
        });
        settings.bind('show-upload', uploadRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(uploadRow);

        // Show Capsule
        const capsuleRow = new Adw.SwitchRow({
            title: 'Always Show Capsule Background',
            subtitle: 'Keep the rounded background capsule visible even when not hovered',
        });
        settings.bind('show-capsule', capsuleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(capsuleRow);
    }
}
