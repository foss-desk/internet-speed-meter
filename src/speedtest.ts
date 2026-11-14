// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import { USER_AGENT, fetchText, isCancelled } from './network.js';

const SERVER_LIST_URL = 'https://www.speedtest.net/api/js/servers?engine=js&limit=10&https_functional=true';
const PROBE_TIMEOUT_MS = 2000;
const LATENCY_SAMPLES = 5;
const CONCURRENCY = 3;
// Each stream resizes its next chunk so that one request takes between these two durations.
const CHUNK_FAST_SECS = 0.7;
const CHUNK_SLOW_SECS = 2.5;
const DOWNLOAD_SIZES = [500, 750, 1000, 1500, 2000, 2500, 3000, 3500];
const UPLOAD_SIZES = [250000, 500000, 1000000, 2000000, 4000000];

export interface Server {
    host: string;
    name: string;
    country: string;
    sponsor: string;
    distanceKm: number;
}

export interface Latency {
    pingMs: number;
    jitterMs: number;
    lossPct: number;
}

export type Direction = 'download' | 'upload';

function monotonicSecs(): number {
    return GLib.get_monotonic_time() / 1e6;
}

export function averageJitter(samples: number[]): number {
    if (samples.length < 2)
        return 0;
    let sum = 0;
    for (let i = 1; i < samples.length; i++)
        sum += Math.abs(samples[i] - samples[i - 1]);
    return sum / (samples.length - 1);
}

// One speed test run against the public speedtest.net server network.
// cancel() aborts every request and timer; pending calls then reject with G_IO_ERROR_CANCELLED.
export class SpeedTest {
    private _session = new Soup.Session({ user_agent: USER_AGENT, timeout: 25 });
    private _cancellable = new Gio.Cancellable();
    private _sourceIds = new Set<number>();

    cancel(): void {
        this._cancellable.cancel();
        for (const id of this._sourceIds)
            GLib.Source.remove(id);
        this._sourceIds.clear();
        this._session.abort();
    }

    // Servers closest first: to the given coordinates, or to the user by GeoIP. Empty when the list could not be read.
    async listServers(lat: number | null = null, lon: number | null = null): Promise<Server[]> {
        const url = lat !== null && lon !== null ? `${SERVER_LIST_URL}&lat=${lat}&lon=${lon}` : SERVER_LIST_URL;
        const text = await fetchText(this._session, url, this._cancellable);
        let list: unknown;
        try {
            list = JSON.parse(text ?? '');
        } catch {
            return [];
        }
        if (!Array.isArray(list))
            return [];
        return list
            .filter(s => s?.host)
            .map(s => ({
                host: String(s.host),
                name: String(s.name ?? ''),
                country: String(s.country ?? ''),
                sponsor: String(s.sponsor ?? ''),
                distanceKm: Number(s.distance) || 0,
            }));
    }

    // Probes the candidates in parallel and returns the fastest one that answered in time, else the first.
    async pickFastest(candidates: Server[]): Promise<Server> {
        const pings = new Map<Server, number>();
        const probes = candidates.map(async server => {
            const start = monotonicSecs();
            if (await this._ping(server.host))
                pings.set(server, monotonicSecs() - start);
        });
        await this._raceTimeout(Promise.allSettled(probes), PROBE_TIMEOUT_MS);
        this._cancellable.set_error_if_cancelled();

        let best = candidates[0];
        let bestPing = Infinity;
        for (const [server, ping] of pings) {
            if (ping < bestPing) {
                best = server;
                bestPing = ping;
            }
        }
        return best;
    }

    async measureLatency(host: string): Promise<Latency | null> {
        const samples: number[] = [];
        for (let i = 0; i < LATENCY_SAMPLES; i++) {
            const start = monotonicSecs();
            if (await this._ping(host))
                samples.push((monotonicSecs() - start) * 1000);
        }
        this._cancellable.set_error_if_cancelled();
        if (samples.length === 0)
            return null;

        return {
            pingMs: samples.reduce((a, b) => a + b, 0) / samples.length,
            jitterMs: averageJitter(samples),
            lossPct: (LATENCY_SAMPLES - samples.length) / LATENCY_SAMPLES * 100,
        };
    }

    // Runs CONCURRENCY parallel streams for durationMs and returns the throughput in Mbps.
    async measureThroughput(host: string, direction: Direction, durationMs: number, onProgress: (mbps: number) => void): Promise<number> {
        const sizes = direction === 'download' ? DOWNLOAD_SIZES : UPLOAD_SIZES;
        const start = monotonicSecs();
        const deadline = start + durationMs / 1000;
        let totalBytes = 0;
        let done = false;
        const mbps = () => totalBytes * 8 / 1e6 / Math.max(monotonicSecs() - start, 0.001);

        const stream = async () => {
            let index = 1;
            while (!done && monotonicSecs() < deadline && !this._cancellable.is_cancelled()) {
                const requestStart = monotonicSecs();
                const bytes = await this._transfer(host, direction, sizes[index]);
                if (done)
                    return;
                if (bytes > 0) {
                    totalBytes += bytes;
                    onProgress(mbps());
                }
                const requestSecs = monotonicSecs() - requestStart;
                if (bytes === 0 || requestSecs > CHUNK_SLOW_SECS)
                    index = Math.max(0, index - 1);
                else if (requestSecs < CHUNK_FAST_SECS)
                    index = Math.min(sizes.length - 1, index + 1);
            }
        };

        const streams = [];
        for (let i = 0; i < CONCURRENCY; i++)
            streams.push(stream());
        // A stalled request must not hold up the result past the test duration.
        await this._raceTimeout(Promise.all(streams), durationMs + 2000);
        done = true;
        this._cancellable.set_error_if_cancelled();
        return mbps();
    }

    // Resolves to true when the server answered; network errors count as a lost sample.
    private async _ping(host: string): Promise<boolean> {
        const message = Soup.Message.new('GET', `https://${host}/speedtest/latency.txt?x=${Math.random()}`);
        try {
            await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
            return message.get_status() === Soup.Status.OK;
        } catch (e) {
            if (!isCancelled(e))
                return false;
            throw e;
        }
    }

    // Returns the number of bytes moved, or 0 when the request failed or was cancelled.
    private async _transfer(host: string, direction: Direction, size: number): Promise<number> {
        let message: Soup.Message;
        if (direction === 'download') {
            message = Soup.Message.new('GET', `https://${host}/speedtest/random${size}x${size}.jpg?x=${Math.random()}`);
        } else {
            message = Soup.Message.new('POST', `https://${host}/speedtest/upload.php`);
            message.set_request_body_from_bytes('application/octet-stream', new GLib.Bytes(new Uint8Array(size)));
        }
        try {
            const body = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (message.get_status() !== Soup.Status.OK)
                return 0;
            return direction === 'download' ? body.get_size() : size;
        } catch {
            // A failed chunk only shrinks the next one; the caller checks for cancellation.
            return 0;
        }
    }

    private async _raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
        let sourceId = 0;
        const timeout = new Promise<void>(resolve => {
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sourceIds.delete(sourceId);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._sourceIds.add(sourceId);
        });
        await Promise.race([promise, timeout]);
        // cancel() may already have removed it.
        if (this._sourceIds.delete(sourceId))
            GLib.Source.remove(sourceId);
    }
}
