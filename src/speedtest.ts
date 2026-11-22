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
// Bytes moved while TCP is still ramping up are not counted.
const RAMP_UP_SECS = 1;
const READ_CHUNK_BYTES = 64 * 1024;
// Bytes arrive thousands of times per second on a fast link; the labels need far fewer updates.
const PROGRESS_INTERVAL_SECS = 0.1;

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
    private _uploadBodies = new Map<number, GLib.Bytes>();

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
        await this._phase(async cancellable => {
            const probes = candidates.map(async server => {
                const start = monotonicSecs();
                if (await this._ping(server.host, cancellable))
                    pings.set(server, monotonicSecs() - start);
            });
            await this._raceTimeout(Promise.allSettled(probes), PROBE_TIMEOUT_MS);
        });

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
        await this._phase(async cancellable => {
            // Opens the connection, so the TCP and TLS handshakes stay out of the samples.
            await this._ping(host, cancellable);
            for (let i = 0; i < LATENCY_SAMPLES; i++) {
                const start = monotonicSecs();
                if (await this._ping(host, cancellable))
                    samples.push((monotonicSecs() - start) * 1000);
            }
        });
        if (samples.length === 0)
            return null;

        return {
            pingMs: samples.reduce((a, b) => a + b, 0) / samples.length,
            jitterMs: averageJitter(samples),
            lossPct: (LATENCY_SAMPLES - samples.length) / LATENCY_SAMPLES * 100,
        };
    }

    // Runs CONCURRENCY parallel streams for durationMs and returns the throughput in Mbps.
    // Bytes are counted as they move, between the end of the ramp-up and the deadline.
    async measureThroughput(host: string, direction: Direction, durationMs: number, onProgress: (mbps: number) => void): Promise<number> {
        const sizes = direction === 'download' ? DOWNLOAD_SIZES : UPLOAD_SIZES;
        const start = monotonicSecs();
        const countFrom = start + RAMP_UP_SECS;
        const deadline = start + durationMs / 1000;
        let countedBytes = 0;
        let lastProgress = 0;
        const mbps = () => countedBytes * 8 / 1e6 / Math.max(Math.min(monotonicSecs(), deadline) - countFrom, 0.001);
        const onBytes = (bytes: number) => {
            const now = monotonicSecs();
            if (now < countFrom || now > deadline)
                return;
            countedBytes += bytes;
            if (now - lastProgress >= PROGRESS_INTERVAL_SECS) {
                lastProgress = now;
                onProgress(mbps());
            }
        };

        const stream = async (cancellable: Gio.Cancellable) => {
            let index = 1;
            while (monotonicSecs() < deadline && !cancellable.is_cancelled()) {
                const requestStart = monotonicSecs();
                const ok = direction === 'download'
                    ? await this._download(host, sizes[index], onBytes, cancellable)
                    : await this._upload(host, sizes[index], onBytes, cancellable);
                const requestSecs = monotonicSecs() - requestStart;
                if (!ok || requestSecs > CHUNK_SLOW_SECS)
                    index = Math.max(0, index - 1);
                else if (requestSecs < CHUNK_FAST_SECS)
                    index = Math.min(sizes.length - 1, index + 1);
            }
        };

        await this._phase(async cancellable => {
            const streams = [];
            for (let i = 0; i < CONCURRENCY; i++)
                streams.push(stream(cancellable));
            await this._raceTimeout(Promise.all(streams), durationMs);
        });
        return countedBytes > 0 ? mbps() : 0;
    }

    // Runs one phase with its own cancellable, cancelled with the test or as soon as the phase
    // ends, so that requests still in flight cannot skew the next phase. (Soup.Session.abort()
    // would cancel the test's own cancellable too.)
    private async _phase(work: (cancellable: Gio.Cancellable) => Promise<void>): Promise<void> {
        this._cancellable.set_error_if_cancelled();
        const cancellable = new Gio.Cancellable();
        // g_cancellable_connect(): also runs right away if the test is already cancelled.
        const handlerId = this._cancellable.connect(() => cancellable.cancel());
        try {
            await work(cancellable);
        } finally {
            this._cancellable.disconnect(handlerId);
            cancellable.cancel();
        }
        this._cancellable.set_error_if_cancelled();
    }

    // Resolves to true when the server answered; network errors count as a lost sample.
    private async _ping(host: string, cancellable: Gio.Cancellable): Promise<boolean> {
        const message = Soup.Message.new('GET', `https://${host}/speedtest/latency.txt?x=${Math.random()}`);
        try {
            await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            return message.get_status() === Soup.Status.OK;
        } catch (e) {
            if (!isCancelled(e))
                return false;
            throw e;
        }
    }

    // The _download/_upload pair resolves to false when the request failed or was aborted:
    // a failed chunk only shrinks the next one, and the caller checks for cancellation.
    private async _download(host: string, size: number, onBytes: (bytes: number) => void, cancellable: Gio.Cancellable): Promise<boolean> {
        const message = Soup.Message.new('GET', `https://${host}/speedtest/random${size}x${size}.jpg?x=${Math.random()}`);
        try {
            const stream = await this._session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            try {
                if (message.get_status() !== Soup.Status.OK)
                    return false;
                for (;;) {
                    const bytes = await stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
                    if (bytes.get_size() === 0)
                        return true;
                    onBytes(bytes.get_size());
                }
            } finally {
                stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
            }
        } catch {
            return false;
        }
    }

    private async _upload(host: string, size: number, onBytes: (bytes: number) => void, cancellable: Gio.Cancellable): Promise<boolean> {
        let body = this._uploadBodies.get(size);
        if (!body) {
            body = new GLib.Bytes(new Uint8Array(size));
            this._uploadBodies.set(size, body);
        }
        const message = Soup.Message.new('POST', `https://${host}/speedtest/upload.php`);
        message.set_request_body_from_bytes('application/octet-stream', body);
        message.connect('wrote-body-data', (_message, chunkSize: number) => onBytes(chunkSize));
        try {
            await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
            return message.get_status() === Soup.Status.OK;
        } catch {
            return false;
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
