// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export interface TrafficData {
    rx: number;
    tx: number;
}

export interface StatsHistory {
    daily: Record<string, TrafficData>; // "YYYY-MM-DD"
    monthly: Record<string, TrafficData>; // "YYYY-MM"
    appUsage?: Record<string, Record<string, number>>; // "YYYY-MM" -> { "Firefox": bytes }
}

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

export class StatsManager {
    private _file: Gio.File;
    private _history: StatsHistory = { daily: {}, monthly: {} };
    private _lastSavedJson: string = '';
    private _loaded: boolean = false;
    private _pendingUpdates: TrafficData[] = [];
    private _saving: boolean = false;

    constructor(cacheDir: string) {
        const path = GLib.build_filenamev([cacheDir, 'stats.json']);
        this._file = Gio.File.new_for_path(path);
        this._loadSync();
    }

    private _loadSync(): void {
        try {
            if (!this._file.query_exists(null)) {
                this._loaded = true;
                return;
            }

            const [ok, contents] = this._file.load_contents(null);
            if (ok && contents) {
                const text = UTF8_DECODER.decode(contents);
                try {
                    const loaded = JSON.parse(text);
                    if (loaded && typeof loaded === 'object') {
                        this._history = {
                            daily: loaded.daily || {},
                            monthly: loaded.monthly || {},
                            appUsage: loaded.appUsage || {},
                        };
                        this._lastSavedJson = text;
                    }
                } catch (parseErr) {
                    logError(parseErr as Error, 'SpeedMeter: Corrupt stats.json');
                }
            }
        } catch (e) {
            logError(e as Error, 'SpeedMeter: Failed to load stats');
        } finally {
            this._loaded = true;
            this._flushPendingUpdates();
        }
    }

    private _flushPendingUpdates(): void {
        for (const pending of this._pendingUpdates) {
            this.update(pending.rx, pending.tx);
        }
        this._pendingUpdates = [];
    }

    getDailyData(): Record<string, TrafficData> {
        return this._history.daily;
    }

    getMonthlyData(): Record<string, TrafficData> {
        return this._history.monthly;
    }

    saveSync(): void {
        if (!this._loaded) return;
        try {
            const json = JSON.stringify(this._history);
            if (json === this._lastSavedJson) return;

            const parent = this._file.get_parent();
            if (parent && !parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }

            const [ok] = this._file.replace_contents(
                UTF8_ENCODER.encode(json),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            if (ok) {
                this._lastSavedJson = json;
            }
        } catch (e) {
            logError(e as Error, 'SpeedMeter: Failed to save stats synchronously');
        }
    }

    async save(): Promise<void> {
        if (!this._loaded || this._saving) return;
        try {
            const json = JSON.stringify(this._history);
            
            // Optimization: Skip disk I/O if data hasn't changed since last save
            if (json === this._lastSavedJson) return;

            const parent = this._file.get_parent();
            if (parent && !parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }

            this._saving = true;
            return new Promise((resolve, reject) => {
                this._file.replace_contents_async(
                    UTF8_ENCODER.encode(json),
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (file, res) => {
                        this._saving = false;
                        try {
                            if (!file) {
                                resolve();
                                return;
                            }
                            const [ok] = file.replace_contents_finish(res);
                            if (ok) {
                                this._lastSavedJson = json;
                            }
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            this._saving = false;
            logError(e as Error, 'SpeedMeter: Failed to save stats');
        }
    }

    update(rxBytes: number, txBytes: number): void {
        if (rxBytes === 0 && txBytes === 0) return;

        if (!this._loaded) {
            this._pendingUpdates.push({ rx: rxBytes, tx: txBytes });
            return;
        }

        const now = new Date();
        const dayKey = this._getDayKey(now);
        const monthKey = dayKey.substring(0, 7);

        this._updateKey(this._history.daily, dayKey, rxBytes, txBytes);
        this._updateKey(this._history.monthly, monthKey, rxBytes, txBytes);

        // Optimization: Periodic pruning of very old data (once per hour roughly)
        if (now.getMinutes() === 0 && now.getSeconds() < 2) {
            this._pruneHistory();
        }
    }

    /**
     * Accumulates monthly traffic per application.
     */
    updateAppUsage(appName: string, bytes: number): void {
        if (!appName || bytes <= 0) return;
        const monthKey = this._getDayKey(new Date()).substring(0, 7);
        if (!this._history.appUsage) this._history.appUsage = {};
        if (!this._history.appUsage[monthKey]) this._history.appUsage[monthKey] = {};
        const current = this._history.appUsage[monthKey][appName] || 0;
        this._history.appUsage[monthKey][appName] = current + bytes;
    }

    /**
     * Returns monthly app bandwidth usage sorted by highest traffic.
     */
    getMonthlyAppUsage(): { appName: string; bytes: number }[] {
        const monthKey = this._getDayKey(new Date()).substring(0, 7);
        const dict = (this._history.appUsage && this._history.appUsage[monthKey]) || {};
        const list = Object.entries(dict).map(([appName, bytes]) => ({ appName, bytes }));
        list.sort((a, b) => b.bytes - a.bytes);
        return list;
    }

    /**
     * Exports daily and monthly historical statistics to CSV format.
     */
    exportToCsv(): string {
        const lines: string[] = ['Date,Type,Download_Bytes,Upload_Bytes,Total_Bytes'];
        
        const sortedDailyKeys = Object.keys(this._history.daily).sort();
        for (const date of sortedDailyKeys) {
            const data = this._history.daily[date];
            lines.push(`${date},Daily,${data.rx},${data.tx},${data.rx + data.tx}`);
        }

        const sortedMonthlyKeys = Object.keys(this._history.monthly).sort();
        for (const month of sortedMonthlyKeys) {
            const data = this._history.monthly[month];
            lines.push(`${month},Monthly,${data.rx},${data.tx},${data.rx + data.tx}`);
        }

        return lines.join('\n');
    }

    /**
     * Keeps the memory and disk footprint lean by removing data older than 1 year.
     */
    private _pruneHistory(): void {
        const threshold = Date.now() - (365 * 24 * 60 * 60 * 1000);
        
        // Prune Daily
        for (const key in this._history.daily) {
            if (new Date(key).getTime() < threshold) {
                delete this._history.daily[key];
            }
        }
        
        // Prune Monthly (keep last 24 months)
        const monthThreshold = Date.now() - (24 * 30 * 24 * 60 * 60 * 1000);
        for (const key in this._history.monthly) {
            if (new Date(key + "-01").getTime() < monthThreshold) {
                delete this._history.monthly[key];
            }
        }
    }

    private _updateKey(dict: Record<string, TrafficData>, key: string, rx: number, tx: number): void {
        const entry = dict[key];
        if (!entry) {
            dict[key] = { rx, tx };
        } else {
            entry.rx += rx;
            entry.tx += tx;
        }
    }

    private _getDayKey(date: Date): string {
        const y = date.getFullYear();
        const m = date.getMonth() + 1;
        const d = date.getDate();
        
        // Manual string building is faster than toISOString for keys
        return `${y}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`;
    }

    getToday(): TrafficData {
        return this._history.daily[this._getDayKey(new Date())] || { rx: 0, tx: 0 };
    }

    getThisMonth(): TrafficData {
        return this._history.monthly[this._getDayKey(new Date()).substring(0, 7)] || { rx: 0, tx: 0 };
    }

    getLastMonth(): TrafficData {
        const now = new Date();
        let y = now.getFullYear();
        let m = now.getMonth(); 
        
        if (m === 0) { 
            m = 12;
            y -= 1;
        }
        
        const key = `${y}-${m < 10 ? '0' + m : m}`;
        return this._history.monthly[key] || { rx: 0, tx: 0 };
    }
}
