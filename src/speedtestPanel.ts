// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { VERTICAL } from './compat.js';
import { N_ } from './format.js';
import { isCancelled } from './network.js';
import { Direction, Server, SpeedTest } from './speedtest.js';

const DOWNLOAD_DURATION_MS = 7000;
const UPLOAD_DURATION_MS = 6000;
// "Automatic" picks the lowest ping among this many of the nearest servers.
const AUTO_CANDIDATES = 4;

type Phase = 'idle' | 'ping' | 'download' | 'upload';

interface Region {
    label: string;
    lat: number;
    lon: number;
}

// Testing against another part of the world uses the best server near one of these cities.
const REGIONS: Region[] = [
    { label: N_('New York, US'), lat: 40.7128, lon: -74.0060 },
    { label: N_('San Francisco, US'), lat: 37.7749, lon: -122.4194 },
    { label: N_('Toronto, CA'), lat: 43.6532, lon: -79.3832 },
    { label: N_('São Paulo, BR'), lat: -23.5505, lon: -46.6333 },
    { label: N_('London, UK'), lat: 51.5074, lon: -0.1278 },
    { label: N_('Frankfurt, DE'), lat: 50.1109, lon: 8.6821 },
    { label: N_('Dubai, AE'), lat: 25.2048, lon: 55.2708 },
    { label: N_('Mumbai, IN'), lat: 19.0760, lon: 72.8777 },
    { label: N_('Singapore, SG'), lat: 1.3521, lon: 103.8198 },
    { label: N_('Tokyo, JP'), lat: 35.6762, lon: 139.6503 },
    { label: N_('Sydney, AU'), lat: -33.8688, lon: 151.2093 },
];

function createResult(title: string): { cell: St.BoxLayout; value: St.Label } {
    const cell = new St.BoxLayout({ ...VERTICAL, x_expand: true, style_class: 'speed-meter-st-result' });
    // Labels fill the cell (centered by text-align): St's natural width is too narrow for letter-spaced text.
    cell.add_child(new St.Label({ text: title, style_class: 'speed-meter-st-result-title' }));
    const value = new St.Label({ text: '--', style_class: 'speed-meter-st-result-value' });
    cell.add_child(value);
    return { cell, value };
}

function describePlace(server: Server): string {
    const place = [server.name, server.country].filter(Boolean).join(', ');
    return [place, _('%d km').format(Math.round(server.distanceKm))].filter(Boolean).join(' · ');
}

function rating(downMbps: number): string {
    if (downMbps <= 0)
        return _('The test failed. Check your connection and try again.');
    if (downMbps < 15)
        return _('Good for browsing, email and SD video.');
    if (downMbps < 40)
        return _('Good for HD streaming and video calls.');
    return _('Fast enough for 4K streaming and large downloads.');
}

// Speed test page of the menu: pick a server, then press Start.
export class SpeedTestPanel extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass({ GTypeName: 'SpeedMeterSpeedTestPanel' }, this);
    }

    private _test: SpeedTest | null = null;
    private _lister: SpeedTest | null = null;
    private _servers: Server[] = [];
    // Both null means Automatic (best nearby server).
    private _selected: Server | null = null;
    private _region: Region | null = null;

    private _serverButton: St.Button;
    private _serverName: St.Label;
    private _serverDetail: St.Label;
    private _serverArrow: St.Icon;
    private _serverScroll: St.ScrollView;
    private _serverList: St.BoxLayout;
    private _heroCaption: St.Label;
    private _heroValue: St.Label;
    private _heroUnit: St.Label;
    private _progressFill: St.Widget;
    private _downValue: St.Label;
    private _upValue: St.Label;
    private _pingValue: St.Label;
    private _jitterValue: St.Label;
    private _lossValue: St.Label;
    private _statusLabel: St.Label;
    private _actionButton: St.Button;
    private _actionIcon: St.Icon;
    private _actionLabel: St.Label;

    constructor(onBack: () => void) {
        super({ reactive: false, can_focus: false, style_class: 'speed-meter-st-panel' });
        this.connect('destroy', () => {
            this._test?.cancel();
            this._lister?.cancel();
        });

        const box = new St.BoxLayout({ ...VERTICAL, x_expand: true, style_class: 'speed-meter-st-box' });
        this.add_child(box);

        const header = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-st-header' });
        const backButton = new St.Button({
            style_class: 'speed-meter-st-back',
            child: new St.Icon({ icon_name: 'go-previous-symbolic', icon_size: 16 }),
            y_align: Clutter.ActorAlign.CENTER,
            can_focus: true,
            accessible_name: _('Back'),
        });
        backButton.connect('clicked', () => {
            this._setServerListOpen(false);
            onBack();
        });
        const titles = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titles.add_child(new St.Label({ text: _('Speed Test'), style_class: 'speed-meter-st-title' }));
        titles.add_child(new St.Label({ text: _('via public speedtest.net servers'), style_class: 'speed-meter-st-subtitle' }));
        header.add_child(backButton);
        header.add_child(titles);
        box.add_child(header);

        this._serverName = new St.Label({ style_class: 'speed-meter-st-server-name' });
        this._serverDetail = new St.Label({ style_class: 'speed-meter-st-server-detail' });
        this._serverArrow = new St.Icon({ icon_name: 'pan-down-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        const serverText = new St.BoxLayout({ ...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        serverText.add_child(this._serverName);
        serverText.add_child(this._serverDetail);
        const serverRow = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-st-server-row' });
        serverRow.add_child(new St.Icon({
            icon_name: 'network-server-symbolic',
            style_class: 'speed-meter-st-server-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        serverRow.add_child(serverText);
        serverRow.add_child(this._serverArrow);
        this._serverButton = new St.Button({
            style_class: 'speed-meter-st-server',
            child: serverRow,
            x_expand: true,
            can_focus: true,
            accessible_name: _('Choose server'),
        });
        this._serverButton.connect('clicked', () => this._setServerListOpen(!this._serverScroll.visible));
        box.add_child(this._serverButton);

        this._serverList = new St.BoxLayout({ ...VERTICAL, x_expand: true, style_class: 'speed-meter-st-server-list' });
        this._serverScroll = new St.ScrollView({
            style_class: 'speed-meter-st-server-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            visible: false,
            child: this._serverList,
        });
        box.add_child(this._serverScroll);

        const hero = new St.BoxLayout({ ...VERTICAL, x_expand: true, style_class: 'speed-meter-st-hero' });
        this._heroCaption = new St.Label({ style_class: 'speed-meter-st-hero-caption' });
        this._heroValue = new St.Label({ style_class: 'speed-meter-st-hero-value' });
        this._heroUnit = new St.Label({ style_class: 'speed-meter-st-hero-unit' });
        hero.add_child(this._heroCaption);
        hero.add_child(this._heroValue);
        hero.add_child(this._heroUnit);
        const progressTrack = new St.Widget({
            style_class: 'speed-meter-st-progress-track',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this._progressFill = new St.Widget({ style_class: 'speed-meter-st-progress-fill', x_expand: true, scale_x: 0 });
        progressTrack.add_child(this._progressFill);
        hero.add_child(progressTrack);
        box.add_child(hero);

        const results = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-st-results' });
        const down = createResult(_('Download'));
        const up = createResult(_('Upload'));
        const ping = createResult(_('Ping'));
        const jitter = createResult(_('Jitter'));
        const loss = createResult(_('Loss'));
        down.value.add_style_class_name('speed-meter-st-download');
        up.value.add_style_class_name('speed-meter-st-upload');
        for (const { cell } of [down, up, ping, jitter, loss])
            results.add_child(cell);
        this._downValue = down.value;
        this._upValue = up.value;
        this._pingValue = ping.value;
        this._jitterValue = jitter.value;
        this._lossValue = loss.value;
        box.add_child(results);

        this._statusLabel = new St.Label({ style_class: 'speed-meter-st-status', x_expand: true });
        this._statusLabel.clutter_text.line_wrap = true;
        box.add_child(this._statusLabel);

        this._actionIcon = new St.Icon({ icon_size: 16, y_align: Clutter.ActorAlign.CENTER });
        this._actionLabel = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        const actionContent = new St.BoxLayout({ style_class: 'speed-meter-st-action-content', x_align: Clutter.ActorAlign.CENTER });
        actionContent.add_child(this._actionIcon);
        actionContent.add_child(this._actionLabel);
        this._actionButton = new St.Button({
            style_class: 'speed-meter-st-action',
            child: actionContent,
            x_expand: true,
            can_focus: true,
        });
        this._actionButton.connect('clicked', () => {
            if (this._test)
                this._cancel();
            else
                this._start();
        });
        box.add_child(this._actionButton);

        this._showIdle(_('Choose a server, then press Start.'), _('Start'));
        this._showServer(null);
        this._rebuildServerList();
    }

    // Called when the page is shown; fetches the nearby server list once.
    async loadServers(): Promise<void> {
        if (this._servers.length > 0 || this._lister)
            return;
        const lister = new SpeedTest();
        this._lister = lister;
        this._serverDetail.text = _('Finding nearby servers…');
        try {
            this._servers = await lister.listServers();
        } catch (e) {
            if (isCancelled(e))
                return;
        } finally {
            if (this._lister === lister)
                this._lister = null;
        }
        this._rebuildServerList();
        this._showServer(this._selected);
    }

    private async _start(): Promise<void> {
        const test = new SpeedTest();
        this._test = test;
        this._setServerListOpen(false);
        this._serverButton.reactive = false;
        this._setAction('process-stop-symbolic', _('Cancel'), false);
        for (const label of [this._downValue, this._upValue, this._pingValue, this._jitterValue, this._lossValue])
            label.text = '--';

        try {
            this._setHero('ping', _('Connecting'), '…', '');
            this._statusLabel.text = _('Finding the best server…');
            if (!this._region && this._servers.length === 0) {
                this._servers = await test.listServers();
                this._rebuildServerList();
            }
            const candidates = this._region ? await test.listServers(this._region.lat, this._region.lon) : this._servers;
            if (candidates.length === 0) {
                this._finish(0, 0, null);
                return;
            }
            const server = this._selected ?? await test.pickFastest(candidates.slice(0, AUTO_CANDIDATES));
            this._showServer(server);

            this._statusLabel.text = _('Measuring latency…');
            this._setHero('ping', _('Ping'), '…', _('ms'));
            const latency = await test.measureLatency(server.host);
            const pingText = latency ? `${Math.round(latency.pingMs)} ms` : _('N/A');
            this._pingValue.text = pingText;
            this._jitterValue.text = latency ? `${latency.jitterMs.toFixed(1)} ms` : _('N/A');
            this._lossValue.text = latency ? `${Math.round(latency.lossPct)}%` : _('N/A');
            this._heroValue.text = latency ? `${Math.round(latency.pingMs)}` : '--';

            this._statusLabel.text = _('Measuring download speed…');
            const downMbps = await this._measure(test, server.host, 'download', DOWNLOAD_DURATION_MS, this._downValue);
            this._statusLabel.text = _('Measuring upload speed…');
            const upMbps = await this._measure(test, server.host, 'upload', UPLOAD_DURATION_MS, this._upValue);

            this._finish(downMbps, upMbps, pingText);
        } catch (e) {
            // A cancelled test was already reset by _cancel() or by destroying the panel.
            if (isCancelled(e))
                return;
            logError(e as Error, 'SpeedMeter: Speed test failed');
            this._finish(0, 0, null);
        } finally {
            if (this._test === test) {
                this._test = null;
                this._serverButton.reactive = true;
            }
        }
    }

    private async _measure(test: SpeedTest, host: string, direction: Direction, durationMs: number, label: St.Label): Promise<number> {
        this._setHero(direction, direction === 'download' ? _('Download') : _('Upload'), '0.0', _('Mbps'));
        this._progressFill.style_class = `speed-meter-st-progress-fill speed-meter-st-${direction}`;
        this._progressFill.ease({ scaleX: 1, duration: durationMs, mode: Clutter.AnimationMode.LINEAR });

        const mbps = await test.measureThroughput(host, direction, durationMs, value => {
            label.text = value.toFixed(1);
            this._heroValue.text = value.toFixed(1);
        });
        label.text = mbps > 0 ? mbps.toFixed(1) : '--';
        return mbps;
    }

    private _cancel(): void {
        this._test?.cancel();
        this._test = null;
        this._serverButton.reactive = true;
        this._showIdle(_('Test cancelled.'), _('Start'));
    }

    private _finish(downMbps: number, upMbps: number, ping: string | null): void {
        if (downMbps > 0) {
            this._setHero('download', _('Download'), downMbps.toFixed(1), _('Mbps'));
            this._statusLabel.text = rating(downMbps);
            this._setAction('view-refresh-symbolic', _('Run Again'), true);
            Main.notify(_('Speedtest Complete'),
                _('Download: %s Mbps | Upload: %s Mbps | Ping: %s').format(downMbps.toFixed(1), upMbps.toFixed(1), ping ?? _('N/A')));
        } else {
            this._showIdle(rating(0), _('Try Again'));
        }
    }

    private _showIdle(status: string, action: string): void {
        this._setHero('idle', _('Ready'), '--', _('Mbps'));
        this._statusLabel.text = status;
        this._setAction('media-playback-start-symbolic', action, true);
    }

    private _setHero(phase: Phase, caption: string, value: string, unit: string): void {
        this._heroCaption.text = caption;
        this._heroValue.text = value;
        this._heroUnit.text = unit;
        this._heroValue.style_class = `speed-meter-st-hero-value speed-meter-st-${phase}`;
        this._progressFill.remove_all_transitions();
        this._progressFill.scale_x = 0;
    }

    private _setAction(iconName: string, label: string, primary: boolean): void {
        this._actionIcon.icon_name = iconName;
        this._actionLabel.text = label;
        if (primary)
            this._actionButton.add_style_class_name('primary');
        else
            this._actionButton.remove_style_class_name('primary');
    }

    private _showServer(server: Server | null): void {
        if (server) {
            this._serverName.text = server.sponsor || server.name;
            const place = describePlace(server);
            if (this._selected)
                this._serverDetail.text = place;
            else if (this._region)
                this._serverDetail.text = [server.name, server.country].filter(Boolean).join(', ');
            else
                this._serverDetail.text = _('Automatic · %s').format(place);
        } else if (this._region) {
            this._serverName.text = _(this._region.label);
            this._serverDetail.text = _('Best server near this city');
        } else {
            this._serverName.text = _('Automatic');
            this._serverDetail.text = this._servers.length > 0
                ? _('Lowest ping of the nearest servers')
                : _('Nearest server with the lowest ping');
        }
    }

    private _setServerListOpen(open: boolean): void {
        this._serverScroll.visible = open;
        this._serverArrow.icon_name = open ? 'pan-up-symbolic' : 'pan-down-symbolic';
        if (open)
            this._serverButton.add_style_class_name('open');
        else
            this._serverButton.remove_style_class_name('open');
    }

    private _rebuildServerList(): void {
        this._serverList.destroy_all_children();
        this._addSection(_('Near you'));
        this._addServerItem(_('Automatic'), _('Lowest ping of the nearest servers'), !this._selected && !this._region, null, null);
        for (const server of this._servers)
            this._addServerItem(server.sponsor || server.name, describePlace(server), server === this._selected, server, null);
        this._addSection(_('Other regions'));
        for (const region of REGIONS)
            this._addServerItem(_(region.label), _('Best server near this city'), region === this._region, null, region);
    }

    private _addSection(title: string): void {
        this._serverList.add_child(new St.Label({ text: title, style_class: 'speed-meter-st-server-section' }));
    }

    private _addServerItem(name: string, detail: string, selected: boolean, server: Server | null, region: Region | null): void {
        const text = new St.BoxLayout({ ...VERTICAL, x_expand: true });
        text.add_child(new St.Label({ text: name, style_class: 'speed-meter-st-server-name' }));
        text.add_child(new St.Label({ text: detail, style_class: 'speed-meter-st-server-detail' }));
        const row = new St.BoxLayout({ x_expand: true, style_class: 'speed-meter-st-server-row' });
        row.add_child(text);
        if (selected)
            row.add_child(new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER }));
        const item = new St.Button({
            style_class: selected ? 'speed-meter-st-server-item selected' : 'speed-meter-st-server-item',
            child: row,
            x_expand: true,
            can_focus: true,
        });
        item.connect('clicked', () => {
            this._selected = server;
            this._region = region;
            this._showServer(server);
            this._rebuildServerList();
            this._setServerListOpen(false);
        });
        this._serverList.add_child(item);
    }
}
