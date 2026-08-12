// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { StatsManager, TrafficData } from './stats.js';

export type GraphMode = 'realtime' | 'monthly';

/**
 * HIGH-PERFORMANCE Dual-Mode Graph Widget (Live 60s Bezier Wave + Monthly History).
 * Optimized with Cairo rendering and Bezier curve smoothing.
 */
class ActivityGraphImpl extends St.DrawingArea {
    private _mode: GraphMode = 'realtime';
    private _dailyData: number[] = [];
    private _peakValue: number = 0;
    private _lastUpdateDay: number = -1;

    // Real-time 60-second rolling sample buffer
    private _rxBuffer: number[] = new Array(60).fill(0);
    private _txBuffer: number[] = new Array(60).fill(0);

    _init() {
        super._init({
            style_class: 'speed-meter-graph',
            can_focus: false,
            reactive: true,
            x_expand: true,
            y_expand: true,
        });

        this.set_size(300, 85);
        this.connect('repaint', (area: any) => this._draw(area));
    }

    vfunc_get_preferred_width(_forHeight: number): [number, number] {
        return [300, 300];
    }

    vfunc_get_preferred_height(_forWidth: number): [number, number] {
        return [85, 85];
    }

    setMode(mode: GraphMode): void {
        if (this._mode !== mode) {
            this._mode = mode;
            this.queue_repaint();
        }
    }

    getMode(): GraphMode {
        return this._mode;
    }

    toggleMode(): void {
        this._mode = this._mode === 'realtime' ? 'monthly' : 'realtime';
        this.queue_repaint();
    }

    /**
     * Push a new real-time speed tick (bytes/sec) into the 60s rolling buffer.
     */
    pushRealtimeSample(rxs: number, txs: number): void {
        this._rxBuffer.shift();
        this._rxBuffer.push(Math.max(0, rxs));
        
        this._txBuffer.shift();
        this._txBuffer.push(Math.max(0, txs));

        if (this._mode === 'realtime') {
            this.queue_repaint();
        }
    }

    /**
     * Efficiently updates monthly stats with lazy-caching.
     */
    updateFromStats(stats: StatsManager): void {
        const now = new Date();
        const currentDay = now.getDate();
        
        if (this._lastUpdateDay === currentDay && this._dailyData.length > 0) {
            return;
        }

        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        const newDailyData: number[] = [];
        let peak = 1024 * 1024 * 10; // 10 MB floor

        const dailyHistory = (stats as any)._history.daily;

        for (let d = 1; d <= daysInMonth; d++) {
            const dayKey = `${yearMonth}-${String(d).padStart(2, '0')}`;
            const data: TrafficData = dailyHistory[dayKey] || { rx: 0, tx: 0 };
            const total = data.rx + data.tx;
            
            newDailyData.push(total);
            if (total > peak) peak = total;
        }

        this._dailyData = newDailyData;
        this._peakValue = peak;
        this._lastUpdateDay = currentDay;
        
        if (this._mode === 'monthly') {
            this.queue_repaint();
        }
    }

    private _draw(area: any): void {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        if (w <= 0 || h <= 0) return;

        if (this._mode === 'realtime') {
            this._drawRealtimeGraph(cr, w, h);
        } else {
            this._drawMonthlyGraph(cr, w, h);
        }
    }

    /**
     * Renders a fluid 60-second real-time Bezier wave graph for RX and TX speeds.
     */
    private _drawRealtimeGraph(cr: any, w: number, h: number): void {
        const maxRx = Math.max(...this._rxBuffer, 1024 * 10); // Minimum 10 KB/s scale
        const maxTx = Math.max(...this._txBuffer, 1024 * 10);
        const peakSpeed = Math.max(maxRx, maxTx);

        const graphH = h - 22;
        const bottomY = h - 12;
        const count = this._rxBuffer.length;
        const stepX = w / (count - 1);

        // Grid lines
        cr.setSourceRGBA(1, 1, 1, 0.06);
        cr.setLineWidth(0.8);
        for (let i = 1; i <= 3; i++) {
            const y = (graphH / 3) * i;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        // Draw RX Curve (Download - Cyan/Blue)
        this._drawBezierWave(cr, this._rxBuffer, peakSpeed, stepX, bottomY, graphH, [0.21, 0.52, 0.89]);

        // Draw TX Curve (Upload - Orange/Red)
        this._drawBezierWave(cr, this._txBuffer, peakSpeed, stepX, bottomY, graphH, [0.96, 0.38, 0.32]);

        // Top Header Info
        const currentRx = this._rxBuffer[count - 1];
        const currentTx = this._txBuffer[count - 1];

        cr.setSourceRGBA(0.21, 0.52, 0.89, 0.9);
        cr.setFontSize(9.5);
        cr.moveTo(6, 13);
        cr.showText(`\u2193 ${this._fmtSpeed(currentRx)}`);

        cr.setSourceRGBA(0.96, 0.38, 0.32, 0.9);
        cr.moveTo(90, 13);
        cr.showText(`\u2191 ${this._fmtSpeed(currentTx)}`);

        cr.setSourceRGBA(1, 1, 1, 0.4);
        cr.moveTo(w - 110, 13);
        cr.showText(`Peak: ${this._fmtSpeed(peakSpeed)}`);

        // Bottom axis label
        cr.setSourceRGBA(1, 1, 1, 0.35);
        cr.setFontSize(8.5);
        cr.moveTo(4, h - 2);
        cr.showText("-60s");
        cr.moveTo(w - 20, h - 2);
        cr.showText("now");
    }

    private _drawBezierWave(
        cr: any,
        data: number[],
        peak: number,
        stepX: number,
        bottomY: number,
        graphH: number,
        rgb: [number, number, number]
    ): void {
        const count = data.length;
        const points: { x: number; y: number }[] = [];

        for (let i = 0; i < count; i++) {
            const val = data[i];
            const ratio = peak > 0 ? val / peak : 0;
            const y = bottomY - Math.min(graphH, ratio * graphH);
            const x = i * stepX;
            points.push({ x, y });
        }

        // Fill path under wave
        cr.moveTo(0, bottomY);
        cr.lineTo(points[0].x, points[0].y);

        for (let i = 0; i < count - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const cp1x = p0.x + (p1.x - p0.x) / 2;
            const cp1y = p0.y;
            const cp2x = p0.x + (p1.x - p0.x) / 2;
            const cp2y = p1.y;
            cr.curveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
        }

        cr.lineTo(w_calc(count, stepX), bottomY);
        cr.closePath();

        const grad = new (Cairo as any).LinearGradient(0, 0, 0, bottomY);
        grad.addColorStopRGBA(0, rgb[0], rgb[1], rgb[2], 0.35);
        grad.addColorStopRGBA(1, rgb[0], rgb[1], rgb[2], 0.02);
        cr.setSource(grad);
        cr.fill();

        // Stroke line
        cr.moveTo(points[0].x, points[0].y);
        for (let i = 0; i < count - 1; i++) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const cp1x = p0.x + (p1.x - p0.x) / 2;
            const cp1y = p0.y;
            const cp2x = p0.x + (p1.x - p0.x) / 2;
            const cp2y = p1.y;
            cr.curveTo(cp1x, cp1y, cp2x, cp2y, p1.x, p1.y);
        }

        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 0.95);
        cr.setLineWidth(1.6);
        cr.stroke();
    }

    private _drawMonthlyGraph(cr: any, w: number, h: number): void {
        if (this._dailyData.length === 0) return;

        const numDays = this._dailyData.length;
        const barSpacing = 3;
        const barWidth = Math.max(2, (w / numDays) - barSpacing);
        const maxBarHeight = h - 25;
        const bottomY = h - 12;

        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(0.8);
        for (let i = 1; i <= 4; i++) {
            const y = (maxBarHeight / 4) * i;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        for (let i = 0; i < numDays; i++) {
            const val = this._dailyData[i];
            if (val === 0 && (i + 1) !== this._lastUpdateDay) continue;

            const barH = Math.max(1, (val / this._peakValue) * maxBarHeight);
            const x = i * (barWidth + barSpacing);
            const y = bottomY - barH;

            if ((i + 1) === this._lastUpdateDay) {
                const grad = new (Cairo as any).LinearGradient(x, y, x, bottomY);
                grad.addColorStopRGBA(0, 0.21, 0.52, 0.89, 1);
                grad.addColorStopRGBA(1, 0.21, 0.52, 0.89, 0.4);
                cr.setSource(grad);
            } else {
                cr.setSourceRGBA(1, 1, 1, 0.2);
            }

            cr.rectangle(x, y, barWidth, barH);
            cr.fill();
        }

        cr.setSourceRGBA(1, 1, 1, 0.7);
        cr.setFontSize(10);
        cr.moveTo(5, 14);
        cr.showText(`Monthly Peak: ${this._fmt(this._peakValue)}`);

        cr.setSourceRGBA(1, 1, 1, 0.4);
        cr.moveTo(0, h - 2);
        cr.showText("Day 1");
        cr.moveTo(w - 45, h - 2);
        cr.showText(`Day ${numDays}`);
    }

    private _fmtSpeed(bytesPerSec: number): string {
        if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
        if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        return `${Math.round(bytesPerSec)} B/s`;
    }

    private _fmt(bytes: number): string {
        if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
        if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${bytes} B`;
    }
}

function w_calc(count: number, stepX: number): number {
    return (count - 1) * stepX;
}

export const ActivityGraph = GObject.registerClass({
    GTypeName: 'SpeedMeterActivityGraph',
}, ActivityGraphImpl);

export type ActivityGraph = ActivityGraphImpl;

