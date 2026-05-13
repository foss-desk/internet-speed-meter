// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
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

/**
 * HIGH-PERFORMANCE INTERNET SPEED METER
 * Optimized for minimal CPU/Memory/RAM footprint.
 */
export default class SpeedMeterExtension extends Extension {
    private _prevRx: number = 0;
    private _prevTx: number = 0;
    private _prevTime: number = 0;
    private _timeoutId: number = 0;
    private _saveTimeoutId: number = 0;
    private _indicator: PanelMenu.Button | null = null;
    private _box: St.BoxLayout | null = null;
    private _label: St.Label | null = null;
    private _procFile: Gio.File | null = null;
    private _settings: Gio.Settings | null = null;
    private _statsManager: StatsManager | null = null;
    private _activityGraph: ActivityGraph | null = null;
    private _ifaceValue: St.Label | null = null;
    private _vpnValue: St.Label | null = null;
    private _ipValue: St.Label | null = null;
    private _publicIpValue: St.Label | null = null;
    private _lastNetworkUpdate: number = 0;

    private _sessionRx: number = 0;
    private _sessionTx: number = 0;

    private _useBits: boolean = false;
    private _showUpload: boolean = true;
    private _showDownload: boolean = true;
    private _settingsChangedId: number = 0;
    private _menuOpenStateId: number = 0;
    private _lastLabelText: string = '';

    private _menuToday: PopupMenu.PopupBaseMenuItem | null = null;
    private _menuThisMonth: PopupMenu.PopupBaseMenuItem | null = null;
    private _menuLastMonth: PopupMenu.PopupBaseMenuItem | null = null;
    private _menuSession: PopupMenu.PopupBaseMenuItem | null = null;

    enable(): void {
        this._prevRx = 0;
        this._prevTx = 0;
        this._sessionRx = 0;
        this._sessionTx = 0;
        this._prevTime = GLib.get_monotonic_time();
        this._lastLabelText = '';

        this._statsManager = new StatsManager(this.path);
        this._settings = this.getSettings();
        this._loadSettings();
        
        this._settingsChangedId = this._settings.connect(
            'changed', (_, key) => {
                this._loadSettings();
                if (key === 'refresh-interval') this._restartTimer();
            },
        );

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._box = new St.BoxLayout({
            style_class: 'speed-meter-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            text: '\u2026',
            style_class: 'speed-meter-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._label);
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

        // --- DASHBOARD SECTION (Grid + Graph) ---
        const dashboardBox = new St.BoxLayout({
            vertical: true,
            style_class: 'speed-meter-dashboard'
        });

        const headerBox = new St.BoxLayout({ 
            vertical: true, 
            style_class: 'speed-meter-dashboard-header' 
        });
        
        // Grid for Network Info
        const infoGrid = new St.BoxLayout({ vertical: true, style_class: 'speed-meter-network-info-grid' });
        
        const ifaceRow = this._createInfoRow('Connection');
        const vpnRow = this._createInfoRow('VPN Status');
        const ipRow = this._createInfoRow('Local IPv4');
        const publicIpRow = this._createInfoRow('Public IPv4');

        this._ifaceValue = ifaceRow.value;
        this._vpnValue = vpnRow.value;
        this._ipValue = ipRow.value;
        this._publicIpValue = publicIpRow.value;

        infoGrid.add_child(ifaceRow.container);
        infoGrid.add_child(vpnRow.container);
        infoGrid.add_child(ipRow.container);
        infoGrid.add_child(publicIpRow.container);

        headerBox.add_child(infoGrid);
        dashboardBox.add_child(headerBox);

        // Integrated Graph
        const graphWrapper = new St.BoxLayout({
            style_class: 'speed-meter-graph-container'
        });
        this._activityGraph = new ActivityGraph();
        graphWrapper.add_child(this._activityGraph);
        dashboardBox.add_child(graphWrapper);

        const dashboardItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        dashboardItem.add_child(dashboardBox);
        (this._indicator.menu as any).addMenuItem(dashboardItem);

        // --- STATS SECTION ---
        this._menuToday = this._createStatItem('Today');
        this._menuThisMonth = this._createStatItem('This Month');
        this._menuLastMonth = this._createStatItem('Last Month');
        this._menuSession = this._createStatItem('Session');

        (this._indicator.menu as any).addMenuItem(this._menuToday);
        (this._indicator.menu as any).addMenuItem(this._menuThisMonth);
        (this._indicator.menu as any).addMenuItem(this._menuLastMonth);
        (this._indicator.menu as any).addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        (this._indicator.menu as any).addMenuItem(this._menuSession);

        // Action Buttons Row
        const actionsBox = new St.BoxLayout({
            style_class: 'speed-meter-stat-row',
            x_expand: true,
        });

        const resetBtn = new St.Button({
            style_class: 'speed-meter-button',
            child: new St.Label({ text: '\u21BA Reset', style_class: 'speed-meter-button-label' }),
            x_expand: true
        });
        resetBtn.connect('clicked', () => {
            this._sessionRx = 0;
            this._sessionTx = 0;
            this._updateMenu();
        });

        const settingsBtn = new St.Button({
            style_class: 'speed-meter-button',
            child: new St.Label({ text: '\u2699 Settings', style_class: 'speed-meter-button-label' }),
            x_expand: true
        });
        settingsBtn.connect('clicked', () => {
            (this as any).openPreferences();
        });

        actionsBox.add_child(resetBtn);
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

    private _createInfoRow(labelText: string): { container: St.BoxLayout, value: St.Label } {
        const container = new St.BoxLayout({ style_class: 'speed-meter-info-item', vertical: false, x_expand: true });
        const label = new St.Label({ text: labelText, style_class: 'speed-meter-info-label', x_expand: true });
        const value = new St.Label({ text: '...', style_class: 'speed-meter-info-value' });
        
        container.add_child(label);
        container.add_child(value);
        
        return { container, value };
    }

    private _createStatItem(label: string): PopupMenu.PopupBaseMenuItem {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false, style_class: 'speed-meter-card' });
        const mainBox = new St.BoxLayout({ vertical: true, x_expand: true });
        
        const textBox = new St.BoxLayout({ vertical: true, x_expand: true });
        const titleLabel = new St.Label({ text: label, style_class: 'speed-meter-stat-label' });
        const valueLabel = new St.Label({ text: '0 B', style_class: 'speed-meter-stat-value' });
        const subLabel = new St.Label({ text: '(↓ 0 B  ↑ 0 B)', style_class: 'speed-meter-stat-sub' });

        textBox.add_child(titleLabel);
        textBox.add_child(valueLabel);
        textBox.add_child(subLabel);
        
        mainBox.add_child(textBox);
        
        item.add_child(mainBox);
        (item as any)._valueLabel = valueLabel;
        (item as any)._subLabel = subLabel;
        
        return item;
    }

    private _updateMenu(): void {
        if (!this._statsManager || (this._indicator && !(this._indicator.menu as any).isOpen)) return;

        const today = this._statsManager.getToday();
        const thisMonth = this._statsManager.getThisMonth();
        const lastMonth = this._statsManager.getLastMonth();

        this._updateStatItem(this._menuToday, today.rx, today.tx);
        this._updateStatItem(this._menuThisMonth, thisMonth.rx, thisMonth.tx);
        this._updateStatItem(this._menuLastMonth, lastMonth.rx, lastMonth.tx);
        this._updateStatItem(this._menuSession, this._sessionRx, this._sessionTx);
        
        if (this._activityGraph) {
            this._activityGraph.updateFromStats(this._statsManager);
        }
    }

    private _updateNetworkInfo(): void {
        const now = GLib.get_monotonic_time() / 1000000;
        if (now - this._lastNetworkUpdate < 30) return;
        this._lastNetworkUpdate = now;

        // --- ASYNC PIPELINE ---
        
        // 1. Get Interface & Connection Type (Fastest, usually ok to keep sync for /proc/net/route)
        try {
            const [ok, contents] = GLib.file_get_contents('/proc/net/route');
            if (!ok) return;
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

            // 2. Async VPN Status
            this._spawnAsync('ip addr', (stdout) => {
                const hasVpn = /tun|tap|ppp|vpn|wg|tailscale|zero/i.test(stdout);
                if (this._vpnValue) {
                    this._vpnValue.set_text(hasVpn ? 'Active \u2705' : 'None');
                    this._vpnValue.set_style(hasVpn ? 'color: #2ec27e; font-weight: bold;' : 'color: rgba(255,255,255,0.4);');
                }
            });

            // 3. Async Local IP
            if (iface) {
                this._spawnAsync(`ip -4 addr show ${iface}`, (stdout) => {
                    const match = stdout.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
                    if (match && this._ipValue) this._ipValue.set_text(match[1]);
                });
            }

            // 4. Async Public IP
            if (this._publicIpValue) this._publicIpValue.set_text('Fetching...');
            const publicIpCmd = 'bash -c "curl -s --max-time 3 https://api.ipify.org || wget -qO- --timeout=3 https://icanhazip.com || python3 -c \'import urllib.request; print(urllib.request.urlopen(\"https://api.ipify.org\", timeout=3).read().decode())\' 2>/dev/null || echo Failed"';
            this._spawnAsync(publicIpCmd, (stdout) => {
                if (stdout && stdout.trim() !== 'Failed' && this._publicIpValue) {
                    this._publicIpValue.set_text(stdout.trim());
                } else if (this._publicIpValue) {
                    this._publicIpValue.set_text('Unavailable');
                }
            });

        } catch (e) {}
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

    private _updateStatItem(item: PopupMenu.PopupBaseMenuItem | null, rx: number, tx: number): void {
        if (!item) return;
        const total = this._fmtSize(rx + tx);
        const down = this._fmtSize(rx);
        const up = this._fmtSize(tx);
        
        const valueLabel = (item as any)._valueLabel as St.Label;
        const subLabel = (item as any)._subLabel as St.Label;

        if (valueLabel) valueLabel.set_text(total);
        if (subLabel) subLabel.set_text(`↓ ${down}   ↑ ${up}`);
    }

    private _fmtSize(bytes: number): string {
        if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
        if (bytes >= MB) return `${(bytes / MB).toFixed(2)} MB`;
        if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
        return `${Math.round(bytes)} B`;
    }

    private _restartTimer(): void {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const interval = this._settings?.get_int('refresh-interval') ?? 1500;
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
        this._lastLabelText = ''; 
    }

    /**
     * Highly optimized polling logic.
     * Uses a lightweight parser to avoid large string allocations.
     */
    private _tick(): void {
        if (!this._procFile || !this._label) return;

        this._procFile.load_contents_async(null, (file, res) => {
            try {
                if (!file) return;
                const [ok, bytes] = file.load_contents_finish(res);
                if (!ok || !bytes) return;

                const text = UTF8_DECODER.decode(bytes);
                let rx = 0;
                let tx = 0;

                const lines = text.split('\n');
                for (let i = 2; i < lines.length; i++) {
                    const line = lines[i];
                    const colonIndex = line.indexOf(':');
                    if (colonIndex === -1) continue;
                    
                    const iface = line.substring(0, colonIndex).trim();
                    if (iface === 'lo') continue;

                    const data = line.substring(colonIndex + 1).trim().split(/\s+/);
                    if (data.length >= 9) {
                        rx += parseInt(data[0], 10) || 0;
                        tx += parseInt(data[8], 10) || 0;
                    }
                }

                const now = GLib.get_monotonic_time();
                const dt = (now - this._prevTime) / 1_000_000;

                if (this._prevRx > 0 && this._prevTx > 0 && dt > 0) {
                    const deltaRx = rx - this._prevRx;
                    const deltaTx = tx - this._prevTx;

                    this._sessionRx += deltaRx;
                    this._sessionTx += deltaTx;
                    this._statsManager?.update(deltaRx, deltaTx);
                    
                    const rxs = deltaRx / dt;
                    const txs = deltaTx / dt;

                    if (this._indicator && (this._indicator.menu as any).isOpen) {
                        this._updateMenu();
                    }

                    let labelParts = [];
                    if (this._showDownload) labelParts.push(`${this._fmt(rxs)} \u2193`);
                    if (this._showUpload) labelParts.push(`${this._fmt(txs)} \u2191`);
                    const finalLabel = labelParts.join(' \u2502 ') || '\u2026';

                    if (this._lastLabelText !== finalLabel) {
                        this._label?.set_text(finalLabel);
                        this._lastLabelText = finalLabel;
                    }
                }

                this._prevRx = rx;
                this._prevTx = tx;
                this._prevTime = now;
            } catch (e) {}
        });
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
        this._statsManager?.save();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._box) {
            this._box.destroy();
            this._box = null;
        }

        if (this._label) {
            this._label.destroy();
            this._label = null;
        }

        if (this._activityGraph) {
            this._activityGraph.destroy();
            this._activityGraph = null;
        }

        if (this._menuToday) {
            (this._menuToday as any).destroy();
            this._menuToday = null;
        }

        if (this._menuThisMonth) {
            (this._menuThisMonth as any).destroy();
            this._menuThisMonth = null;
        }

        if (this._menuLastMonth) {
            (this._menuLastMonth as any).destroy();
            this._menuLastMonth = null;
        }

        if (this._menuSession) {
            (this._menuSession as any).destroy();
            this._menuSession = null;
        }

        if (this._ifaceValue) {
            this._ifaceValue.destroy();
            this._ifaceValue = null;
        }

        if (this._vpnValue) {
            this._vpnValue.destroy();
            this._vpnValue = null;
        }

        if (this._ipValue) {
            this._ipValue.destroy();
            this._ipValue = null;
        }

        if (this._publicIpValue) {
            this._publicIpValue.destroy();
            this._publicIpValue = null;
        }

        this._procFile = null;
        this._settings = null;
        this._statsManager = null;
        this._lastLabelText = '';
    }
}
