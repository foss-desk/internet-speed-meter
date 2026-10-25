// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { StatsManager } from './stats.js';
import { ActivityGraph } from './graph.js';

const PROC_NET_DEV = '/proc/net/dev';
const SAVE_INTERVAL_MS = 60000;
const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const BITS_PER_BYTE = 8;
const Kb = 1000;
const Mb = Kb * 1000;

const UTF8_DECODER = new TextDecoder('utf-8');
const USER_AGENT = 'internet-speed-meter (GNOME Shell extension; +https://github.com/foss-desk/internet-speed-meter)';

interface StatRowWidgets {
    valueLabel: St.Label;
    subLabel: St.Label;
    lastTotal: string;
    lastSub: string;
}

interface SpeedTestLocation {
    label: string;
    lat: number | null;
    lon: number | null;
}

interface OoklaServer {
    host: string;
    name: string;
    sponsor: string;
}

// Curated set of real-world locations used to bias Ookla's public server-list
// API (speedtest.net) toward a specific region. "Auto" omits lat/lon so the
// API falls back to GeoIP-based nearest-server selection, exactly like the
// official Speedtest apps/CLI. The actual server (sponsor/host) within a
// region is resolved live on every test run - these are just the regional
// anchors the user picks between.
const SPEEDTEST_LOCATIONS: SpeedTestLocation[] = [
    { label: 'Auto · Nearest', lat: null, lon: null },
    { label: 'New York, US', lat: 40.7128, lon: -74.0060 },
    { label: 'San Francisco, US', lat: 37.7749, lon: -122.4194 },
    { label: 'Toronto, CA', lat: 43.6532, lon: -79.3832 },
    { label: 'São Paulo, BR', lat: -23.5505, lon: -46.6333 },
    { label: 'London, UK', lat: 51.5074, lon: -0.1278 },
    { label: 'Frankfurt, DE', lat: 50.1109, lon: 8.6821 },
    { label: 'Dubai, AE', lat: 25.2048, lon: 55.2708 },
    { label: 'Mumbai, IN', lat: 19.0760, lon: 72.8777 },
    { label: 'Singapore, SG', lat: 1.3521, lon: 103.8198 },
    { label: 'Tokyo, JP', lat: 35.6762, lon: 139.6503 },
    { label: 'Sydney, AU', lat: -33.8688, lon: 151.2093 },
];

/**
 * HIGH-PERFORMANCE INTERNET SPEED METER
 * Optimized for minimal CPU/Memory/RAM footprint.
 */
export default class SpeedMeterExtension extends Extension {
    private _prevRx: number = 0;
    private _prevTx: number = 0;
    private _prevTime: number = 0;
    private _hasPrevStats: boolean = false;
    private _timeoutId: number = 0;
    private _saveTimeoutId: number = 0;
    // Speedtest-local timeouts, tracked so disable() can remove any still pending.
    private _speedTestSourceIds: Set<number> = new Set();
    private _indicator: PanelMenu.Button | null = null;
    private _box: St.BoxLayout | null = null;
    private _downLabel: St.Label | null = null;
    private _sepLabel: St.Label | null = null;
    private _upLabel: St.Label | null = null;
    private _procFile: Gio.File | null = null;
    private _settings: Gio.Settings | null = null;
    private _statsManager: StatsManager | null = null;
    private _activityGraph: ActivityGraph | null = null;
    private _ifaceValue: St.Label | null = null;
    private _vpnValue: St.Label | null = null;
    private _ipValue: St.Label | null = null;
    private _publicIpValue: St.Label | null = null;
    private _speedTestPanelItem: PopupMenu.PopupBaseMenuItem | null = null;
    private _activeAppName: string = 'System';
    private _activeAppLabel: St.Label | null = null;
    private _speedTestDownVal: St.Label | null = null;
    private _speedTestUpVal: St.Label | null = null;
    private _speedTestPingVal: St.Label | null = null;
    private _speedTestJitterVal: St.Label | null = null;
    private _speedTestLossVal: St.Label | null = null;
    private _speedTestQualityVal: St.Label | null = null;
    private _speedTestRunBtnLabel: St.Label | null = null;
    private _speedTestServerSub: St.Label | null = null;
    private _speedTestDropdownBtn: St.Button | null = null;
    private _speedTestDropdownArrow: St.Icon | null = null;
    private _speedTestDropdownScroll: St.ScrollView | null = null;
    private _speedTestDropdownItems: { btn: St.Button; check: St.Icon; clickId: number }[] = [];
    private _speedTestLocationIndex: number = 0;
    private _isTestingSpeed: boolean = false;
    private _lastNetworkUpdate: number = 0;
    private _soupSession: Soup.Session | null = null;
    private _soupCancellable: Gio.Cancellable | null = null;
    // Separate, longer-timeout session for speedtest transfers only - the
    // general-purpose session above keeps a short timeout for quick lookups
    // (public IP, etc.) and would otherwise abort large download/upload
    // chunks on slower connections before they complete.
    private _speedTestSession: Soup.Session | null = null;
    private _speedTestCancellable: Gio.Cancellable | null = null;

    private _sessionRx: number = 0;
    private _sessionTx: number = 0;

    private _useBits: boolean = false;
    private _showUpload: boolean = true;
    private _showDownload: boolean = true;
    private _showTopApps: boolean = true;
    private _monitoredInterface: string = '';
    private _dataQuotaGb: number = 0;
    private _quotaNotify: boolean = true;
    private _autoHideIdle: boolean = false;
    private _idleThresholdKb: number = 5;
    private _adaptivePowerSaver: boolean = true;
    private _isOnBattery: boolean = false;
    private _notifiedQuota80: boolean = false;
    private _notifiedQuota100: boolean = false;
    private _notifiedQuotaMonth: string = '';

    private _settingsChangedId: number = 0;
    private _menuOpenStateId: number = 0;
    private _interfaceSettings: Gio.Settings | null = null;
    private _menuStyleChangedId: number = 0;
    private _accentColorChangedId: number = 0;
    private _currentAccentClass: string = '';
    private _hasAccentColorKey: boolean = false;
    private _lastDownText: string = '';
    private _lastUpText: string = '';

    private _statsSectionItem: PopupMenu.PopupBaseMenuItem | null = null;
    private _dashboardItem: PopupMenu.PopupBaseMenuItem | null = null;
    private _actionsItem: PopupMenu.PopupBaseMenuItem | null = null;
    private _dashboardBox: St.BoxLayout | null = null;
    private _statsBox: St.BoxLayout | null = null;
    private _actionsBox: St.BoxLayout | null = null;
    private _vpnIsActive: boolean = false;
    private _vpnColor: string = '';
    private _statToday: StatRowWidgets | null = null;
    private _statThisMonth: StatRowWidgets | null = null;
    private _statLastMonth: StatRowWidgets | null = null;
    private _statSession: StatRowWidgets | null = null;

    enable(): void {
        this._prevRx = 0;
        this._prevTx = 0;
        this._sessionRx = 0;
        this._sessionTx = 0;
        this._prevTime = GLib.get_monotonic_time();
        this._hasPrevStats = false;
        this._isOnBattery = false;
        this._lastDownText = '';
        this._lastUpText = '';
        this._soupCancellable = new Gio.Cancellable();

        try {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            // 'accent-color' only exists on GNOME 46+'s interface schema; older
            // shells simply won't have the key, so every read/connect of it is
            // guarded behind this one cached check.
            this._hasAccentColorKey = this._interfaceSettings.settings_schema.has_key('accent-color');
            if (this._hasAccentColorKey) {
                this._accentColorChangedId = this._interfaceSettings.connect('changed::accent-color', () => {
                    this._applyAccentColor();
                });
            }
        } catch (e) {
            this._interfaceSettings = null;
            this._hasAccentColorKey = false;
        }

        this._statsManager = new StatsManager();
        this._settings = this.getSettings();
        this._loadSettings();
        this._checkBatteryStatus();
        
        this._settingsChangedId = this._settings.connect(
            'changed', (_, key) => {
                this._loadSettings();
                if (key === 'refresh-interval' || key === 'adaptive-power-saver') {
                    this._checkBatteryStatus();
                    this._restartTimer();
                } else if (key === 'show-download' || key === 'show-upload') {
                    this._updateVisibility();
                } else if (key === 'show-top-apps') {
                    this._updateActiveApp();
                }
            },
        );

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._box = new St.BoxLayout({
            style_class: 'speed-meter-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._downLabel = new St.Label({
            text: '',
            style_class: 'speed-meter-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sepLabel = new St.Label({
            text: '\u2502', // │
            style_class: 'speed-meter-label speed-meter-sep-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._upLabel = new St.Label({
            text: '',
            style_class: 'speed-meter-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._downLabel);
        this._box.add_child(this._sepLabel);
        this._box.add_child(this._upLabel);

        this._updateVisibility();

        this._indicator.add_child(this._box);

        this._buildMenu();

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._procFile = Gio.File.new_for_path(PROC_NET_DEV);
        this._restartTimer();

        this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_INTERVAL_MS, () => {
            this._statsManager?.save();
            return GLib.SOURCE_CONTINUE;
        });
    }

    private _buildMenu(): void {
        if (!this._indicator) return;

        if ((this._indicator.menu as any).box) {
            (this._indicator.menu as any).box.add_style_class_name('speed-meter-menu-container');
        }

        // --- DASHBOARD SECTION (Grid + Graph) ---
        const dashboardBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'speed-meter-dashboard'
        });
        this._dashboardBox = dashboardBox;

        const headerBox = new St.BoxLayout({ 
            orientation: Clutter.Orientation.VERTICAL, 
            style_class: 'speed-meter-dashboard-header' 
        });
        
        // 2x2 Grid for Network Info
        const infoGrid = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: 'speed-meter-network-info-grid' });
        
        const row1 = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, x_expand: true, style_class: 'speed-meter-network-row' });
        const ifaceRow = this._createInfoCard('network-wired-symbolic', 'Connection');
        const vpnRow = this._createInfoCard('network-vpn-symbolic', 'VPN Tunnel');
        row1.add_child(ifaceRow.container);
        row1.add_child(vpnRow.container);

        const row2 = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, x_expand: true, style_class: 'speed-meter-network-row' });
        const ipRow = this._createInfoCard('network-transmit-receive-symbolic', 'Local IP');
        const publicIpRow = this._createInfoCard('globe-symbolic', 'Public IP');
        row2.add_child(ipRow.container);
        row2.add_child(publicIpRow.container);

        this._ifaceValue = ifaceRow.value;
        this._vpnValue = vpnRow.value;
        this._ipValue = ipRow.value;
        this._publicIpValue = publicIpRow.value;

        infoGrid.add_child(row1);
        infoGrid.add_child(row2);

        // Active Application Pill Bar
        const appTrackerBar = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'speed-meter-app-tracker-bar'
        });
        const appIcon = new St.Icon({
            icon_name: 'application-x-executable-symbolic',
            style_class: 'speed-meter-app-tracker-icon'
        });
        const appTitle = new St.Label({
            text: 'Active App:',
            style_class: 'speed-meter-app-tracker-title'
        });
        this._activeAppLabel = new St.Label({
            text: this._activeAppName,
            style_class: 'speed-meter-app-tracker-name',
            x_expand: true
        });
        appTrackerBar.add_child(appIcon);
        appTrackerBar.add_child(appTitle);
        appTrackerBar.add_child(this._activeAppLabel);

        headerBox.add_child(infoGrid);
        headerBox.add_child(appTrackerBar);
        dashboardBox.add_child(headerBox);

        // Integrated Graph with Segmented Tab Bar
        const graphWrapper = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'speed-meter-graph-container'
        });

        // Tab Switcher Row
        const tabsBar = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'speed-meter-tabs-bar'
        });

        const tabRealtimeBtn = this._createTabButton('utilities-system-monitor-symbolic', 'Live Wave', true);
        const tabMonthlyBtn = this._createTabButton('x-office-calendar-symbolic', '30-Day Peak', false);

        tabRealtimeBtn.connect('clicked', () => {
            if (this._activityGraph) {
                this._activityGraph.setMode('realtime');
                tabRealtimeBtn.add_style_class_name('speed-meter-tab-active');
                tabMonthlyBtn.remove_style_class_name('speed-meter-tab-active');
            }
        });

        tabMonthlyBtn.connect('clicked', () => {
            if (this._activityGraph) {
                this._activityGraph.setMode('monthly');
                tabMonthlyBtn.add_style_class_name('speed-meter-tab-active');
                tabRealtimeBtn.remove_style_class_name('speed-meter-tab-active');
            }
        });

        tabsBar.add_child(tabRealtimeBtn);
        tabsBar.add_child(tabMonthlyBtn);

        this._activityGraph = new ActivityGraph();
        
        graphWrapper.add_child(tabsBar);
        graphWrapper.add_child(this._activityGraph);
        dashboardBox.add_child(graphWrapper);

        this._dashboardItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._dashboardItem.add_child(dashboardBox);
        (this._indicator.menu as any).addMenuItem(this._dashboardItem);

        // Dedicated Speedtest Panel View Item
        this._speedTestPanelItem = this._buildSpeedTestPanel();
        (this._indicator.menu as any).addMenuItem(this._speedTestPanelItem);

        // --- STATS SECTION (Single Unified Card) ---
        const statsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-stats-card',
        });
        this._statsBox = statsBox;

        const todayRow = this._createStatRow('Today', '#3584e4');
        const thisMonthRow = this._createStatRow('This Month', '#2ec27e');
        const lastMonthRow = this._createStatRow('Last Month', '#c061cb');
        const sessionRow = this._createStatRow('Current Session', '#ffbe6f');

        this._statToday = todayRow.widgets;
        this._statThisMonth = thisMonthRow.widgets;
        this._statLastMonth = lastMonthRow.widgets;
        this._statSession = sessionRow.widgets;

        statsBox.add_child(todayRow.container);
        statsBox.add_child(this._createStatDivider());
        statsBox.add_child(thisMonthRow.container);
        statsBox.add_child(this._createStatDivider());
        statsBox.add_child(lastMonthRow.container);
        statsBox.add_child(this._createStatDivider());
        statsBox.add_child(sessionRow.container);

        this._statsSectionItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._statsSectionItem.add_child(statsBox);
        (this._indicator.menu as any).addMenuItem(this._statsSectionItem);

        // Action Buttons Row (Reset, Speedtest, Settings)
        const actionsBox = new St.BoxLayout({
            style_class: 'speed-meter-actions-bar',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
        });
        this._actionsBox = actionsBox;

        const { button: resetBtn } = this._createButtonWithIcon('edit-undo-symbolic', 'Reset', 'speed-meter-button');
        resetBtn.connect('clicked', () => {
            this._sessionRx = 0;
            this._sessionTx = 0;
            this._updateMenu();
        });

        const { button: speedtestBtn } = this._createButtonWithIcon('network-wireless-signal-excellent-symbolic', 'Speedtest', 'speed-meter-button speed-meter-speedtest-btn');
        speedtestBtn.connect('clicked', () => {
            if (this._speedTestPanelItem) {
                (this._speedTestPanelItem as any).visible = true;
                this._setDefaultViewVisible(false);
                this._runFullSpeedTest();
            }
        });

        const { button: settingsBtn } = this._createButtonWithIcon('preferences-system-symbolic', 'Settings', 'speed-meter-button');
        settingsBtn.connect('clicked', () => {
            this.openPreferences();
        });

        actionsBox.add_child(resetBtn);
        actionsBox.add_child(speedtestBtn);
        actionsBox.add_child(settingsBtn);

        this._actionsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._actionsItem.add_child(actionsBox);
        (this._indicator.menu as any).addMenuItem(this._actionsItem);

        // Update network info only when menu opens
        this._menuOpenStateId = (this._indicator.menu as any).connect('open-state-changed', (_menu: any, open: boolean) => {
            if (open) this._updateNetworkInfo();
        });

        // Re-check whenever the shell restyles the popup (theme reload on light/dark switch).
        this._menuStyleChangedId = (this._indicator.menu as any).box.connect('style-changed', () => this._applyColorScheme());

        this._applyColorScheme();
        this._applyAccentColor();
        this._updateMenu();
    }

    // The shell's light/dark decision depends on the session mode (stock GNOME
    // prefers dark, Ubuntu prefers light), color-scheme, high contrast and any
    // custom theme. So rather than re-deriving that from gsettings, read the text
    // color the theme actually gives the popup: dark text means a light background.
    private _hasDarkText(actor: St.Widget | null | undefined): boolean {
        try {
            if (!actor?.get_stage()) return false;
            const c = actor.get_theme_node().get_foreground_color();
            return 0.2126 * c.red + 0.7152 * c.green + 0.0722 * c.blue < 128;
        } catch (e) {
            return false;
        }
    }

    private _isLightMode(): boolean {
        return this._hasDarkText((this._indicator?.menu as any)?.box);
    }

    private _updateVpnStyle(): void {
        if (!this._vpnValue) return;
        const light = this._isLightMode();
        if (this._vpnIsActive) {
            this._vpnValue.set_style(`color: ${this._vpnColor}; font-weight: bold;`);
        } else {
            this._vpnValue.set_style(`color: ${light ? '#57606a' : 'rgba(255,255,255,0.45)'}; font-weight: 500;`);
        }
    }

    // Applies exactly one of "light-mode"/"dark-mode" to all themed actors -
    // both parent containers and individual section cards receive the class.
    private _applyColorScheme(): void {
        const light = this._isLightMode();
        const menu = this._indicator?.menu as any;
        const menuBox = menu?.box as St.Widget | undefined;
        const menuActor = menu?.actor as St.Widget | undefined;
        const actors = [
            menuActor,
            menuBox,
            this._dashboardItem,
            this._statsSectionItem,
            this._actionsItem,
            this._speedTestPanelItem,
            this._dashboardBox,
            this._statsBox,
            this._actionsBox,
        ];
        for (const actor of actors) {
            if (!actor) continue;
            const a = (actor as any).actor ?? actor;
            if (typeof (a as any).add_style_class_name === 'function') {
                (a as any).add_style_class_name(light ? 'light-mode' : 'dark-mode');
                (a as any).remove_style_class_name(light ? 'dark-mode' : 'light-mode');
            }
        }
        this._activityGraph?.setLightMode(light);
        this._updateVpnStyle();
    }

    // GNOME 46+ system accent colors
    private static readonly ACCENT_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate'];

    private _getAccentColor(): string {
        if (!this._hasAccentColorKey) return 'blue';
        try {
            const accent = this._interfaceSettings?.get_string('accent-color');
            if (accent && SpeedMeterExtension.ACCENT_COLORS.includes(accent)) return accent;
        } catch (e) {
            // fall through to default
        }
        return 'blue';
    }

    private _applyAccentColor(): void {
        const accent = this._getAccentColor();
        const nextClass = `accent-${accent}`;
        if (nextClass === this._currentAccentClass) return;
        const menu = this._indicator?.menu as any;
        const menuBox = menu?.box as St.Widget | undefined;
        const menuActor = menu?.actor as St.Widget | undefined;
        for (const actor of [this._box, menuActor, menuBox, this._dashboardBox, this._statsBox]) {
            if (!actor) continue;
            const a = (actor as any).actor ?? actor;
            if (typeof (a as any).add_style_class_name === 'function') {
                if (this._currentAccentClass) (a as any).remove_style_class_name(this._currentAccentClass);
                (a as any).add_style_class_name(nextClass);
            }
        }
        this._currentAccentClass = nextClass;
    }

    private _setDefaultViewVisible(visible: boolean): void {
        if (this._dashboardItem) (this._dashboardItem as any).visible = visible;
        if (this._statsSectionItem) (this._statsSectionItem as any).visible = visible;
        if (this._actionsItem) (this._actionsItem as any).visible = visible;
    }

    private _createInfoCard(iconName: string, labelText: string): { container: St.BoxLayout, value: St.Label } {
        const container = new St.BoxLayout({ style_class: 'speed-meter-info-card', orientation: Clutter.Orientation.VERTICAL, x_expand: true });
        
        const topRow = new St.BoxLayout({ style_class: 'speed-meter-info-badge-row', orientation: Clutter.Orientation.HORIZONTAL });
        const icon = new St.Icon({ icon_name: iconName, style_class: 'speed-meter-info-icon' });
        const label = new St.Label({ text: labelText, style_class: 'speed-meter-info-label' });
        topRow.add_child(icon);
        topRow.add_child(label);

        const value = new St.Label({ text: '...', style_class: 'speed-meter-info-value' });
        
        container.add_child(topRow);
        container.add_child(value);
        
        return { container, value };
    }

    private _createButtonWithIcon(iconName: string, labelText: string, styleClass: string): { button: St.Button, label: St.Label } {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'speed-meter-button-content',
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'speed-meter-button-icon',
        });
        const label = new St.Label({
            text: labelText,
            style_class: 'speed-meter-button-label',
        });
        box.add_child(icon);
        box.add_child(label);

        const button = new St.Button({
            style_class: styleClass,
            child: box,
            x_expand: true,
        });
        return { button, label };
    }

    private _createTabButton(iconName: string, labelText: string, isActive: boolean): St.Button {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'speed-meter-tab-content',
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'speed-meter-tab-icon',
        });
        const label = new St.Label({
            text: labelText,
            style_class: 'speed-meter-tab-label',
        });
        box.add_child(icon);
        box.add_child(label);

        return new St.Button({
            style_class: isActive
                ? 'speed-meter-tab-button speed-meter-tab-active'
                : 'speed-meter-tab-button',
            child: box,
            x_expand: true,
        });
    }

    private _createStatDivider(): St.Widget {
        return new St.Widget({
            style_class: 'speed-meter-stat-divider',
            x_expand: true,
        });
    }

    private _createStatRow(label: string, dotColor: string = '#3584e4'): { container: St.BoxLayout, widgets: StatRowWidgets } {
        const container = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'speed-meter-stat-row',
        });

        const leftBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'speed-meter-stat-left',
        });
        const dot = new St.Widget({
            style_class: 'speed-meter-stat-bullet',
            style: `background-color: ${dotColor};`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleLabel = new St.Label({
            text: label,
            style_class: 'speed-meter-stat-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        leftBox.add_child(dot);
        leftBox.add_child(titleLabel);

        const rightBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'speed-meter-stat-right',
        });
        const valueLabel = new St.Label({
            text: '0 B',
            style_class: 'speed-meter-stat-value',
            x_align: Clutter.ActorAlign.END,
        });
        const subLabel = new St.Label({
            text: '(\u2193 0 B  \u2191 0 B)',
            style_class: 'speed-meter-stat-sub',
            x_align: Clutter.ActorAlign.END,
        });
        rightBox.add_child(valueLabel);
        rightBox.add_child(subLabel);

        container.add_child(leftBox);
        container.add_child(rightBox);

        const widgets: StatRowWidgets = {
            valueLabel,
            subLabel,
            lastTotal: '',
            lastSub: '',
        };

        return { container, widgets };
    }

    private _updateMenu(): void {
        if (!this._indicator || !this._statsManager || !(this._indicator.menu as any)?.isOpen) return;

        const today = this._statsManager.getToday();
        const thisMonth = this._statsManager.getThisMonth();
        const lastMonth = this._statsManager.getLastMonth();

        this._updateStatRow(this._statToday, today.rx, today.tx);
        this._updateStatRow(this._statThisMonth, thisMonth.rx, thisMonth.tx);
        this._updateStatRow(this._statLastMonth, lastMonth.rx, lastMonth.tx);
        this._updateStatRow(this._statSession, this._sessionRx, this._sessionTx);
        
        if (this._activityGraph) {
            this._activityGraph.updateFromStats(this._statsManager);
        }
    }

    private _updateNetworkInfo(): void {
        const now = GLib.get_monotonic_time() / 1000000;
        if (now - this._lastNetworkUpdate < 30) return;
        this._lastNetworkUpdate = now;
        
        // 1. Get Interface & Connection Type (Async)
        const routeFile = Gio.File.new_for_path('/proc/net/route');
        routeFile.load_contents_async(null, (file, res) => {
            try {
                const [ok, contents] = file!.load_contents_finish(res);
                if (!ok || !contents) return;

                const lines = UTF8_DECODER.decode(contents).split('\n');
                let iface = '';
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].trim().split(/\s+/);
                    if (cols[1] === '00000000') { iface = cols[0]; break; }
                }

                let type = 'Disconnected';
                if (iface) {
                    if (iface.startsWith('wl')) type = 'WiFi';
                    else if (iface.startsWith('eth') || iface.startsWith('en')) type = 'Ethernet';
                    else if (iface.startsWith('ppp')) type = 'Mobile';
                    else if (iface.startsWith('tun') || iface.startsWith('wg')) type = 'VPN Tunnel';
                    else type = 'Wired';
                }
                if (this._ifaceValue) this._ifaceValue.set_text(`${type} (${iface || 'none'})`);

                // Chain the rest of the async checks
                this._continueUpdateNetworkInfo(iface);
            } catch (e) {}
        });
    }

    private _continueUpdateNetworkInfo(iface: string): void {
        // 2. Enhanced Smart VPN & Mesh Network Inspector
        // Interface names from /proc/net/dev (no `ip` subprocess needed)
        Gio.File.new_for_path(PROC_NET_DEV).load_contents_async(this._soupCancellable, (file, res) => {
            let ifaceNames = '';
            try {
                const [ok, contents] = file!.load_contents_finish(res);
                if (!ok || !contents) return;
                ifaceNames = UTF8_DECODER.decode(contents).split('\n').slice(2)
                    .map(l => l.split(':')[0].trim()).join('\n');
            } catch (e) { return; }

            let vpnText = 'None';
            this._vpnIsActive = false;
            this._vpnColor = '';

            if (/tailscale\d+/i.test(ifaceNames)) {
                vpnText = 'Tailscale Mesh';
                this._vpnIsActive = true;
                this._vpnColor = '#2ec27e';
            } else if (/wg\d*|wireguard/i.test(ifaceNames)) {
                vpnText = 'WireGuard';
                this._vpnIsActive = true;
                this._vpnColor = '#3584e4';
            } else if (/warp/i.test(ifaceNames)) {
                vpnText = 'Cloudflare WARP';
                this._vpnIsActive = true;
                this._vpnColor = '#ffbe6f';
            } else if (/zt\w+/i.test(ifaceNames)) {
                vpnText = 'ZeroTier Mesh';
                this._vpnIsActive = true;
                this._vpnColor = '#f66151';
            } else if (/tun\d*|tap\d*|ppp\d*|openvpn/i.test(ifaceNames)) {
                vpnText = 'OpenVPN / TUN';
                this._vpnIsActive = true;
                this._vpnColor = '#2ec27e';
            }

            if (this._vpnValue) {
                this._vpnValue.set_text(vpnText);
                this._updateVpnStyle();
            }
        });

        // 3. Async Local IP
        if (iface) {
            const client = new Gio.SocketClient({
                family: Gio.SocketFamily.IPV4,
                type: Gio.SocketType.DATAGRAM,
                protocol: Gio.SocketProtocol.UDP,
            });
            // A UDP "connect" only picks the outbound route's source address; nothing is sent.
            client.connect_async(Gio.InetSocketAddress.new_from_string('1.1.1.1', 53)!, this._soupCancellable, (c, res) => {
                try {
                    const conn = c!.connect_finish(res);
                    const local = conn.get_local_address() as Gio.InetSocketAddress;
                    this._ipValue?.set_text(local.get_address().to_string());
                    conn.close_async(GLib.PRIORITY_DEFAULT, null, null);
                } catch (e) {}
            });
        }

        // 4. Async Public IP (Soup 3)
        this._fetchPublicIp();

        // 5. Update Active Application tracking
        this._updateActiveApp();
    }

    private _getSoupSession(): Soup.Session {
        if (!this._soupSession) {
            this._soupSession = new Soup.Session({
                user_agent: USER_AGENT,
                timeout: 10,
            });
        }
        return this._soupSession;
    }

    private _fetchPublicIp(): void {
        if (!this._publicIpValue) return;
        this._publicIpValue.set_text('Fetching...');

        const session = this._getSoupSession();
        const message = Soup.Message.new('GET', 'https://api.ipify.org');
        if (!message) {
            this._fetchPublicIpFallback();
            return;
        }

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._soupCancellable as any,
            (sess, res) => {
                try {
                    const bytes = sess?.send_and_read_finish(res);
                    const data = bytes ? bytes.get_data() : null;
                    if (message.get_status() === Soup.Status.OK && data) {
                        const ip = UTF8_DECODER.decode(data).trim();
                        if (ip && this._publicIpValue) {
                            this._publicIpValue.set_text(ip);
                            return;
                        }
                    }
                } catch (e) {}

                this._fetchPublicIpFallback();
            }
        );
    }

    private _fetchPublicIpFallback(): void {
        if (!this._publicIpValue) return;
        const session = this._getSoupSession();
        const message = Soup.Message.new('GET', 'https://icanhazip.com');
        if (!message) {
            if (this._publicIpValue) this._publicIpValue.set_text('Unavailable');
            return;
        }

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._soupCancellable as any,
            (sess, res) => {
                try {
                    const bytes = sess?.send_and_read_finish(res);
                    const data = bytes ? bytes.get_data() : null;
                    if (message.get_status() === Soup.Status.OK && data) {
                        const ip = UTF8_DECODER.decode(data).trim();
                        if (ip && this._publicIpValue) {
                            this._publicIpValue.set_text(ip);
                            return;
                        }
                    }
                } catch (e) {}

                if (this._publicIpValue) {
                    this._publicIpValue.set_text('Unavailable');
                }
            }
        );
    }

    private _updateActiveApp(): void {
        if (!this._showTopApps) {
            this._activeAppName = '';
            if (this._activeAppLabel) this._activeAppLabel.set_text('Disabled');
            return;
        }
        try {
            const tracker = Shell.WindowTracker.get_default();
            const app = tracker.focus_app;
            if (app) {
                const name = app.get_name();
                if (name) {
                    this._activeAppName = name;
                    if (this._activeAppLabel) this._activeAppLabel.set_text(name);
                    return;
                }
            }
        } catch (e) {}
        this._activeAppName = 'System';
        if (this._activeAppLabel) this._activeAppLabel.set_text('System');
    }

    private _buildSpeedTestPanel(): PopupMenu.PopupBaseMenuItem {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false, style_class: 'speed-meter-ookla-panel' });
        const container = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'speed-meter-ookla-box' });

        // ── Header ──────────────────────────────────────────────────────────
        // Left: SPEEDTEST brand  |  Right: close button
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'speed-meter-ookla-header',
        });

        const brandStack = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const brandTitle = new St.Label({
            text: 'SPEEDTEST',
            style_class: 'speed-meter-ookla-brand',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const brandSub = new St.Label({
            text: 'powered by Ookla',
            style_class: 'speed-meter-ookla-brand-sub',
        });
        brandStack.add_child(brandTitle);
        brandStack.add_child(brandSub);

        const closeBtn = new St.Button({
            style_class: 'speed-meter-button speed-meter-close-btn',
            child: new St.Icon({ icon_name: 'window-close-symbolic', style_class: 'speed-meter-button-icon' }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeBtn.connect('clicked', () => {
            this._setSpeedTestDropdownOpen(false);
            if (this._speedTestPanelItem) {
                this._speedTestPanelItem.visible = false;
                this._setDefaultViewVisible(true);
            }
        });

        header.add_child(brandStack);
        header.add_child(closeBtn);

        // ── Server Dropdown Trigger ──────────────────────────────────────────
        const serverDropdownBtn = new St.Button({
            style_class: 'speed-meter-server-dropdown-btn',
            x_expand: true,
            can_focus: true,
        });
        const serverDropdownInner = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'speed-meter-server-dropdown-row',
        });

        const serverLeadingBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'speed-meter-server-leading',
        });
        const serverGlobeIcon = new St.Icon({
            icon_name: 'network-wireless-symbolic',
            style_class: 'speed-meter-server-dropdown-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const serverTextStack = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const serverCaption = new St.Label({
            text: 'SERVER',
            style_class: 'speed-meter-server-caption',
        });
        this._speedTestServerSub = new St.Label({
            text: SPEEDTEST_LOCATIONS[0].label,
            style_class: 'speed-meter-server-dropdown-label',
            x_expand: true,
        });
        serverTextStack.add_child(serverCaption);
        serverTextStack.add_child(this._speedTestServerSub);
        serverLeadingBox.add_child(serverGlobeIcon);
        serverLeadingBox.add_child(serverTextStack);

        this._speedTestDropdownArrow = new St.Icon({
            icon_name: 'pan-down-symbolic',
            style_class: 'speed-meter-server-dropdown-arrow',
            y_align: Clutter.ActorAlign.CENTER,
        });

        serverDropdownInner.add_child(serverLeadingBox);
        serverDropdownInner.add_child(this._speedTestDropdownArrow);
        serverDropdownBtn.set_child(serverDropdownInner);

        this._speedTestDropdownBtn = serverDropdownBtn;
        serverDropdownBtn.connect('clicked', () => {
            if (this._isTestingSpeed) return;
            const isOpen = this._speedTestDropdownScroll?.visible ?? false;
            this._setSpeedTestDropdownOpen(!isOpen);
        });

        // ── Dropdown List ───────────────────────────────────────────────────
        const listContainer = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'speed-meter-server-dropdown-list',
            x_expand: true,
        });

        this._speedTestDropdownItems = [];
        SPEEDTEST_LOCATIONS.forEach((loc, idx) => {
            const isSel = idx === this._speedTestLocationIndex;
            const itemBtn = new St.Button({
                style_class: 'speed-meter-server-dropdown-item' + (isSel ? ' selected' : ''),
                x_expand: true,
                can_focus: true,
            });
            const itemRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'speed-meter-server-item-box',
            });

            // Auto gets a globe, others get a location pin icon
            const itemIcon = new St.Icon({
                icon_name: idx === 0 ? 'network-wireless-symbolic' : 'mark-location-symbolic',
                style_class: 'speed-meter-server-item-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const itemLabel = new St.Label({
                text: loc.label,
                style_class: 'speed-meter-server-item-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const checkIcon = new St.Icon({
                icon_name: 'object-select-symbolic',
                style_class: 'speed-meter-server-item-check',
                y_align: Clutter.ActorAlign.CENTER,
                visible: isSel,
            });
            itemRow.add_child(itemIcon);
            itemRow.add_child(itemLabel);
            itemRow.add_child(checkIcon);
            itemBtn.set_child(itemRow);

            const clickId = itemBtn.connect('clicked', () => {
                this._selectSpeedTestLocation(idx);
            });
            this._speedTestDropdownItems.push({ btn: itemBtn, check: checkIcon, clickId });
            listContainer.add_child(itemBtn);
        });

        this._speedTestDropdownScroll = new St.ScrollView({
            style_class: 'speed-meter-server-dropdown-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            visible: false,
        });
        this._speedTestDropdownScroll.set_child(listContainer);

        // ── Ping / Jitter / Loss Strip ──────────────────────────────────────
        const pingStrip = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-ping-strip',
        });
        const pingBox = this._createOoklaPingMetric('PING', '--');
        const jitterBox = this._createOoklaPingMetric('JITTER', '--');
        const lossBox = this._createOoklaPingMetric('LOSS', '0%');

        this._speedTestPingVal = pingBox.valueLabel;
        this._speedTestJitterVal = jitterBox.valueLabel;
        this._speedTestLossVal = lossBox.valueLabel;

        pingStrip.add_child(pingBox.container);
        pingStrip.add_child(jitterBox.container);
        pingStrip.add_child(lossBox.container);

        // ── Speed Gauges Row ────────────────────────────────────────────────
        const gaugesRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-gauges-row',
        });

        // Download Card
        const downCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-gauge-card speed-meter-down-card',
        });
        const downArrow = new St.Label({ text: '↓', style_class: 'speed-meter-ookla-gauge-arrow speed-meter-down-arrow' });
        const downLabel2 = new St.Label({ text: 'DOWNLOAD', style_class: 'speed-meter-ookla-gauge-title speed-meter-down-title' });
        const downTitleRow = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'speed-meter-gauge-title-row' });
        downTitleRow.add_child(downArrow);
        downTitleRow.add_child(downLabel2);
        this._speedTestDownVal = new St.Label({ text: '--', style_class: 'speed-meter-ookla-gauge-value speed-meter-down-value' });
        const downUnit = new St.Label({ text: 'Mbps', style_class: 'speed-meter-ookla-gauge-unit' });
        downCard.add_child(downTitleRow);
        downCard.add_child(this._speedTestDownVal);
        downCard.add_child(downUnit);

        // Upload Card
        const upCard = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-gauge-card speed-meter-up-card',
        });
        const upArrow = new St.Label({ text: '↑', style_class: 'speed-meter-ookla-gauge-arrow speed-meter-up-arrow' });
        const upLabel2 = new St.Label({ text: 'UPLOAD', style_class: 'speed-meter-ookla-gauge-title speed-meter-up-title' });
        const upTitleRow = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: 'speed-meter-gauge-title-row' });
        upTitleRow.add_child(upArrow);
        upTitleRow.add_child(upLabel2);
        this._speedTestUpVal = new St.Label({ text: '--', style_class: 'speed-meter-ookla-gauge-value speed-meter-up-value' });
        const upUnit = new St.Label({ text: 'Mbps', style_class: 'speed-meter-ookla-gauge-unit' });
        upCard.add_child(upTitleRow);
        upCard.add_child(this._speedTestUpVal);
        upCard.add_child(upUnit);

        gaugesRow.add_child(downCard);
        gaugesRow.add_child(upCard);

        // ── Status Banner ───────────────────────────────────────────────────
        const statusBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-status-box',
        });
        this._speedTestQualityVal = new St.Label({
            text: 'Tap START TEST to measure your connection',
            style_class: 'speed-meter-ookla-status-text',
            x_align: Clutter.ActorAlign.CENTER,
        });
        statusBox.add_child(this._speedTestQualityVal);

        // ── Action Button ────────────────────────────────────────────────────
        const goBtn = new St.Button({
            style_class: 'speed-meter-ookla-go-button',
            x_expand: true,
            can_focus: true,
        });
        const goBtnInner = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'speed-meter-ookla-go-inner',
        });
        const goIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'speed-meter-ookla-go-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._speedTestRunBtnLabel = new St.Label({
            text: 'START TEST',
            style_class: 'speed-meter-ookla-go-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        goBtnInner.add_child(goIcon);
        goBtnInner.add_child(this._speedTestRunBtnLabel);
        goBtn.set_child(goBtnInner);
        goBtn.connect('clicked', () => {
            this._runFullSpeedTest();
        });

        // ── Assemble ─────────────────────────────────────────────────────────
        container.add_child(header);
        container.add_child(serverDropdownBtn);
        container.add_child(this._speedTestDropdownScroll);
        container.add_child(pingStrip);
        container.add_child(gaugesRow);
        container.add_child(statusBox);
        container.add_child(goBtn);

        item.add_child(container);
        (item as any).visible = false; // Hidden by default

        return item;
    }

    private _createOoklaPingMetric(title: string, initVal: string): { container: St.BoxLayout, valueLabel: St.Label } {
        const container = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-ookla-ping-item',
        });
        const lbl = new St.Label({ text: title, style_class: 'speed-meter-ookla-ping-lbl', x_align: Clutter.ActorAlign.CENTER });
        const valueLabel = new St.Label({ text: initVal, style_class: 'speed-meter-ookla-ping-val', x_align: Clutter.ActorAlign.CENTER });
        container.add_child(lbl);
        container.add_child(valueLabel);
        return { container, valueLabel };
    }


    private _notify(msg: string, details?: string): void {
        try {
            if (typeof Main.notify === 'function') {
                Main.notify(msg, details);
            }
        } catch (e) {
            logError(e as Error, 'SpeedMeter: Notification error');
        }
    }

    private _getSpeedTestSoupSession(): Soup.Session {
        if (!this._speedTestSession) {
            this._speedTestSession = new Soup.Session({
                user_agent: USER_AGENT,
                timeout: 25,
            });
        }
        return this._speedTestSession;
    }

    private _setSpeedTestDropdownOpen(open: boolean): void {
        if (!this._speedTestDropdownScroll) return;
        this._speedTestDropdownScroll.visible = open;
        if (this._speedTestDropdownArrow) {
            this._speedTestDropdownArrow.icon_name = open ? 'pan-up-symbolic' : 'pan-down-symbolic';
        }
        if (this._speedTestDropdownBtn) {
            if (open) {
                this._speedTestDropdownBtn.add_style_class_name('active');
            } else {
                this._speedTestDropdownBtn.remove_style_class_name('active');
            }
        }
    }

    private _updateSpeedTestDropdownItems(): void {
        this._speedTestDropdownItems.forEach((item, i) => {
            const isSel = i === this._speedTestLocationIndex;
            if (isSel) {
                item.btn.add_style_class_name('selected');
            } else {
                item.btn.remove_style_class_name('selected');
            }
            item.check.visible = isSel;
        });
    }

    private _selectSpeedTestLocation(idx: number): void {
        if (this._isTestingSpeed) return;
        this._speedTestLocationIndex = idx;
        if (this._speedTestServerSub) {
            this._speedTestServerSub.set_text(SPEEDTEST_LOCATIONS[idx].label);
        }
        if (this._speedTestQualityVal) {
            this._speedTestQualityVal.set_text('Press START TEST to begin');
        }
        this._updateSpeedTestDropdownItems();
        this._setSpeedTestDropdownOpen(false);
    }

    // Resolves a live Ookla (speedtest.net) server for the currently selected
    // region via their public server-list API - probes candidate servers in parallel
    // to choose the lowest-latency, responsive real server.
    private _fetchOoklaServer(callback: (server: OoklaServer | null) => void): void {
        // Captured once and reused for every request this call makes, rather
        // than re-reading `this._speedTestCancellable` each time: disable()
        // cancels the cancellable before nulling the field, so a closure that
        // re-read the field would see `undefined` and silently stop noticing
        // the cancellation, retrying requests against an aborted session.
        const cancellable = this._speedTestCancellable;
        const loc = SPEEDTEST_LOCATIONS[this._speedTestLocationIndex];
        let url = 'https://www.speedtest.net/api/js/servers?engine=js&limit=5&https_functional=true';
        if (loc.lat !== null && loc.lon !== null) {
            url += `&lat=${loc.lat}&lon=${loc.lon}`;
        }

        const session = this._getSpeedTestSoupSession();
        const message = Soup.Message.new('GET', url);
        if (!message) {
            callback(null);
            return;
        }
        message.get_request_headers().append('User-Agent', USER_AGENT);

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable as any,
            (sess, res) => {
                try {
                    const bytes = sess?.send_and_read_finish(res);
                    const data = bytes ? bytes.get_data() : null;
                    if (message.get_status() === Soup.Status.OK && data) {
                        const servers = JSON.parse(UTF8_DECODER.decode(data));
                        if (Array.isArray(servers) && servers.length > 0) {
                            const candidates = servers.slice(0, 4).filter(s => s && s.host);
                            if (candidates.length === 0) {
                                callback(null);
                                return;
                            }

                            let remaining = candidates.length;
                            const validResults: { server: OoklaServer; ping: number }[] = [];
                            let done = false;

                            // Safety timeout for candidate probing: 2000ms.
                            // Tracked so finalize() can remove it immediately
                            // once every candidate has reported, instead of
                            // leaving it to fire uselessly later.
                            let probeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                                this._speedTestSourceIds.delete(probeTimeoutId);
                                probeTimeoutId = 0;
                                finalize();
                                return GLib.SOURCE_REMOVE;
                            });
                            this._speedTestSourceIds.add(probeTimeoutId);

                            const finalize = () => {
                                if (done) return;
                                done = true;
                                // Skip if disable() already removed it.
                                if (probeTimeoutId && this._speedTestSourceIds.delete(probeTimeoutId)) {
                                    GLib.Source.remove(probeTimeoutId);
                                    probeTimeoutId = 0;
                                }
                                if (validResults.length > 0) {
                                    validResults.sort((a, b) => a.ping - b.ping);
                                    callback(validResults[0].server);
                                } else if (candidates.length > 0) {
                                    callback({
                                        host: String(candidates[0].host),
                                        name: String(candidates[0].name ?? ''),
                                        sponsor: String(candidates[0].sponsor ?? ''),
                                    });
                                } else {
                                    callback(null);
                                }
                            };

                            for (const srv of candidates) {
                                const host = String(srv.host);
                                const pingMsg = Soup.Message.new('GET', `https://${host}/speedtest/latency.txt`);
                                if (!pingMsg) {
                                    remaining--;
                                    if (remaining <= 0) finalize();
                                    continue;
                                }
                                pingMsg.get_request_headers().append('User-Agent', USER_AGENT);
                                const startPing = GLib.get_monotonic_time();
                                session.send_and_read_async(pingMsg, GLib.PRIORITY_DEFAULT, cancellable as any, (s2, res2) => {
                                    const elapsedMs = (GLib.get_monotonic_time() - startPing) / 1000;
                                    try {
                                        s2?.send_and_read_finish(res2);
                                        if (pingMsg.get_status() === Soup.Status.OK) {
                                            validResults.push({
                                                server: {
                                                    host,
                                                    name: String(srv.name ?? ''),
                                                    sponsor: String(srv.sponsor ?? ''),
                                                },
                                                ping: elapsedMs,
                                            });
                                        }
                                    } catch (e) {}
                                    remaining--;
                                    if (remaining <= 0) finalize();
                                });
                            }
                            return;
                        }
                    }
                } catch (e) {}
                callback(null);
            }
        );
    }

    // Measures latency against the Ookla server's own latency.txt endpoint
    private _runOoklaLatencyTest(
        host: string,
        callback: (avgMs: string, jitterMs: string, lossPct: number | null) => void
    ): void {
        const session = this._getSpeedTestSoupSession();
        // Captured once - see the comment in _fetchOoklaServer() for why this
        // must not re-read `this._speedTestCancellable` on each call.
        const cancellable = this._speedTestCancellable;
        const attempts = 5;
        const samples: number[] = [];
        let failures = 0;
        let i = 0;

        const step = () => {
            if (cancellable?.is_cancelled()) {
                callback('N/A', 'N/A', null);
                return;
            }
            if (i >= attempts) {
                if (samples.length === 0) {
                    callback('N/A', 'N/A', null);
                    return;
                }
                const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
                const jitter = samples.length > 1
                    ? samples.slice(1).reduce((sum, v, idx) => sum + Math.abs(v - samples[idx]), 0) / (samples.length - 1)
                    : 0;
                callback(`${Math.round(avg)} ms`, `${jitter.toFixed(1)} ms`, (failures / attempts) * 100);
                return;
            }
            i++;

            const msg = Soup.Message.new('GET', `https://${host}/speedtest/latency.txt?x=${Math.random()}`);
            if (!msg) {
                failures++;
                step();
                return;
            }
            msg.get_request_headers().append('User-Agent', USER_AGENT);
            const start = GLib.get_monotonic_time();
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable as any, (sess, res) => {
                try {
                    sess?.send_and_read_finish(res);
                    if (msg.get_status() === Soup.Status.OK) {
                        samples.push((GLib.get_monotonic_time() - start) / 1000);
                    } else {
                        failures++;
                    }
                } catch (e) {
                    failures++;
                }
                step();
            });
        };
        step();
    }

    // Runs `concurrency` parallel streams against the real Ookla server with
    // adaptive chunk sizing and real-time live speed updates.
    private _runOoklaThroughputTest(
        host: string,
        mode: 'download' | 'upload',
        durationMs: number,
        concurrency: number,
        onProgress: (mbps: string) => void,
        onDone: (mbps: string) => void
    ): void {
        const session = this._getSpeedTestSoupSession();
        // Captured once - see the comment in _fetchOoklaServer() for why this
        // must not re-read `this._speedTestCancellable` on each call.
        const cancellable = this._speedTestCancellable;
        const downloadSizes = [500, 750, 1000, 1500, 2000, 2500, 3000, 3500];
        const uploadSizes = [250000, 500000, 1000000, 2000000, 4000000];
        const sizes = mode === 'download' ? downloadSizes : uploadSizes;
        const uploadBuffer = mode === 'upload' ? new Uint8Array(uploadSizes[uploadSizes.length - 1]) : null;

        const startTime = GLib.get_monotonic_time();
        const deadline = startTime + durationMs * 1000;
        let totalBytes = 0;
        let activeWorkers = concurrency;
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            // Skip if disable() already removed it.
            if (safetyTimeoutId && this._speedTestSourceIds.delete(safetyTimeoutId)) {
                GLib.Source.remove(safetyTimeoutId);
                safetyTimeoutId = 0;
            }
            const elapsedSec = (GLib.get_monotonic_time() - startTime) / 1000000;
            const mbps = elapsedSec > 0 && totalBytes > 0
                ? ((totalBytes * 8) / 1000000 / elapsedSec).toFixed(1)
                : '0.0';
            onDone(mbps);
        };

        let safetyTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs + 2000, () => {
            this._speedTestSourceIds.delete(safetyTimeoutId);
            safetyTimeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        this._speedTestSourceIds.add(safetyTimeoutId);

        const workerStep = (sizeIdx: number) => {
            if (finished) return;
            if (GLib.get_monotonic_time() >= deadline || cancellable?.is_cancelled()) {
                activeWorkers--;
                if (activeWorkers <= 0) finish();
                return;
            }

            const idx = Math.max(0, Math.min(sizeIdx, sizes.length - 1));
            const reqStart = GLib.get_monotonic_time();

            const onReqDone = (bytesTransferred: number, ok: boolean) => {
                if (finished) return;
                if (ok) {
                    totalBytes += bytesTransferred;
                    const elapsedSec = (GLib.get_monotonic_time() - startTime) / 1000000;
                    if (elapsedSec > 0.3) {
                        const curMbps = ((totalBytes * 8) / 1000000 / elapsedSec).toFixed(1);
                        onProgress(curMbps);
                    }
                }
                const reqElapsedSec = (GLib.get_monotonic_time() - reqStart) / 1000000;
                let nextIdx = idx;
                if (!ok || reqElapsedSec > 2.5) nextIdx = idx - 1;
                else if (reqElapsedSec < 0.7) nextIdx = idx + 1;
                workerStep(nextIdx);
            };

            if (mode === 'download') {
                const size = sizes[idx];
                const msg = Soup.Message.new('GET', `https://${host}/speedtest/random${size}x${size}.jpg?x=${Math.random()}`);
                if (!msg) {
                    onReqDone(0, false);
                    return;
                }
                msg.get_request_headers().append('User-Agent', USER_AGENT);
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable as any, (sess, res) => {
                    let bytes = 0;
                    let ok = false;
                    try {
                        const result = sess?.send_and_read_finish(res);
                        if (result && msg.get_status() === Soup.Status.OK) {
                            bytes = result.get_size();
                            ok = true;
                        }
                    } catch (e) {}
                    onReqDone(bytes, ok);
                });
            } else {
                const size = sizes[idx];
                const msg = Soup.Message.new('POST', `https://${host}/speedtest/upload.php`);
                if (!msg || !uploadBuffer) {
                    onReqDone(0, false);
                    return;
                }
                msg.get_request_headers().append('User-Agent', USER_AGENT);
                msg.set_request_body_from_bytes('application/octet-stream', new GLib.Bytes(uploadBuffer.subarray(0, size)));
                session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable as any, (sess, res) => {
                    let ok = false;
                    try {
                        sess?.send_and_read_finish(res);
                        ok = msg.get_status() === Soup.Status.OK;
                    } catch (e) {}
                    onReqDone(ok ? size : 0, ok);
                });
            }
        };

        for (let w = 0; w < concurrency; w++) {
            workerStep(1);
        }
    }

    private _runFullSpeedTest(): void {
        if (this._isTestingSpeed) return;
        this._isTestingSpeed = true;

        // Reset the speedtest cancellable so any previously-cancelled state
        // doesn't silently abort the new test's Soup requests.
        if (this._speedTestCancellable) {
            this._speedTestCancellable.cancel();
        }
        this._speedTestCancellable = new Gio.Cancellable();

        this._setSpeedTestDropdownOpen(false);
        if (this._speedTestRunBtnLabel) this._speedTestRunBtnLabel.set_text('TESTING...');
        if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('RESOLVING SERVER...');
        if (this._speedTestPingVal) this._speedTestPingVal.set_text('Testing...');
        if (this._speedTestJitterVal) this._speedTestJitterVal.set_text('Testing...');
        if (this._speedTestLossVal) this._speedTestLossVal.set_text('--');
        if (this._speedTestDownVal) this._speedTestDownVal.set_text('--');
        if (this._speedTestUpVal) this._speedTestUpVal.set_text('--');

        this._fetchOoklaServer((server) => {
            if (!server) {
                if (this._speedTestPingVal) this._speedTestPingVal.set_text('N/A');
                if (this._speedTestJitterVal) this._speedTestJitterVal.set_text('N/A');
                this._finishSpeedTest('0.0', '0.0', 'N/A');
                return;
            }

            if (this._speedTestServerSub) {
                const loc = SPEEDTEST_LOCATIONS[this._speedTestLocationIndex].label;
                const sponsor = server.sponsor || '';
                const sName = server.name || '';
                let text = loc;
                if (sponsor && sName && sponsor !== sName) {
                    text = `${sponsor} • ${sName}`;
                } else if (sponsor || sName) {
                    text = `${sponsor || sName} • ${loc}`;
                }
                this._speedTestServerSub.set_text(text);
            }

            if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('TESTING LATENCY...');

            this._runOoklaLatencyTest(server.host, (avgPing, mdevPing, lossVal) => {
                if (this._speedTestPingVal) this._speedTestPingVal.set_text(avgPing);
                if (this._speedTestJitterVal) this._speedTestJitterVal.set_text(mdevPing);
                if (this._speedTestLossVal) this._speedTestLossVal.set_text(lossVal !== null ? `${Math.round(lossVal)}%` : 'N/A');

                if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('TESTING DOWNLOAD SPEED...');

                this._runOoklaThroughputTest(server.host, 'download', 7000, 3, (curMbps) => {
                    if (this._speedTestDownVal) {
                        this._speedTestDownVal.set_text(curMbps);
                    }
                }, (downMbps) => {
                    if (this._speedTestDownVal) {
                        this._speedTestDownVal.set_text(downMbps === '0.0' ? '--' : downMbps);
                    }

                    if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('TESTING UPLOAD SPEED...');

                    this._runOoklaThroughputTest(server.host, 'upload', 6000, 3, (curMbps) => {
                        if (this._speedTestUpVal) {
                            this._speedTestUpVal.set_text(curMbps);
                        }
                    }, (upMbps) => {
                        if (this._speedTestUpVal) {
                            this._speedTestUpVal.set_text(upMbps === '0.0' ? '--' : upMbps);
                        }

                        this._finishSpeedTest(downMbps, upMbps, avgPing);
                    });
                });
            });
        });
    }

    private _finishSpeedTest(downMbps: string, upMbps: string, avgPing: string): void {
        this._isTestingSpeed = false;
        if (this._speedTestRunBtnLabel) this._speedTestRunBtnLabel.set_text('RUN AGAIN');

        // Calculate Rating
        const dVal = parseFloat(downMbps) || 0;
        let rating = 'TEST COMPLETE — OPTIMAL FOR 4K STREAMING';
        if (dVal <= 0) rating = 'TEST FAILED — CHECK CONNECTION';
        else if (dVal < 15) rating = 'TEST COMPLETE — BASIC BROADBAND';
        else if (dVal < 40) rating = 'TEST COMPLETE — FAST HIGH-SPEED';

        if (this._speedTestQualityVal) {
            this._speedTestQualityVal.set_text(rating);
        }

        this._notify('Speedtest Complete', `Results:\nDownload: ${downMbps} Mbps | Upload: ${upMbps} Mbps | Ping: ${avgPing}`);
    }

    private _updateStatRow(stat: StatRowWidgets | null, rx: number, tx: number): void {
        if (!stat) return;
        const totalStr = this._fmtSize(rx + tx);
        const subStr = `(\u2193 ${this._fmtSize(rx)}  \u2191 ${this._fmtSize(tx)})`;
        
        // Change Guard: Only update if strings differ to save CPU/Layout work
        if (stat.lastTotal !== totalStr) {
            stat.valueLabel.set_text(totalStr);
            stat.lastTotal = totalStr;
        }
        if (stat.lastSub !== subStr) {
            stat.subLabel.set_text(subStr);
            stat.lastSub = subStr;
        }
    }

    private _fmtSize(bytes: number): string {
        if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
        if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
        if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
        return `${Math.round(bytes)} B`;
    }

    private _getMonthKey(date: Date): string {
        const y = date.getFullYear();
        const m = date.getMonth() + 1;
        return `${y}-${m < 10 ? '0' + m : m}`;
    }

    private _checkBatteryStatus(): void {
        if (!this._adaptivePowerSaver) {
            this._isOnBattery = false;
            return;
        }
        try {
            Gio.DBus.system.call(
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'OnBattery']),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (conn, res) => {
                    try {
                        const reply = conn?.call_finish(res);
                        if (reply) {
                            const [unpacked] = reply.recursiveUnpack() as any;
                            const onBattery = (unpacked?.get_boolean ? unpacked.get_boolean() : unpacked) === true;
                            if (this._isOnBattery !== onBattery) {
                                this._isOnBattery = onBattery;
                                this._restartTimer();
                            }
                        }
                    } catch (e) {}
                }
            );
        } catch (e) {}
    }

    private _restartTimer(): void {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        let interval = this._settings?.get_int('refresh-interval') ?? 1500;

        // Adaptive Power Saver: Reduce polling frequency to 3000ms when running on Battery
        if (this._adaptivePowerSaver && this._isOnBattery) {
            interval = Math.max(3000, interval);
        }

        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    private _loadSettings(): void {
        if (!this._settings) return;
        this._useBits = this._settings.get_boolean('use-bits');
        this._showUpload = this._settings.get_boolean('show-upload');
        this._showDownload = this._settings.get_boolean('show-download');
        this._showTopApps = this._settings.get_boolean('show-top-apps');
        this._monitoredInterface = this._settings.get_string('monitored-interface').trim();
        this._dataQuotaGb = this._settings.get_int('data-quota-gb');
        this._quotaNotify = this._settings.get_boolean('quota-notify');
        this._autoHideIdle = this._settings.get_boolean('auto-hide-idle');
        this._idleThresholdKb = this._settings.get_int('idle-threshold-kb');
        this._adaptivePowerSaver = this._settings.get_boolean('adaptive-power-saver');
        this._lastDownText = '';
        this._lastUpText = '';
    }

    private _updateVisibility(): void {
        if (!this._downLabel || !this._sepLabel || !this._upLabel) return;

        const showDown = this._showDownload;
        const showUp = this._showUpload;

        if (!showDown && !showUp) {
            this._downLabel.visible = true;
            this._downLabel.set_text('\u2026');
            this._lastDownText = '\u2026';
            this._sepLabel.visible = false;
            this._upLabel.visible = false;

            this._downLabel.remove_style_class_name('speed-meter-download-label');
            this._downLabel.add_style_class_name('speed-meter-single-label');
        } else if (showDown && showUp) {
            this._downLabel.visible = true;
            this._upLabel.visible = true;
            this._sepLabel.visible = true;

            this._downLabel.remove_style_class_name('speed-meter-single-label');
            this._downLabel.add_style_class_name('speed-meter-download-label');
            this._upLabel.remove_style_class_name('speed-meter-single-label');
            this._upLabel.add_style_class_name('speed-meter-upload-label');
        } else {
            this._downLabel.visible = showDown;
            this._upLabel.visible = showUp;
            this._sepLabel.visible = false;

            if (showDown) {
                this._downLabel.remove_style_class_name('speed-meter-download-label');
                this._downLabel.add_style_class_name('speed-meter-single-label');
            } else {
                this._upLabel.remove_style_class_name('speed-meter-upload-label');
                this._upLabel.add_style_class_name('speed-meter-single-label');
            }
        }
    }

    /**
     * Highly optimized polling logic.
     * Uses a lightweight parser to avoid large string allocations.
     */
    private _tick(): void {
        if (!this._indicator || !this._procFile || !this._downLabel || !this._upLabel) return;

        this._procFile.load_contents_async(this._soupCancellable, (file, res) => {
            try {
                if (!file || !this._indicator || !this._procFile || this._soupCancellable?.is_cancelled()) return;
                const [ok, bytes] = file.load_contents_finish(res);
                if (!ok || !bytes) return;

                const text = UTF8_DECODER.decode(bytes);
                let rx = 0;
                let tx = 0;
                const targetIface = this._monitoredInterface;

                const lines = text.split('\n');
                for (let i = 2; i < lines.length; i++) {
                    const line = lines[i];
                    const colonIndex = line.indexOf(':');
                    if (colonIndex === -1) continue;
                    
                    const iface = line.substring(0, colonIndex).trim();
                    if (targetIface ? iface !== targetIface : iface === 'lo') continue;

                    const data = line.substring(colonIndex + 1).trim().split(/\s+/);
                    if (data.length >= 9) {
                        rx += parseInt(data[0], 10) || 0;
                        tx += parseInt(data[8], 10) || 0;
                    }
                }

                const now = GLib.get_monotonic_time();
                const dt = (now - this._prevTime) / 1_000_000;

                // Suspend/resume gap or time travel guard (>5 seconds delta)
                if (dt > 5.0 || dt <= 0) {
                    this._prevRx = rx;
                    this._prevTx = tx;
                    this._prevTime = now;
                    this._hasPrevStats = true;
                    return;
                }

                if (!this._hasPrevStats) {
                    this._prevRx = rx;
                    this._prevTx = tx;
                    this._prevTime = now;
                    this._hasPrevStats = true;
                    return;
                }

                let deltaRx = rx - this._prevRx;
                let deltaTx = tx - this._prevTx;

                // Counter reset / rollover guard
                if (deltaRx < 0) deltaRx = 0;
                if (deltaTx < 0) deltaTx = 0;

                this._sessionRx += deltaRx;
                this._sessionTx += deltaTx;
                this._statsManager?.update(deltaRx, deltaTx);

                if (this._showTopApps && this._activeAppName && (deltaRx + deltaTx > 0)) {
                    this._statsManager?.updateAppUsage(this._activeAppName, deltaRx + deltaTx);
                }
                
                const rxs = deltaRx / dt;
                const txs = deltaTx / dt;

                // Push live sample to 60-second Bezier wave graph
                if (this._activityGraph) {
                    this._activityGraph.pushRealtimeSample(rxs, txs);
                }

                // Auto-hide when network speed is below idle threshold
                const totalKbps = (rxs + txs) / KB;
                const isIdle = this._autoHideIdle && totalKbps < this._idleThresholdKb;
                if (this._box) {
                    this._box.visible = !isIdle;
                }
                if (this._indicator) {
                    this._indicator.visible = !isIdle;
                }

                // Monthly Data Quota Warning Check
                this._checkQuota();

                if (this._indicator && (this._indicator.menu as any).isOpen) {
                    this._updateMenu();
                }

                const downLabel = this._downLabel;
                const upLabel = this._upLabel;
                if (!downLabel || !upLabel) return;

                const downText = this._showDownload ? `${this._fmt(rxs)} \u2193` : '';
                const upText = this._showUpload ? `${this._fmt(txs)} \u2191` : '';

                if (!this._showDownload && !this._showUpload) {
                    if (this._lastDownText !== '\u2026') {
                        downLabel.set_text('\u2026');
                        this._lastDownText = '\u2026';
                    }
                } else {
                    if (this._showDownload && this._lastDownText !== downText) {
                        downLabel.set_text(downText);
                        this._lastDownText = downText;
                    }
                    if (this._showUpload && this._lastUpText !== upText) {
                        upLabel.set_text(upText);
                        this._lastUpText = upText;
                    }
                }

                this._prevRx = rx;
                this._prevTx = tx;
                this._prevTime = now;
            } catch (e) {}
        });
    }

    private _checkQuota(): void {
        if (this._dataQuotaGb <= 0 || !this._statsManager) return;

        // Reset the notified flags on a new calendar month, otherwise quota warnings
        // would only ever fire once for the lifetime of the extension instance.
        const monthKey = this._getMonthKey(new Date());
        if (this._notifiedQuotaMonth !== monthKey) {
            this._notifiedQuotaMonth = monthKey;
            this._notifiedQuota80 = false;
            this._notifiedQuota100 = false;
        }

        const thisMonth = this._statsManager.getThisMonth();
        const usedBytes = thisMonth.rx + thisMonth.tx;
        const quotaBytes = this._dataQuotaGb * GB;
        const ratio = usedBytes / quotaBytes;

        if (ratio >= 1.0 && !this._notifiedQuota100) {
            if (this._quotaNotify) {
                this._notify('Internet Speed Meter', `Alert: Monthly data quota of ${this._dataQuotaGb} GB reached!`);
            }
            this._notifiedQuota100 = true;
            this._notifiedQuota80 = true;
        } else if (ratio >= 0.8 && !this._notifiedQuota80) {
            if (this._quotaNotify) {
                this._notify('Internet Speed Meter', `Warning: 80% of monthly data quota (${this._dataQuotaGb} GB) used.`);
            }
            this._notifiedQuota80 = true;
        }
    }

    private _fmt(bps: number): string {
        if (this._useBits) {
            const val = bps * BITS_PER_BYTE;
            if (val >= Mb) return `${(val / Mb).toFixed(1)} Mbps`;
            if (val >= Kb) return `${(val / Kb).toFixed(1)} Kbps`;
            return `${Math.round(val)} bps`;
        }
        if (bps >= MB) return `${(bps / MB).toFixed(1)} MB/s`;
        if (bps >= KB) return `${(bps / KB).toFixed(1)} KB/s`;
        return `${Math.round(bps)} B/s`;
    }

    disable(): void {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._saveTimeoutId) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }
        for (const id of this._speedTestSourceIds) GLib.Source.remove(id);
        this._speedTestSourceIds.clear();

        if (this._indicator && this._menuOpenStateId) {
            (this._indicator.menu as any).disconnect(this._menuOpenStateId);
            this._menuOpenStateId = 0;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._indicator && this._menuStyleChangedId) {
            (this._indicator.menu as any).box.disconnect(this._menuStyleChangedId);
            this._menuStyleChangedId = 0;
        }
        if (this._interfaceSettings && this._accentColorChangedId) {
            this._interfaceSettings.disconnect(this._accentColorChangedId);
            this._accentColorChangedId = 0;
        }
        this._interfaceSettings = null;
        this._currentAccentClass = '';
        this._hasAccentColorKey = false;

        if (this._soupCancellable) {
            this._soupCancellable.cancel();
            this._soupCancellable = null;
        }

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        if (this._speedTestCancellable) {
            this._speedTestCancellable.cancel();
            this._speedTestCancellable = null;
        }

        if (this._speedTestSession) {
            this._speedTestSession.abort();
            this._speedTestSession = null;
        }
        this._statsManager?.save();

        // Deepest widgets first (depths from the real widget tree): destroying a widget
        // after one of its ancestors hits an already-disposed object.
        for (const item of this._speedTestDropdownItems) item.btn.destroy();
        this._speedTestDropdownItems = [];
        this._vpnValue?.destroy();
        this._vpnValue = null;
        this._speedTestServerSub?.destroy();
        this._speedTestServerSub = null;
        this._publicIpValue?.destroy();
        this._publicIpValue = null;
        this._ipValue?.destroy();
        this._ipValue = null;
        this._ifaceValue?.destroy();
        this._ifaceValue = null;
        this._speedTestUpVal?.destroy();
        this._speedTestUpVal = null;
        this._speedTestRunBtnLabel?.destroy();
        this._speedTestRunBtnLabel = null;
        this._speedTestPingVal?.destroy();
        this._speedTestPingVal = null;
        this._speedTestLossVal?.destroy();
        this._speedTestLossVal = null;
        this._speedTestJitterVal?.destroy();
        this._speedTestJitterVal = null;
        this._speedTestDropdownArrow?.destroy();
        this._speedTestDropdownArrow = null;
        this._speedTestDownVal?.destroy();
        this._speedTestDownVal = null;
        this._activeAppLabel?.destroy();
        this._activeAppLabel = null;
        this._upLabel?.destroy();
        this._upLabel = null;
        this._speedTestQualityVal?.destroy();
        this._speedTestQualityVal = null;
        this._sepLabel?.destroy();
        this._sepLabel = null;
        this._downLabel?.destroy();
        this._downLabel = null;
        this._activityGraph?.destroy();
        this._activityGraph = null;
        this._speedTestDropdownScroll?.destroy();
        this._speedTestDropdownScroll = null;
        this._speedTestDropdownBtn?.destroy();
        this._speedTestDropdownBtn = null;
        this._box?.destroy();
        this._box = null;
        this._statsBox?.destroy();
        this._statsBox = null;
        this._dashboardBox?.destroy();
        this._dashboardBox = null;
        this._actionsBox?.destroy();
        this._actionsBox = null;
        this._statsSectionItem?.destroy();
        this._statsSectionItem = null;
        this._speedTestPanelItem?.destroy();
        this._speedTestPanelItem = null;
        this._dashboardItem?.destroy();
        this._dashboardItem = null;
        this._actionsItem?.destroy();
        this._actionsItem = null;
        this._indicator?.destroy();
        this._indicator = null;

        this._statToday = null;
        this._statThisMonth = null;
        this._statLastMonth = null;
        this._statSession = null;

        this._procFile = null;
        this._settings = null;
        this._statsManager = null;
        this._lastDownText = '';
        this._lastUpText = '';
        this._hasPrevStats = false;
        this._isOnBattery = false;
    }
}
