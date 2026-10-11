// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { StatsManager } from './stats.js';

export default class SpeedMeterPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();

        // ================= PAGE 1: DISPLAY & MONITOR =================
        const displayPage = new Adw.PreferencesPage({
            title: 'Display & Monitor',
            iconName: 'preferences-desktop-display-symbolic',
        });
        window.add(displayPage);

        // --- General Settings Group ---
        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure network speed sampling rate and measurement units.',
        });
        displayPage.add(generalGroup);

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

        // Monitored Interface
        const ifaceRow = new Adw.EntryRow({
            title: 'Monitored Interface',
        });
        settings.bind('monitored-interface', ifaceRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(ifaceRow);

        // Use Bits instead of Bytes
        const bitsRow = new Adw.SwitchRow({
            title: 'Display in Bits (Mbps / Kbps)',
            subtitle: 'Show speeds in bits per second instead of bytes per second',
        });
        settings.bind('use-bits', bitsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(bitsRow);

        // Adaptive Power Saver
        const powerRow = new Adw.SwitchRow({
            title: 'Adaptive Power & Battery Saver',
            subtitle: 'Automatically reduce polling frequency when on battery power to conserve energy',
        });
        settings.bind('adaptive-power-saver', powerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(powerRow);

        // --- Visibility & Auto-Hide Group ---
        const visibilityGroup = new Adw.PreferencesGroup({
            title: 'Visibility & Auto-Hide',
            description: 'Customize top panel speed indicators and idle behavior.',
        });
        displayPage.add(visibilityGroup);

        // Show Download
        const downloadRow = new Adw.SwitchRow({
            title: 'Show Download Speed',
            subtitle: 'Display incoming bandwidth rate on the top panel',
        });
        settings.bind('show-download', downloadRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(downloadRow);

        // Show Upload
        const uploadRow = new Adw.SwitchRow({
            title: 'Show Upload Speed',
            subtitle: 'Display outgoing bandwidth rate on the top panel',
        });
        settings.bind('show-upload', uploadRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(uploadRow);

        // Show Top Apps
        const topAppsRow = new Adw.SwitchRow({
            title: 'Show Active Applications',
            subtitle: 'Identify and display top network processes in the dropdown menu',
        });
        settings.bind('show-top-apps', topAppsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(topAppsRow);

        // Auto-Hide Idle
        const autoHideRow = new Adw.SwitchRow({
            title: 'Auto-Hide When Idle',
            subtitle: 'Temporarily hide panel speed numbers when total speed is below threshold',
        });
        settings.bind('auto-hide-idle', autoHideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visibilityGroup.add(autoHideRow);

        // Idle Threshold
        const idleSpinRow = new Adw.ActionRow({
            title: 'Idle Threshold (KB/s)',
            subtitle: 'Speed threshold under which panel indicators hide',
        });
        const idleSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 500,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('idle-threshold-kb'),
            }),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('idle-threshold-kb', idleSpin.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        idleSpinRow.add_suffix(idleSpin);
        visibilityGroup.add(idleSpinRow);

        // ================= PAGE 2: DATA & HISTORY =================
        const dataPage = new Adw.PreferencesPage({
            title: 'Data & History',
            iconName: 'document-save-symbolic',
        });
        window.add(dataPage);

        // --- Data Quota & Alerts Group ---
        const quotaGroup = new Adw.PreferencesGroup({
            title: 'Data Quota & Alerts',
            description: 'Set monthly traffic limits and desktop warning notifications.',
        });
        dataPage.add(quotaGroup);

        // Monthly Data Quota (GB)
        const quotaRow = new Adw.ActionRow({
            title: 'Monthly Data Quota (GB)',
            subtitle: 'Set to 0 to disable quota tracking and progress bar',
        });
        const quotaSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10000,
                step_increment: 5,
                page_increment: 50,
                value: settings.get_int('data-quota-gb'),
            }),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('data-quota-gb', quotaSpin.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        quotaRow.add_suffix(quotaSpin);
        quotaGroup.add(quotaRow);

        // Quota Notifications
        const notifyRow = new Adw.SwitchRow({
            title: 'Desktop Quota Notifications',
            subtitle: 'Show system desktop notifications when reaching 80% and 100% of quota',
        });
        settings.bind('quota-notify', notifyRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        quotaGroup.add(notifyRow);

        // --- Data Management & Export ---
        const dataGroup = new Adw.PreferencesGroup({
            title: 'Data Export',
            description: 'Export traffic usage history logs to CSV format.',
        });
        dataPage.add(dataGroup);

        const exportRow = new Adw.ActionRow({
            title: 'Export Traffic History (CSV)',
            subtitle: 'Save daily and monthly bandwidth records to ~/speed-meter-stats.csv',
        });

        const exportBtn = new Gtk.Button({
            label: 'Export CSV',
            iconName: 'document-save-symbolic',
            cssClasses: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        exportBtn.connect('clicked', () => {
            try {
                const statsMgr = new StatsManager(this.path);
                const csvData = statsMgr.exportToCsv();
                const homeDir = GLib.get_home_dir();
                const exportPath = GLib.build_filenamev([homeDir, 'speed-meter-stats.csv']);
                const file = Gio.File.new_for_path(exportPath);

                file.replace_contents_async(
                    new TextEncoder().encode(csvData),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (_, res) => {
                        try {
                            const [ok] = file.replace_contents_finish(res);
                            if (ok) {
                                exportRow.set_subtitle(`Exported successfully to ~/speed-meter-stats.csv`);
                            }
                        } catch (err) {
                            exportRow.set_subtitle(`Export failed: ${(err as Error).message}`);
                        }
                    }
                );
            } catch (err) {
                exportRow.set_subtitle(`Export failed: ${(err as Error).message}`);
            }
        });

        exportRow.add_suffix(exportBtn);
        dataGroup.add(exportRow);

        // --- Monthly App Usage History Group ---
        const appGroup = new Adw.PreferencesGroup({
            title: 'Monthly Application Traffic',
            description: 'Top applications consuming bandwidth during the current month.',
        });
        dataPage.add(appGroup);

        try {
            const statsMgr = new StatsManager(this.path);
            const appList = statsMgr.getMonthlyAppUsage();

            if (appList.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: 'No Application Traffic Recorded Yet',
                    subtitle: 'Bandwidth will be attributed to applications as network activity occurs.',
                });
                appGroup.add(emptyRow);
            } else {
                for (const appItem of appList.slice(0, 10)) {
                    const row = new Adw.ActionRow({
                        title: appItem.appName,
                        subtitle: `Monthly Total: ${this._fmtSize(appItem.bytes)}`,
                    });
                    const icon = new Gtk.Image({
                        iconName: 'application-x-executable-symbolic',
                        pixelSize: 16,
                    });
                    row.add_prefix(icon);
                    appGroup.add(row);
                }
            }
        } catch (e) {}
    }

    private _fmtSize(bytes: number): string {
        if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
        if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${Math.round(bytes)} B`;
    }
}

