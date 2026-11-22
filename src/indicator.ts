// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { VERTICAL } from './compat.js';
import { DashboardSection } from './dashboard.js';
import { GB, KB, fmtSize, fmtSpeed } from './format.js';
import { InterfaceCounters, isCancelled, isPhysicalInterface, parseNetDev, readFile, trafficDelta } from './network.js';
import { SpeedTestPanel } from './speedtestPanel.js';
import { StatsManager, monthKey } from './stats.js';

const SAVE_INTERVAL_SECS = 60;
const BATTERY_MIN_INTERVAL_MS = 3000;
// A gap of more than this many poll intervals means suspend/resume; the delta would be meaningless.
const MAX_SAMPLE_GAP_INTERVALS = 3;
// Stats key for traffic while no application is focused.
const NO_APP = 'System';

// Traffic since login. Module scope outlives the indicator, which is destroyed on every
// screen lock, and is evaluated again only when the shell restarts (a new login).
const sessionTraffic = { rx: 0, tx: 0 };

interface StatRow {
    total: St.Label;
    detail: St.Label;
}

function createStatRow(title: string, color: string): { row: St.BoxLayout; labels: StatRow } {
    const row = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-stat-row' });
    const left = new St.BoxLayout({ x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'speed-meter-stat-left' });
    left.add_child(new St.Widget({
        style_class: 'speed-meter-stat-bullet',
        style: `background-color: ${color};`,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    left.add_child(new St.Label({ text: title, style_class: 'speed-meter-stat-label', y_align: Clutter.ActorAlign.CENTER }));

    const right = new St.BoxLayout({
        ...VERTICAL,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'speed-meter-stat-right',
    });
    const total = new St.Label({ text: '0 B', style_class: 'speed-meter-stat-value', x_align: Clutter.ActorAlign.END });
    const detail = new St.Label({ text: '', style_class: 'speed-meter-stat-sub', x_align: Clutter.ActorAlign.END });
    right.add_child(total);
    right.add_child(detail);

    row.add_child(left);
    row.add_child(right);
    return { row, labels: { total, detail } };
}

function createActionButton(iconName: string, title: string, styleClass: string): St.Button {
    const content = new St.BoxLayout({ style_class: 'speed-meter-button-content' });
    content.add_child(new St.Icon({ icon_name: iconName, style_class: 'speed-meter-button-icon' }));
    content.add_child(new St.Label({ text: title, style_class: 'speed-meter-button-label' }));
    return new St.Button({ style_class: styleClass, child: content, x_expand: true });
}

function wrapInMenuItem(child: St.Widget): PopupMenu.PopupBaseMenuItem {
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    item.add_style_class_name('speed-meter-section');
    item.add_child(child);
    return item;
}

export class SpeedIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass({ GTypeName: 'SpeedMeterIndicator' }, this);
    }

    private _settings: Gio.Settings;
    private _interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    private _windowTracker = Shell.WindowTracker.get_default();
    private _stats = new StatsManager();
    private _cancellable = new Gio.Cancellable();
    private _name: string;

    private _tickId = 0;
    private _saveId = 0;
    private _interval = 0;
    private _reading = false;
    private _upowerSubscriptionId = 0;
    private _powerRequest = 0;
    private _onBattery = false;
    private _counters = new Map<string, InterfaceCounters>();
    private _sampleTime = 0;
    private _interfaceNames = '';
    private _physicalInterfaces = new Set<string>();
    private _activeApp: string | null = NO_APP;

    private _monitoredInterface = '';
    private _autoHideIdle = false;
    private _idleThresholdKb = 0;
    private _useBits = false;
    private _showDownload = true;
    private _showUpload = true;

    private _popup: PopupMenu.PopupMenu;
    private _panelBox: St.BoxLayout;
    private _idleIcon: St.Icon;
    private _downLabel: St.Label;
    private _sepLabel: St.Label;
    private _upLabel: St.Label;
    private _dashboard: DashboardSection;
    private _speedTest: SpeedTestPanel;
    private _statsItem: PopupMenu.PopupBaseMenuItem;
    private _actionsItem: PopupMenu.PopupBaseMenuItem;
    private _statRows: { today: StatRow; month: StatRow; lastMonth: StatRow; session: StatRow };

    constructor(settings: Gio.Settings, name: string, openPreferences: () => void) {
        super(0.0, name, false);
        this._settings = settings;
        this._name = name;
        this._popup = this.menu as PopupMenu.PopupMenu;
        this._readSettings();

        const panelBox = new St.BoxLayout({ style_class: 'speed-meter-box', y_align: Clutter.ActorAlign.CENTER });
        this._panelBox = panelBox;
        this._downLabel = new St.Label({ style_class: 'speed-meter-label', y_align: Clutter.ActorAlign.CENTER });
        this._sepLabel = new St.Label({ text: '│', style_class: 'speed-meter-label speed-meter-sep-label', y_align: Clutter.ActorAlign.CENTER });
        this._upLabel = new St.Label({ style_class: 'speed-meter-label', y_align: Clutter.ActorAlign.CENTER });
        panelBox.add_child(this._downLabel);
        panelBox.add_child(this._sepLabel);
        panelBox.add_child(this._upLabel);
        // Shown instead of the numbers while auto-hide is on and the connection is idle,
        // so the menu stays reachable.
        this._idleIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
            visible: false,
        });
        // PanelMenu.Button only allocates its first child.
        const panelContent = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        panelContent.add_child(this._idleIcon);
        panelContent.add_child(panelBox);
        this.add_child(panelContent);
        this._updateVisibility();

        this._popup.box.add_style_class_name('speed-meter-menu-container');

        this._dashboard = new DashboardSection();
        this._speedTest = new SpeedTestPanel(() => this._showSpeedTest(false));
        this._speedTest.visible = false;

        const statsCard = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-stats-card',
        });
        const today = createStatRow(_('Today'), '#3584e4');
        const month = createStatRow(_('This Month'), '#2ec27e');
        const lastMonth = createStatRow(_('Last Month'), '#c061cb');
        const session = createStatRow(_('Current Session'), '#ffbe6f');
        [today, month, lastMonth, session].forEach(({ row }, index) => {
            if (index > 0)
                statsCard.add_child(new St.Widget({ style_class: 'speed-meter-stat-divider', x_expand: true }));
            statsCard.add_child(row);
        });
        this._statRows = { today: today.labels, month: month.labels, lastMonth: lastMonth.labels, session: session.labels };
        this._statsItem = wrapInMenuItem(statsCard);

        const actions = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-actions-bar' });
        const resetButton = createActionButton('edit-undo-symbolic', _('Reset'), 'speed-meter-button');
        resetButton.connect('clicked', () => {
            sessionTraffic.rx = 0;
            sessionTraffic.tx = 0;
            this._updateStats();
        });
        const speedTestButton = createActionButton('network-wireless-signal-excellent-symbolic', _('Speed Test'),
            'speed-meter-button speed-meter-speedtest-btn');
        speedTestButton.connect('clicked', () => this._showSpeedTest(true));
        const settingsButton = createActionButton('preferences-system-symbolic', _('Settings'), 'speed-meter-button');
        settingsButton.connect('clicked', () => openPreferences());
        actions.add_child(resetButton);
        actions.add_child(speedTestButton);
        actions.add_child(settingsButton);
        this._actionsItem = wrapInMenuItem(actions);

        this._popup.addMenuItem(this._dashboard);
        this._popup.addMenuItem(this._speedTest);
        this._popup.addMenuItem(this._statsItem);
        this._popup.addMenuItem(this._actionsItem);

        this._popup.connect('open-state-changed', (_menu, open: boolean) => {
            if (open) {
                this._dashboard.refreshNetworkInfo();
                this._dashboard.startQualityProbe();
                this._updateStats();
            } else {
                this._dashboard.stopQualityProbe();
            }
        });
        // The theme is reloaded when switching between light and dark style.
        this._popup.box.connect('style-changed', () => this._applyColorScheme());

        this._settings.connectObject('changed', (_settings: Gio.Settings, key: string) => this._onSettingChanged(key), this);
        this._windowTracker.connectObject('notify::focus-app', () => this._updateActiveApp(), this);
        // accent-color only exists since GNOME 47.
        if (this._interfaceSettings.settings_schema.has_key('accent-color'))
            this._interfaceSettings.connectObject('changed::accent-color', () => this._applyAccentColor(), this);
        this._upowerSubscriptionId = Gio.DBus.system.signal_subscribe('org.freedesktop.UPower',
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', '/org/freedesktop/UPower', null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _signal, params) => this._onUPowerChanged(params));
        this.connect('destroy', () => this._releaseResources());

        this._applyColorScheme();
        this._applyAccentColor();
        this._updateActiveApp();
        this._updatePowerState();
        this._restartTimer();
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAVE_INTERVAL_SECS, () => {
            this._stats.save();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private _releaseResources(): void {
        if (this._tickId) {
            GLib.Source.remove(this._tickId);
            this._tickId = 0;
        }
        if (this._saveId) {
            GLib.Source.remove(this._saveId);
            this._saveId = 0;
        }
        Gio.DBus.system.signal_unsubscribe(this._upowerSubscriptionId);
        this._settings.disconnectObject(this);
        this._windowTracker.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        this._cancellable.cancel();
        this._stats.save();
    }

    private _readSettings(): void {
        this._monitoredInterface = this._settings.get_string('monitored-interface').trim();
        this._autoHideIdle = this._settings.get_boolean('auto-hide-idle');
        this._idleThresholdKb = this._settings.get_int('idle-threshold-kb');
        this._useBits = this._settings.get_boolean('use-bits');
        this._showDownload = this._settings.get_boolean('show-download');
        this._showUpload = this._settings.get_boolean('show-upload');
    }

    private _onSettingChanged(key: string): void {
        this._readSettings();
        switch (key) {
        case 'refresh-interval':
            this._restartTimer();
            break;
        case 'adaptive-power-saver':
            this._updatePowerState();
            break;
        case 'show-download':
        case 'show-upload':
            this._updateVisibility();
            break;
        case 'show-top-apps':
            this._updateActiveApp();
            break;
        }
    }

    private _restartTimer(): void {
        if (this._tickId)
            GLib.Source.remove(this._tickId);
        let interval = this._settings.get_int('refresh-interval');
        if (this._onBattery)
            interval = Math.max(BATTERY_MIN_INTERVAL_MS, interval);
        this._interval = interval;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private async _tick(): Promise<void> {
        // A slow read must not overlap the next tick.
        if (this._reading)
            return;
        this._reading = true;
        let text: string;
        try {
            text = await readFile('/proc/net/dev', this._cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.error('SpeedMeter: Failed to read /proc/net/dev', e);
            return;
        } finally {
            this._reading = false;
        }

        const interfaces = parseNetDev(text);
        const names = interfaces.map(i => i.name).join(' ');
        if (names !== this._interfaceNames) {
            this._interfaceNames = names;
            this._physicalInterfaces = new Set(interfaces.map(i => i.name).filter(isPhysicalInterface));
        }
        const counted = interfaces.filter(({ name }) => {
            if (this._monitoredInterface)
                return name === this._monitoredInterface;
            // Without any hardware interface (containers, some VMs) count everything but loopback.
            return this._physicalInterfaces.size > 0 ? this._physicalInterfaces.has(name) : name !== 'lo';
        });
        const { rx: deltaRx, tx: deltaTx } = trafficDelta(this._counters, counted);

        const now = GLib.get_monotonic_time();
        const seconds = (now - this._sampleTime) / 1e6;
        this._sampleTime = now;
        if (seconds <= 0 || seconds > MAX_SAMPLE_GAP_INTERVALS * this._interval / 1000)
            return;

        sessionTraffic.rx += deltaRx;
        sessionTraffic.tx += deltaTx;
        this._stats.update(deltaRx, deltaTx);
        if (this._activeApp)
            this._stats.updateAppUsage(this._activeApp, deltaRx + deltaTx);

        const rxPerSec = deltaRx / seconds;
        const txPerSec = deltaTx / seconds;
        this._dashboard.pushSample(rxPerSec, txPerSec);

        const idle = this._autoHideIdle && (rxPerSec + txPerSec) / KB < this._idleThresholdKb;
        this._panelBox.visible = !idle;
        this._idleIcon.visible = idle;

        if (this._showDownload)
            this._downLabel.text = `${fmtSpeed(rxPerSec, this._useBits)} ↓`;
        if (this._showUpload)
            this._upLabel.text = `${fmtSpeed(txPerSec, this._useBits)} ↑`;

        this._checkQuota();
        if (this._popup.isOpen)
            this._updateStats();
    }

    private _updateVisibility(): void {
        const down = this._showDownload;
        const up = this._showUpload;
        // With both hidden, the download label stays as a small "…" so the menu remains reachable.
        this._downLabel.visible = down || !up;
        this._upLabel.visible = up;
        this._sepLabel.visible = down && up;
        this._downLabel.style_class = `speed-meter-label ${down && up ? 'speed-meter-download-label' : 'speed-meter-single-label'}`;
        this._upLabel.style_class = `speed-meter-label ${down && up ? 'speed-meter-upload-label' : 'speed-meter-single-label'}`;
        if (!down && !up)
            this._downLabel.text = '…';
    }

    private _updateStats(): void {
        const rows = this._statRows;
        const today = this._stats.getToday();
        const month = this._stats.getThisMonth();
        const lastMonth = this._stats.getLastMonth();
        const show = (row: StatRow, rx: number, tx: number) => {
            row.total.text = fmtSize(rx + tx, 2);
            row.detail.text = `(↓ ${fmtSize(rx, 2)}  ↑ ${fmtSize(tx, 2)})`;
        };
        show(rows.today, today.rx, today.tx);
        show(rows.month, month.rx, month.tx);
        show(rows.lastMonth, lastMonth.rx, lastMonth.tx);
        show(rows.session, sessionTraffic.rx, sessionTraffic.tx);
        this._dashboard.updateFromStats(this._stats);
    }

    private _updateActiveApp(): void {
        if (!this._settings.get_boolean('show-top-apps')) {
            this._activeApp = null;
            this._dashboard.setActiveApp(_('Disabled'));
            return;
        }
        const appName = this._windowTracker.focus_app?.get_name();
        this._activeApp = appName || NO_APP;
        this._dashboard.setActiveApp(appName || _('System'));
    }

    private _checkQuota(): void {
        const quotaGb = this._settings.get_int('data-quota-gb');
        if (quotaGb <= 0)
            return;

        const used = this._stats.getThisMonth();
        const ratio = (used.rx + used.tx) / (quotaGb * GB);
        const level = ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : 0;

        // Each level fires once per calendar month. Stored in settings because the
        // extension is disabled on every screen lock.
        const month = monthKey(new Date());
        const [notifiedMonth, notifiedLevel] = this._settings.get_string('quota-notified').split(':');
        if (level <= (notifiedMonth === month ? Number(notifiedLevel) : 0))
            return;
        this._settings.set_string('quota-notified', `${month}:${level}`);

        if (!this._settings.get_boolean('quota-notify'))
            return;
        if (level === 100)
            Main.notify(this._name, _('Monthly data quota of %d GB reached.').format(quotaGb));
        else
            Main.notify(this._name, _('80%% of the monthly data quota (%d GB) used.').format(quotaGb));
    }

    private async _updatePowerState(): Promise<void> {
        // A newer request or UPower signal makes this answer stale.
        const request = ++this._powerRequest;
        let onBattery = false;
        if (this._settings.get_boolean('adaptive-power-saver')) {
            try {
                const reply = await Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower',
                    'org.freedesktop.DBus.Properties', 'Get', new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'OnBattery']),
                    null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
                onBattery = (reply.recursiveUnpack() as [boolean])[0];
            } catch (e) {
                if (isCancelled(e))
                    return;
                // Without UPower there is no battery to save.
            }
        }
        if (request === this._powerRequest)
            this._setOnBattery(onBattery);
    }

    private _onUPowerChanged(params: GLib.Variant): void {
        const [, changed] = params.recursiveUnpack() as [string, Record<string, unknown>, string[]];
        if (!('OnBattery' in changed) || !this._settings.get_boolean('adaptive-power-saver'))
            return;
        this._powerRequest++;
        this._setOnBattery(changed.OnBattery as boolean);
    }

    private _setOnBattery(onBattery: boolean): void {
        if (onBattery !== this._onBattery) {
            this._onBattery = onBattery;
            this._restartTimer();
        }
    }

    private _showSpeedTest(show: boolean): void {
        if (show)
            this._speedTest.loadServers();
        this._speedTest.visible = show;
        this._dashboard.visible = !show;
        this._statsItem.visible = !show;
        this._actionsItem.visible = !show;
    }

    // The shell's light/dark choice depends on session mode, color scheme, high contrast and
    // custom themes, so read the result: dark text in the popup means a light background.
    private _applyColorScheme(): void {
        const box = this._popup.box;
        let light = false;
        if (box.get_stage()) {
            const color = box.get_theme_node().get_foreground_color();
            light = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue < 128;
        }
        if (light)
            box.add_style_class_name('light-mode');
        else
            box.remove_style_class_name('light-mode');
        this._dashboard.setLightMode(light);
    }

    // The stylesheet is tuned for blue; other accents switch to rules derived from
    // -st-accent-color, which St has since GNOME 47, the same release as the setting.
    private _applyAccentColor(): void {
        const custom = this._interfaceSettings.settings_schema.has_key('accent-color') &&
            this._interfaceSettings.get_string('accent-color') !== 'blue';
        if (custom)
            this._popup.box.add_style_class_name('speed-meter-accent');
        else
            this._popup.box.remove_style_class_name('speed-meter-accent');
    }
}

