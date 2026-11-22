// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { readFile } from './network.js';

Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'set_display_name_async');

const KEEP_DAYS = 365;
const KEEP_MONTHS = 24;

// The last write started by any StatsManager. After a quick lock/unlock the new instance
// must not read the file while the old one is still writing it.
let lastWrite: Promise<void> = Promise.resolve();

export interface TrafficData {
    rx: number;
    tx: number;
}

interface History {
    daily: Record<string, TrafficData>; // "YYYY-MM-DD"
    monthly: Record<string, TrafficData>; // "YYYY-MM"
    appUsage: Record<string, Record<string, number>>; // "YYYY-MM" -> { "Firefox": bytes }
}

export function dayKey(date: Date): string {
    return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

export function monthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function addTraffic(dict: Record<string, TrafficData>, key: string, rx: number, tx: number): void {
    const entry = dict[key] ??= { rx: 0, tx: 0 };
    entry.rx += rx;
    entry.tx += tx;
}

// Daily, monthly and per-application traffic, persisted as JSON in the user data directory
// (not the extension directory, which is replaced on every update).
export class StatsManager {
    private _file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'internet-speed-meter', 'stats.json']));
    private _history: History = { daily: {}, monthly: {}, appUsage: {} };
    private _dirty = false;
    private _loaded = false;
    // Traffic counted before the history finished loading.
    private _pending: TrafficData = { rx: 0, tx: 0 };
    private _saving = false;
    private _saveAgain = false;
    private _ready: Promise<void>;

    constructor() {
        this._ready = this._load();
    }

    // Resolves once the history is loaded; read nothing before that.
    ready(): Promise<void> {
        return this._ready;
    }

    private async _load(): Promise<void> {
        await lastWrite;
        try {
            const text = await readFile(this._file.get_path()!, null);
            const data = JSON.parse(text);
            this._history = { daily: data.daily ?? {}, monthly: data.monthly ?? {}, appUsage: data.appUsage ?? {} };
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))) {
                console.error('SpeedMeter: Failed to load traffic history', e);
                // Keep the unreadable file instead of overwriting it with an empty history.
                try {
                    await this._file.set_display_name_async('stats.json.bad', GLib.PRIORITY_DEFAULT, null);
                } catch (moveError) {
                    // Stay unloaded, so nothing is ever saved over it.
                    console.error('SpeedMeter: Failed to move the unreadable traffic history aside', moveError);
                    return;
                }
            }
        }
        this._loaded = true;
        this.update(this._pending.rx, this._pending.tx);
    }

    async save(): Promise<void> {
        if (!this._loaded)
            return;
        // Never drop data: if a write is in flight, write again once it finishes.
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        if (!this._dirty)
            return;
        this._prune();
        this._dirty = false;

        this._saving = true;
        lastWrite = this._write(JSON.stringify(this._history));
        await lastWrite;
        this._saving = false;
        if (this._saveAgain) {
            this._saveAgain = false;
            await this.save();
        }
    }

    private async _write(json: string): Promise<void> {
        try {
            await this._file.get_parent()!.make_directory_async(GLib.PRIORITY_DEFAULT, null).catch(e => {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            });
            await this._file.replace_contents_async(new TextEncoder().encode(json), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error('SpeedMeter: Failed to save traffic history', e);
            this._dirty = true;
        }
    }

    update(rx: number, tx: number): void {
        if (!this._loaded) {
            this._pending.rx += rx;
            this._pending.tx += tx;
            return;
        }
        if (rx === 0 && tx === 0)
            return;
        const now = new Date();
        addTraffic(this._history.daily, dayKey(now), rx, tx);
        addTraffic(this._history.monthly, monthKey(now), rx, tx);
        this._dirty = true;
    }

    // Before loading, _history is about to be replaced, so the bytes would be lost anyway.
    updateAppUsage(appName: string, bytes: number): void {
        if (!this._loaded || bytes <= 0)
            return;
        const month = this._history.appUsage[monthKey(new Date())] ??= {};
        month[appName] = (month[appName] ?? 0) + bytes;
        this._dirty = true;
    }

    getDailyData(): Record<string, TrafficData> {
        return this._history.daily;
    }

    getToday(): TrafficData {
        return this._history.daily[dayKey(new Date())] ?? { rx: 0, tx: 0 };
    }

    getThisMonth(): TrafficData {
        return this._history.monthly[monthKey(new Date())] ?? { rx: 0, tx: 0 };
    }

    getLastMonth(): TrafficData {
        const now = new Date();
        return this._history.monthly[monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1))] ?? { rx: 0, tx: 0 };
    }

    getMonthlyAppUsage(): { appName: string; bytes: number }[] {
        const usage = this._history.appUsage[monthKey(new Date())] ?? {};
        return Object.entries(usage)
            .map(([appName, bytes]) => ({ appName, bytes }))
            .sort((a, b) => b.bytes - a.bytes);
    }

    exportToCsv(): string {
        const lines = ['Date,Type,Download_Bytes,Upload_Bytes,Total_Bytes'];
        for (const [type, dict] of [['Daily', this._history.daily], ['Monthly', this._history.monthly]] as const) {
            for (const key of Object.keys(dict).sort())
                lines.push(`${key},${type},${dict[key].rx},${dict[key].tx},${dict[key].rx + dict[key].tx}`);
        }
        return lines.join('\n');
    }

    private _prune(): void {
        const now = new Date();
        const oldestDay = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS));
        const oldestMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - KEEP_MONTHS, 1));
        // Keys are zero-padded dates, so string comparison orders them chronologically.
        for (const key of Object.keys(this._history.daily)) {
            if (key < oldestDay)
                delete this._history.daily[key];
        }
        for (const dict of [this._history.monthly, this._history.appUsage]) {
            for (const key of Object.keys(dict)) {
                if (key < oldestMonth)
                    delete dict[key];
            }
        }
    }
}
