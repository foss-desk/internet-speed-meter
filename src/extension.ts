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

interface StatRowWidgets {
    valueLabel: St.Label;
    subLabel: St.Label;
    lastTotal: string;
    lastSub: string;
}

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
    private _speedTestQualityVal: St.Label | null = null;
    private _speedTestRunBtnLabel: St.Label | null = null;
    private _isTestingSpeed: boolean = false;
    private _lastNetworkUpdate: number = 0;
    private _soupSession: Soup.Session | null = null;
    private _soupCancellable: Gio.Cancellable | null = null;

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

    private _settingsChangedId: number = 0;
    private _menuOpenStateId: number = 0;
    private _lastDownText: string = '';
    private _lastUpText: string = '';

    private _statsSectionItem: PopupMenu.PopupBaseMenuItem | null = null;
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

        this._statsManager = new StatsManager(this.path);
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
            vertical: false,
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
            vertical: true,
            style_class: 'speed-meter-dashboard'
        });

        const headerBox = new St.BoxLayout({ 
            vertical: true, 
            style_class: 'speed-meter-dashboard-header' 
        });
        
        // 2x2 Grid for Network Info
        const infoGrid = new St.BoxLayout({ vertical: true, style_class: 'speed-meter-network-info-grid' });
        
        const row1 = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-network-row' });
        const ifaceRow = this._createInfoCard('network-wired-symbolic', 'Connection');
        const vpnRow = this._createInfoCard('network-vpn-symbolic', 'VPN Tunnel');
        row1.add_child(ifaceRow.container);
        row1.add_child(vpnRow.container);

        const row2 = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-network-row' });
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
            vertical: false,
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
            vertical: true,
            style_class: 'speed-meter-graph-container'
        });

        // Tab Switcher Row
        const tabsBar = new St.BoxLayout({
            vertical: false,
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

        const dashboardItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        dashboardItem.add_child(dashboardBox);
        (this._indicator.menu as any).addMenuItem(dashboardItem);

        // Dedicated Speedtest Panel View Item
        this._speedTestPanelItem = this._buildSpeedTestPanel();
        (this._indicator.menu as any).addMenuItem(this._speedTestPanelItem);

        // --- STATS SECTION (Single Unified Card) ---
        const statsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'speed-meter-stats-card',
        });

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
            vertical: false,
            x_expand: true,
        });

        const { button: resetBtn } = this._createButtonWithIcon('edit-undo-symbolic', 'Reset', 'speed-meter-button');
        resetBtn.connect('clicked', () => {
            this._sessionRx = 0;
            this._sessionTx = 0;
            this._updateMenu();
        });

        const { button: speedtestBtn } = this._createButtonWithIcon('network-wireless-signal-excellent-symbolic', 'Speedtest', 'speed-meter-button speed-meter-speedtest-btn');
        speedtestBtn.connect('clicked', () => {
            if (this._speedTestPanelItem) {
                const isVisible = (this._speedTestPanelItem as any).visible;
                const showSpeedtest = !isVisible;
                (this._speedTestPanelItem as any).visible = showSpeedtest;
                this._setStatsVisible(!showSpeedtest);
                if (showSpeedtest) {
                    this._runFullSpeedTest();
                }
            }
        });

        const { button: settingsBtn } = this._createButtonWithIcon('preferences-system-symbolic', 'Settings', 'speed-meter-button');
        settingsBtn.connect('clicked', () => {
            this.openPreferences();
        });

        actionsBox.add_child(resetBtn);
        actionsBox.add_child(speedtestBtn);
        actionsBox.add_child(settingsBtn);

        const actionsItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        actionsItem.add_child(actionsBox);
        (this._indicator.menu as any).addMenuItem(actionsItem);

        // Update network info only when menu opens
        this._menuOpenStateId = (this._indicator.menu as any).connect('open-state-changed', (_menu: any, open: boolean) => {
            if (open) this._updateNetworkInfo();
        });

        this._updateMenu();
    }

    private _setStatsVisible(visible: boolean): void {
        if (this._statsSectionItem) (this._statsSectionItem as any).visible = visible;
    }

    private _createInfoCard(iconName: string, labelText: string): { container: St.BoxLayout, value: St.Label } {
        const container = new St.BoxLayout({ style_class: 'speed-meter-info-card', vertical: true, x_expand: true });
        
        const topRow = new St.BoxLayout({ style_class: 'speed-meter-info-badge-row', vertical: false });
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
            vertical: false,
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
            vertical: false,
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
            vertical: false,
            x_expand: true,
            style_class: 'speed-meter-stat-row',
        });

        const leftBox = new St.BoxLayout({
            vertical: false,
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
            vertical: true,
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
        if (!this._statsManager || (this._indicator && !(this._indicator.menu as any).isOpen)) return;

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
        this._spawnAsync('ip addr', (stdout) => {
            let vpnText = 'None';
            let vpnStyle = 'color: rgba(255,255,255,0.4);';

            if (/tailscale\d+/i.test(stdout)) {
                vpnText = 'Tailscale Mesh';
                vpnStyle = 'color: #2ec27e; font-weight: bold;';
            } else if (/wg\d*|wireguard/i.test(stdout)) {
                vpnText = 'WireGuard';
                vpnStyle = 'color: #3584e4; font-weight: bold;';
            } else if (/warp/i.test(stdout)) {
                vpnText = 'Cloudflare WARP';
                vpnStyle = 'color: #ffbe6f; font-weight: bold;';
            } else if (/zt\w+/i.test(stdout)) {
                vpnText = 'ZeroTier Mesh';
                vpnStyle = 'color: #f66151; font-weight: bold;';
            } else if (/tun\d*|tap\d*|ppp\d*|openvpn/i.test(stdout)) {
                vpnText = 'OpenVPN / TUN';
                vpnStyle = 'color: #2ec27e; font-weight: bold;';
            }

            if (this._vpnValue) {
                this._vpnValue.set_text(vpnText);
                this._vpnValue.set_style(vpnStyle);
            }
        });

        // 3. Async Local IP
        if (iface) {
            this._spawnAsync(`ip -4 addr show ${iface}`, (stdout) => {
                const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
                if (match && this._ipValue) this._ipValue.set_text(match[1]);
            });
        }

        // 4. Async Public IP (Soup 3)
        this._fetchPublicIp();

        // 5. Update Active Application tracking
        this._updateActiveApp();
    }

    private _getSoupSession(): Soup.Session {
        if (!this._soupSession) {
            this._soupSession = new Soup.Session();
            this._soupSession.timeout = 10;
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
        const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'speed-meter-ookla-box' });

        // Header: Speedtest Brand + Server + Close button
        const header = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-ookla-header' });
        const brandBox = new St.BoxLayout({ vertical: true, x_expand: true });
        const brandTitle = new St.Label({ text: 'SPEEDTEST', style_class: 'speed-meter-ookla-brand' });
        const serverSub = new St.Label({ text: 'Cloudflare Edge CDN • Auto Optimal', style_class: 'speed-meter-ookla-server' });
        brandBox.add_child(brandTitle);
        brandBox.add_child(serverSub);

        const closeBtn = new St.Button({
            style_class: 'speed-meter-button speed-meter-close-btn',
            child: new St.Icon({ icon_name: 'window-close-symbolic', style_class: 'speed-meter-button-icon' }),
        });
        closeBtn.connect('clicked', () => {
            if (this._speedTestPanelItem) {
                this._speedTestPanelItem.visible = false;
                this._setStatsVisible(true);
            }
        });

        header.add_child(brandBox);
        header.add_child(closeBtn);

        // Ping Strip: PING | JITTER | LOSS
        const pingStrip = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-ookla-ping-strip' });
        const pingBox = this._createOoklaPingMetric('PING', '-- ms');
        const jitterBox = this._createOoklaPingMetric('JITTER', '-- ms');
        const lossBox = this._createOoklaPingMetric('LOSS', '0%');

        this._speedTestPingVal = pingBox.valueLabel;
        this._speedTestJitterVal = jitterBox.valueLabel;

        pingStrip.add_child(pingBox.container);
        pingStrip.add_child(jitterBox.container);
        pingStrip.add_child(lossBox.container);

        // Ookla Speed Gauges Row (Side-by-side Download & Upload)
        const gaugesRow = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-ookla-gauges-row' });

        // Download Gauge Card
        const downCard = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'speed-meter-ookla-gauge-card speed-meter-down-card' });
        const downHeader = new St.Label({ text: '\u2193 DOWNLOAD', style_class: 'speed-meter-ookla-gauge-title speed-meter-down-title' });
        this._speedTestDownVal = new St.Label({ text: '--', style_class: 'speed-meter-ookla-gauge-value speed-meter-down-value' });
        const downUnit = new St.Label({ text: 'Mbps', style_class: 'speed-meter-ookla-gauge-unit' });
        downCard.add_child(downHeader);
        downCard.add_child(this._speedTestDownVal);
        downCard.add_child(downUnit);

        // Upload Gauge Card
        const upCard = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'speed-meter-ookla-gauge-card speed-meter-up-card' });
        const upHeader = new St.Label({ text: '\u2191 UPLOAD', style_class: 'speed-meter-ookla-gauge-title speed-meter-up-title' });
        this._speedTestUpVal = new St.Label({ text: '--', style_class: 'speed-meter-ookla-gauge-value speed-meter-up-value' });
        const upUnit = new St.Label({ text: 'Mbps', style_class: 'speed-meter-ookla-gauge-unit' });
        upCard.add_child(upHeader);
        upCard.add_child(this._speedTestUpVal);
        upCard.add_child(upUnit);

        gaugesRow.add_child(downCard);
        gaugesRow.add_child(upCard);

        // Status & Rating Banner
        const statusBox = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'speed-meter-ookla-status-box' });
        this._speedTestQualityVal = new St.Label({ text: 'Press GO to start speed test', style_class: 'speed-meter-ookla-status-text' });
        statusBox.add_child(this._speedTestQualityVal);

        // Iconic Ookla Big "GO" Button
        const goBtnRow = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'speed-meter-ookla-go-row' });
        const goBtn = new St.Button({
            style_class: 'speed-meter-ookla-go-button',
            x_expand: true,
        });
        this._speedTestRunBtnLabel = new St.Label({ text: 'GO', style_class: 'speed-meter-ookla-go-label' });
        goBtn.set_child(this._speedTestRunBtnLabel);
        goBtn.connect('clicked', () => {
            this._runFullSpeedTest();
        });
        goBtnRow.add_child(goBtn);

        container.add_child(header);
        container.add_child(pingStrip);
        container.add_child(gaugesRow);
        container.add_child(statusBox);
        container.add_child(goBtnRow);

        item.add_child(container);
        (item as any).visible = false; // Hidden by default

        return item;
    }

    private _createOoklaPingMetric(title: string, initVal: string): { container: St.BoxLayout, valueLabel: St.Label } {
        const container = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'speed-meter-ookla-ping-item' });
        const lbl = new St.Label({ text: title, style_class: 'speed-meter-ookla-ping-lbl' });
        const valueLabel = new St.Label({ text: initVal, style_class: 'speed-meter-ookla-ping-val' });
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

    private _runFullSpeedTest(): void {
        if (this._isTestingSpeed) return;
        this._isTestingSpeed = true;

        if (this._speedTestRunBtnLabel) this._speedTestRunBtnLabel.set_text('...');
        if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('CONNECTING TO CLOUDFLARE EDGE...');
        if (this._speedTestPingVal) this._speedTestPingVal.set_text('Testing...');
        if (this._speedTestDownVal) this._speedTestDownVal.set_text('--');
        if (this._speedTestUpVal) this._speedTestUpVal.set_text('--');

        // Step 1: Ping Test
        const pingCmd = `ping -c 4 -w 3 1.1.1.1 2>/dev/null | awk -F"/" 'END {print $5 "|" $6}'`;
        this._spawnAsync(pingCmd, (stdout) => {
            const parts = stdout.trim().split('|');
            const avgPing = parts[0] && !isNaN(parseFloat(parts[0])) ? `${parseFloat(parts[0]).toFixed(0)} ms` : 'N/A';
            const mdevPing = parts[1] && !isNaN(parseFloat(parts[1])) ? `${parseFloat(parts[1]).toFixed(1)} ms` : 'N/A';

            if (this._speedTestPingVal) this._speedTestPingVal.set_text(avgPing);
            if (this._speedTestJitterVal) this._speedTestJitterVal.set_text(mdevPing);

            // Step 2: Download Speed Test (Soup 3)
            if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('TESTING DOWNLOAD SPEED...');

            const session = this._getSoupSession();
            const downMsg = Soup.Message.new('GET', 'https://speed.cloudflare.com/__down?bytes=15000000');
            const downStart = GLib.get_monotonic_time();

            if (!downMsg) {
                this._finishSpeedTest('0.0', '0.0', avgPing);
                return;
            }

            session.send_and_read_async(
                downMsg,
                GLib.PRIORITY_DEFAULT,
                this._soupCancellable as any,
                (downSess, downRes) => {
                    let downMbps = '0.0';
                    try {
                        const bytes = downSess?.send_and_read_finish(downRes);
                        const downElapsedSec = (GLib.get_monotonic_time() - downStart) / 1000000;
                        if (bytes && downElapsedSec > 0) {
                            const totalBytes = bytes.get_size();
                            downMbps = ((totalBytes * 8) / 1000000 / downElapsedSec).toFixed(1);
                        }
                    } catch (e) {}

                    if (this._speedTestDownVal) {
                        this._speedTestDownVal.set_text(downMbps === '0.0' ? '--' : downMbps);
                    }

                    // Step 3: Upload Speed Test (Soup 3)
                    if (this._speedTestQualityVal) this._speedTestQualityVal.set_text('TESTING UPLOAD SPEED...');

                    const upMsg = Soup.Message.new('POST', 'https://speed.cloudflare.com/__up');
                    if (!upMsg) {
                        this._finishSpeedTest(downMbps, '0.0', avgPing);
                        return;
                    }

                    const payloadSize = 2500000; // 2.5 MB payload
                    const payload = new Uint8Array(payloadSize);
                    upMsg.set_request_body_from_bytes('application/octet-stream', new GLib.Bytes(payload));

                    const upStart = GLib.get_monotonic_time();
                    session.send_and_read_async(
                        upMsg,
                        GLib.PRIORITY_DEFAULT,
                        this._soupCancellable as any,
                        (upSess, upRes) => {
                            let upMbps = '0.0';
                            try {
                                upSess?.send_and_read_finish(upRes);
                                const upElapsedSec = (GLib.get_monotonic_time() - upStart) / 1000000;
                                if (upElapsedSec > 0 && upMsg.get_status() === Soup.Status.OK) {
                                    upMbps = ((payloadSize * 8) / 1000000 / upElapsedSec).toFixed(1);
                                }
                            } catch (e) {}

                            if (this._speedTestUpVal) {
                                this._speedTestUpVal.set_text(upMbps === '0.0' ? '--' : upMbps);
                            }

                            this._finishSpeedTest(downMbps, upMbps, avgPing);
                        }
                    );
                }
            );
        });
    }

    private _finishSpeedTest(downMbps: string, upMbps: string, avgPing: string): void {
        this._isTestingSpeed = false;
        if (this._speedTestRunBtnLabel) this._speedTestRunBtnLabel.set_text('AGAIN');

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

    private _spawnAsync(cmd: string, callback: (stdout: string) => void): void {
        try {
            const proc = new Gio.Subprocess({
                argv: ['bash', '-c', cmd],
                flags: Gio.SubprocessFlags.STDOUT_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [ok, stdout] = p!.communicate_utf8_finish(res);
                    if (ok && stdout) callback(stdout);
                } catch (e) {}
            });
        } catch (e) {}
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
        if (!this._procFile || !this._downLabel || !this._upLabel) return;

        this._procFile.load_contents_async(null, (file, res) => {
            try {
                if (!file) return;
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

        if (this._indicator && this._menuOpenStateId) {
            (this._indicator.menu as any).disconnect(this._menuOpenStateId);
            this._menuOpenStateId = 0;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        if (this._soupCancellable) {
            this._soupCancellable.cancel();
            this._soupCancellable = null;
        }

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }
        this._statsManager?.saveSync();

        this._activityGraph?.destroy();
        this._activityGraph = null;

        this._speedTestPanelItem?.destroy();
        this._speedTestPanelItem = null;

        this._statsSectionItem?.destroy();
        this._statsSectionItem = null;

        this._activeAppLabel?.destroy();
        this._activeAppLabel = null;

        this._ifaceValue?.destroy();
        this._ifaceValue = null;

        this._vpnValue?.destroy();
        this._vpnValue = null;

        this._ipValue?.destroy();
        this._ipValue = null;

        this._publicIpValue?.destroy();
        this._publicIpValue = null;

        this._speedTestDownVal?.destroy();
        this._speedTestDownVal = null;

        this._speedTestUpVal?.destroy();
        this._speedTestUpVal = null;

        this._speedTestPingVal?.destroy();
        this._speedTestPingVal = null;

        this._speedTestQualityVal?.destroy();
        this._speedTestQualityVal = null;

        this._speedTestRunBtnLabel?.destroy();
        this._speedTestRunBtnLabel = null;

        this._speedTestJitterVal?.destroy();
        this._speedTestJitterVal = null;

        this._downLabel?.destroy();
        this._downLabel = null;

        this._sepLabel?.destroy();
        this._sepLabel = null;

        this._upLabel?.destroy();
        this._upLabel = null;

        this._box?.destroy();
        this._box = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

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
