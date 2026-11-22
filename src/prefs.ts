// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { fmtSize } from './format.js';
import { StatsManager } from './stats.js';

Gio._promisify(Gtk.FileDialog.prototype, 'save', 'save_finish');

// Adw row and group titles are Pango markup; escape translated and dynamic text.
const esc = (text: string): string => GLib.markup_escape_text(text, -1);

function addSwitchRow(group: Adw.PreferencesGroup, settings: Gio.Settings, key: string, title: string, subtitle: string): void {
    const row = new Adw.SwitchRow({ title: esc(title), subtitle: esc(subtitle) });
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

function addSpinRow(group: Adw.PreferencesGroup, settings: Gio.Settings, key: string, title: string, subtitle: string,
    lower: number, upper: number, step: number): void {
    const row = new Adw.SpinRow({
        title: esc(title),
        subtitle: esc(subtitle),
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step, page_increment: step * 10 }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
}

export default class SpeedMeterPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        // The shell reads window.visible_page afterwards, which logs a GITypeInfo mismatch warning on GNOME 50.
        Object.defineProperty(window, 'visible_page', {
            get: () => window.get_visible_page(),
            set: (page: Adw.PreferencesPage) => window.set_visible_page(page),
            configurable: true,
        });

        const settings = this.getSettings();

        const displayPage = new Adw.PreferencesPage({
            title: _('Display'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        const general = new Adw.PreferencesGroup({ title: esc(_('General')) });
        displayPage.add(general);
        addSpinRow(general, settings, 'refresh-interval', _('Refresh Interval (ms)'),
            _('Lower values are more responsive but use more CPU (default: 1500)'), 500, 5000, 100);
        const interfaceRow = new Adw.EntryRow({ title: esc(_('Monitored Interface')) });
        settings.bind('monitored-interface', interfaceRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        general.add(interfaceRow);
        addSwitchRow(general, settings, 'use-bits', _('Display in Bits (Mbps / Kbps)'),
            _('Show speeds in bits per second instead of bytes per second'));
        addSwitchRow(general, settings, 'adaptive-power-saver', _('Save Power on Battery'),
            _('Update at most every 3 seconds while on battery'));

        const visibility = new Adw.PreferencesGroup({ title: esc(_('Panel')) });
        displayPage.add(visibility);
        addSwitchRow(visibility, settings, 'show-download', _('Show Download Speed'),
            _('Display incoming bandwidth rate on the top panel'));
        addSwitchRow(visibility, settings, 'show-upload', _('Show Upload Speed'),
            _('Display outgoing bandwidth rate on the top panel'));
        addSwitchRow(visibility, settings, 'show-top-apps', _('Track Traffic per Focused App'),
            _('Attribute traffic to the focused application (an approximation, not per-process)'));
        addSwitchRow(visibility, settings, 'auto-hide-idle', _('Auto-Hide When Idle'),
            _('Show an icon instead of the numbers while the speed is below the threshold'));
        addSpinRow(visibility, settings, 'idle-threshold-kb', _('Idle Threshold (KB/s)'),
            _('Speed threshold under which panel indicators hide'), 1, 500, 1);

        const dataPage = new Adw.PreferencesPage({
            title: _('History'),
            icon_name: 'document-save-symbolic',
        });
        window.add(dataPage);

        const quota = new Adw.PreferencesGroup({ title: esc(_('Data Quota')) });
        dataPage.add(quota);
        addSpinRow(quota, settings, 'data-quota-gb', _('Monthly Data Quota (GB)'),
            _('Set to 0 to disable quota warnings'), 0, 10000, 5);
        addSwitchRow(quota, settings, 'quota-notify', _('Desktop Quota Notifications'),
            _('Show system desktop notifications when reaching 80% and 100% of quota'));

        const exportGroup = new Adw.PreferencesGroup({ title: esc(_('Export')) });
        dataPage.add(exportGroup);
        const exportRow = new Adw.ActionRow({
            title: esc(_('Export Traffic History (CSV)')),
            subtitle: esc(_('Save daily and monthly bandwidth records to a CSV file')),
        });
        const exportButton = new Gtk.Button({
            label: _('Export CSV'),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        exportButton.connect('clicked', () => this._exportCsv(window, exportRow));
        exportRow.add_suffix(exportButton);
        exportGroup.add(exportRow);

        const appGroup = new Adw.PreferencesGroup({
            title: esc(_('Monthly Application Traffic')),
            description: esc(_('Traffic recorded this month while each application was focused.')),
        });
        dataPage.add(appGroup);

        const stats = new StatsManager();
        await stats.ready();
        const apps = stats.getMonthlyAppUsage().slice(0, 10);
        if (apps.length === 0) {
            appGroup.add(new Adw.ActionRow({
                title: esc(_('No Application Traffic Recorded Yet')),
                subtitle: esc(_('Bandwidth will be attributed to applications as network activity occurs.')),
            }));
        }
        for (const app of apps) {
            const row = new Adw.ActionRow({
                title: esc(app.appName),
                subtitle: esc(_('Monthly total: %s').format(fmtSize(app.bytes, 2))),
            });
            row.add_prefix(new Gtk.Image({ icon_name: 'application-x-executable-symbolic' }));
            appGroup.add(row);
        }
    }

    private async _exportCsv(window: Adw.PreferencesWindow, row: Adw.ActionRow): Promise<void> {
        const dialog = new Gtk.FileDialog({ title: _('Export Traffic History'), initial_name: 'speed-meter-stats.csv' });
        let file: Gio.File;
        try {
            file = await dialog.save(window, null);
        } catch {
            // Dismissed by the user.
            return;
        }
        try {
            // Read from disk now so the export includes everything the extension saved since this window opened.
            const stats = new StatsManager();
            await stats.ready();
            await file.replace_contents_async(new TextEncoder().encode(stats.exportToCsv()), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            row.subtitle = esc(_('Exported to %s').format(file.get_parse_name()));
        } catch (e) {
            row.subtitle = esc(_('Export failed: %s').format((e as Error).message));
        }
    }
}
