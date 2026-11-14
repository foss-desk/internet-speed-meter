// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

export const KB = 1024;
export const MB = KB * 1024;
export const GB = MB * 1024;

export function fmtSize(bytes: number, precision = 1): string {
    if (bytes >= GB) return `${(bytes / GB).toFixed(precision)} GB`;
    if (bytes >= MB) return `${(bytes / MB).toFixed(precision)} MB`;
    if (bytes >= KB) return `${(bytes / KB).toFixed(Math.max(0, precision - 1))} KB`;
    return `${Math.round(bytes)} B`;
}

export function fmtSpeed(bytesPerSec: number, useBits = false): string {
    if (useBits) {
        const bits = bytesPerSec * 8;
        if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
        if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kbps`;
        return `${Math.round(bits)} bps`;
    }
    if (bytesPerSec >= MB) return `${(bytesPerSec / MB).toFixed(1)} MB/s`;
    if (bytesPerSec >= KB) return `${(bytesPerSec / KB).toFixed(1)} KB/s`;
    return `${Math.round(bytesPerSec)} B/s`;
}

// Marks a string for translation extraction; translate it with _() where it is displayed.
export const N_ = (text: string): string => text;
