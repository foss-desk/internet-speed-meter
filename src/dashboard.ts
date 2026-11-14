// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { VERTICAL } from './compat.js';
import { N_ } from './format.js';
import { ActivityGraph } from './graph.js';
import { USER_AGENT, fetchText, getLocalAddress, isCancelled, parseDefaultRoute, parseNetDev, readFile } from './network.js';
import { averageJitter } from './speedtest.js';
import { StatsManager } from './stats.js';

const NETWORK_INFO_CACHE_SECS = 30;
const QUALITY_PROBE_INTERVAL_SECS = 30;
const QUALITY_PROBE_URL = 'https://1.1.1.1/cdn-cgi/trace';
const QUALITY_SAMPLES = 5;
const PUBLIC_IP_URLS = ['https://api.ipify.org', 'https://icanhazip.com'];

const VPN_TYPES: { pattern: RegExp; name: string; color: string }[] = [
    { pattern: /^tailscale\d+$/i, name: 'Tailscale Mesh', color: '#2ec27e' },
    { pattern: /^(wg\d*|wireguard.*)$/i, name: 'WireGuard', color: '#3584e4' },
    { pattern: /warp/i, name: 'Cloudflare WARP', color: '#ffbe6f' },
    { pattern: /^zt\w+$/i, name: 'ZeroTier Mesh', color: '#f66151' },
    { pattern: /^(tun\d*|tap\d*|ppp\d*|openvpn.*)$/i, name: 'OpenVPN / TUN', color: '#2ec27e' },
];

const QUALITY_LEVELS: { maxMs: number; label: string; styleClass: string; icon: string }[] = [
    { maxMs: 30, label: N_('EXCELLENT'), styleClass: 'speed-meter-quality-excellent', icon: 'network-cellular-signal-excellent-symbolic' },
    { maxMs: 80, label: N_('GOOD'), styleClass: 'speed-meter-quality-good', icon: 'network-cellular-signal-good-symbolic' },
    { maxMs: 150, label: N_('FAIR'), styleClass: 'speed-meter-quality-fair', icon: 'network-cellular-signal-ok-symbolic' },
    { maxMs: Infinity, label: N_('POOR'), styleClass: 'speed-meter-quality-poor', icon: 'network-cellular-signal-weak-symbolic' },
];

function connectionType(iface: string): string {
    if (!iface)
        return _('Disconnected');
    if (iface.startsWith('wl'))
        return _('WiFi');
    if (iface.startsWith('en') || iface.startsWith('eth'))
        return _('Ethernet');
    if (iface.startsWith('ppp') || iface.startsWith('ww'))
        return _('Mobile');
    if (iface.startsWith('tun') || iface.startsWith('wg'))
        return _('VPN Tunnel');
    return _('Wired');
}

function createInfoCard(iconName: string, title: string): { card: St.BoxLayout; icon: St.Icon; value: St.Label } {
    const card = new St.BoxLayout({
        style_class: 'speed-meter-info-card',
        ...VERTICAL,
        x_expand: true,
    });
    const header = new St.BoxLayout({ style_class: 'speed-meter-info-badge-row' });
    const icon = new St.Icon({ icon_name: iconName, style_class: 'speed-meter-info-icon' });
    header.add_child(icon);
    header.add_child(new St.Label({ text: title, style_class: 'speed-meter-info-label' }));
    const value = new St.Label({ text: '…', style_class: 'speed-meter-info-value' });
    card.add_child(header);
    card.add_child(value);
    return { card, icon, value };
}

function createTabButton(iconName: string, title: string): St.Button {
    const content = new St.BoxLayout({ style_class: 'speed-meter-tab-content' });
    content.add_child(new St.Icon({ icon_name: iconName, style_class: 'speed-meter-tab-icon' }));
    content.add_child(new St.Label({ text: title, style_class: 'speed-meter-tab-label' }));
    return new St.Button({ style_class: 'speed-meter-tab-button', child: content, x_expand: true });
}

// Network details, connection quality, the focused app and the traffic graph.
export class DashboardSection extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass({ GTypeName: 'SpeedMeterDashboardSection' }, this);
    }

    private _session = new Soup.Session({ user_agent: USER_AGENT, timeout: 10 });
    private _cancellable = new Gio.Cancellable();
    private _lastRefresh = -Infinity;
    private _qualityTimeoutId = 0;
    private _qualitySamples: number[] = [];
    private _vpnColor: string | null = null;
    private _lightMode = false;

    private _ifaceIcon: St.Icon;
    private _ifaceValue: St.Label;
    private _vpnValue: St.Label;
    private _localIpValue: St.Label;
    private _publicIpValue: St.Label;
    private _qualityIcon: St.Icon;
    private _qualityBadge: St.Label;
    private _pingValue: St.Label;
    private _jitterValue: St.Label;
    private _activeAppLabel: St.Label;
    private _graph: ActivityGraph;

    constructor() {
        super({ reactive: false, can_focus: false });
        this.add_style_class_name('speed-meter-section');
        this.connect('destroy', () => this._releaseResources());

        const box = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-dashboard',
        });
        this.add_child(box);

        const header = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-dashboard-header',
        });
        box.add_child(header);

        const iface = createInfoCard('network-wired-symbolic', _('Connection'));
        const vpn = createInfoCard('network-vpn-symbolic', _('VPN Tunnel'));
        const localIp = createInfoCard('network-transmit-receive-symbolic', _('Local IP'));
        const publicIp = createInfoCard('globe-symbolic', _('Public IP'));
        this._ifaceIcon = iface.icon;
        this._ifaceValue = iface.value;
        this._vpnValue = vpn.value;
        this._localIpValue = localIp.value;
        this._publicIpValue = publicIp.value;

        const grid = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            style_class: 'speed-meter-network-info-grid',
        });
        for (const pair of [[iface, vpn], [localIp, publicIp]]) {
            const row = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-network-row' });
            row.add_child(pair[0].card);
            row.add_child(pair[1].card);
            grid.add_child(row);
        }
        header.add_child(grid);

        const quality = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-quality-strip' });
        this._qualityBadge = new St.Label({
            text: _('MEASURING...'),
            style_class: 'speed-meter-quality-badge speed-meter-quality-measuring',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._pingValue = new St.Label({ text: '---', style_class: 'speed-meter-quality-val', y_align: Clutter.ActorAlign.CENTER });
        this._jitterValue = new St.Label({ text: '---', style_class: 'speed-meter-quality-val', y_align: Clutter.ActorAlign.CENTER });
        this._qualityIcon = new St.Icon({
            icon_name: 'network-cellular-signal-none-symbolic',
            style_class: 'speed-meter-quality-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        quality.add_child(this._qualityIcon);
        quality.add_child(this._qualityBadge);
        quality.add_child(new St.Label({ text: _('Ping'), style_class: 'speed-meter-quality-key', y_align: Clutter.ActorAlign.CENTER }));
        quality.add_child(this._pingValue);
        quality.add_child(new St.Label({ text: _('Jitter'), style_class: 'speed-meter-quality-key', y_align: Clutter.ActorAlign.CENTER }));
        quality.add_child(this._jitterValue);
        header.add_child(quality);

        const appBar = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-app-tracker-bar' });
        this._activeAppLabel = new St.Label({ text: _('System'), style_class: 'speed-meter-app-tracker-name', x_expand: true });
        appBar.add_child(new St.Icon({ icon_name: 'application-x-executable-symbolic', style_class: 'speed-meter-app-tracker-icon' }));
        appBar.add_child(new St.Label({ text: _('Active App:'), style_class: 'speed-meter-app-tracker-title' }));
        appBar.add_child(this._activeAppLabel);
        header.add_child(appBar);

        const graphBox = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'speed-meter-graph-container',
        });
        const tabs = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-tabs-bar' });
        const liveTab = createTabButton('utilities-system-monitor-symbolic', _('Live Wave'));
        const monthTab = createTabButton('x-office-calendar-symbolic', _('30-Day Peak'));
        liveTab.add_style_class_name('speed-meter-tab-active');
        liveTab.connect('clicked', () => {
            this._graph.setMode('realtime');
            liveTab.add_style_class_name('speed-meter-tab-active');
            monthTab.remove_style_class_name('speed-meter-tab-active');
        });
        monthTab.connect('clicked', () => {
            this._graph.setMode('monthly');
            monthTab.add_style_class_name('speed-meter-tab-active');
            liveTab.remove_style_class_name('speed-meter-tab-active');
        });
        tabs.add_child(liveTab);
        tabs.add_child(monthTab);
        this._graph = new ActivityGraph();
        graphBox.add_child(tabs);
        graphBox.add_child(this._graph);
        box.add_child(graphBox);
    }

    private _releaseResources(): void {
        this.stopQualityProbe();
        this._cancellable.cancel();
        this._session.abort();
    }

    // Looks up interface, VPN and addresses; called when the menu opens, at most every 30 s.
    refreshNetworkInfo(): void {
        const now = GLib.get_monotonic_time() / 1e6;
        if (now - this._lastRefresh < NETWORK_INFO_CACHE_SECS)
            return;
        this._lastRefresh = now;
        this._refreshInterfaces();
        this._refreshPublicIp();
    }

    startQualityProbe(): void {
        if (this._qualityTimeoutId)
            return;
        this._probeQuality();
        this._qualityTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, QUALITY_PROBE_INTERVAL_SECS, () => {
            this._probeQuality();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopQualityProbe(): void {
        if (this._qualityTimeoutId) {
            GLib.Source.remove(this._qualityTimeoutId);
            this._qualityTimeoutId = 0;
        }
    }

    setActiveApp(text: string): void {
        this._activeAppLabel.text = text;
    }

    pushSample(rxPerSec: number, txPerSec: number): void {
        this._graph.pushRealtimeSample(rxPerSec, txPerSec);
    }

    updateFromStats(stats: StatsManager): void {
        this._graph.updateFromStats(stats);
    }

    setLightMode(light: boolean): void {
        this._lightMode = light;
        this._graph.setLightMode(light);
        this._updateVpnStyle();
    }

    private async _refreshInterfaces(): Promise<void> {
        try {
            const [route, netDev] = await Promise.all([
                readFile('/proc/net/route', this._cancellable),
                readFile('/proc/net/dev', this._cancellable),
            ]);
            const iface = parseDefaultRoute(route);
            this._ifaceValue.text = `${connectionType(iface)} (${iface || _('none')})`;
            this._ifaceIcon.icon_name = iface.startsWith('wl') ? 'network-wireless-symbolic' : 'network-wired-symbolic';

            const names = parseNetDev(netDev).map(i => i.name);
            const vpn = VPN_TYPES.find(type => names.some(name => type.pattern.test(name)));
            this._vpnValue.text = vpn?.name ?? _('None');
            this._vpnColor = vpn?.color ?? null;
            this._updateVpnStyle();

            this._localIpValue.text = iface ? await getLocalAddress(this._cancellable) : _('Unavailable');
        } catch (e) {
            if (!isCancelled(e))
                logError(e as Error, 'SpeedMeter: Failed to read network interfaces');
        }
    }

    private async _refreshPublicIp(): Promise<void> {
        for (const url of PUBLIC_IP_URLS) {
            try {
                const ip = (await fetchText(this._session, url, this._cancellable))?.trim();
                if (ip) {
                    this._publicIpValue.text = ip;
                    return;
                }
            } catch (e) {
                if (isCancelled(e))
                    return;
            }
        }
        this._publicIpValue.text = _('Unavailable');
    }

    private async _probeQuality(): Promise<void> {
        const start = GLib.get_monotonic_time();
        try {
            await fetchText(this._session, QUALITY_PROBE_URL, this._cancellable);
        } catch {
            // Offline or cancelled: keep showing the last measurement.
            return;
        }
        this._qualitySamples.push((GLib.get_monotonic_time() - start) / 1000);
        if (this._qualitySamples.length > QUALITY_SAMPLES)
            this._qualitySamples.shift();
        this._updateQuality();
    }

    private _updateQuality(): void {
        const samples = this._qualitySamples;
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const jitter = averageJitter(samples);

        const level = QUALITY_LEVELS.find(l => avg < l.maxMs) ?? QUALITY_LEVELS[QUALITY_LEVELS.length - 1];
        this._qualityBadge.text = _(level.label);
        this._qualityBadge.style_class = `speed-meter-quality-badge ${level.styleClass}`;
        this._qualityIcon.icon_name = level.icon;
        this._pingValue.text = `${Math.round(avg)} ms`;
        this._jitterValue.text = `±${jitter.toFixed(1)} ms`;
    }

    private _updateVpnStyle(): void {
        if (this._vpnColor)
            this._vpnValue.style = `color: ${this._vpnColor}; font-weight: bold;`;
        else
            this._vpnValue.style = `color: ${this._lightMode ? '#57606a' : 'rgba(255,255,255,0.45)'}; font-weight: 500;`;
    }
}

