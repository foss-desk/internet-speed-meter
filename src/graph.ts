// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
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
    private _lightMode: boolean = false;

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
     * The graph's backdrop (.speed-meter-graph-container) switches between a
     * dark and a light background via CSS depending on the shell theme; the
     * Cairo-drawn grid lines/labels/ghost-bars below are painted directly
     * (not themeable via CSS) so they need the same light/dark switch here.
     */
    setLightMode(light: boolean): void {
        if (this._lightMode !== light) {
            this._lightMode = light;
            this.queue_repaint();
        }
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

        const dailyHistory = stats.getDailyData();

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

    // Grid lines/labels are painted with light "ink" on the dark backdrop;
    // on the light-mode backdrop the same ink would be nearly invisible, so
    // this picks a dark ink instead, keeping the dark-mode alpha by default.
    private _ink(alphaDark: number, alphaLight: number = alphaDark): [number, number, number, number] {
        return this._lightMode ? [0.08, 0.1, 0.13, alphaLight] : [1, 1, 1, alphaDark];
    }

    // Download/upload wave colors are a saturated neon cyan/magenta tuned for
    // the dark backdrop; on the light backdrop they're swapped for the same
    // darker teal/magenta shades to keep contrast against a light background.
    private _waveColor(kind: 'rx' | 'tx'): [number, number, number] {
        if (kind === 'rx') return this._lightMode ? [0.039, 0.494, 0.643] : [0.0, 0.82, 1.0];
        return this._lightMode ? [0.671, 0.204, 0.431] : [0.97, 0.34, 0.99];
    }

    private _draw(area: any): void {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        try {
            if (w <= 0 || h <= 0) return;
            if (this._mode === 'realtime') {
                this._drawRealtimeGraph(cr, w, h);
            } else {
                this._drawMonthlyGraph(cr, w, h);
            }
        } finally {
            // Free the native context now instead of waiting for GC (gjs.guide).
            cr.$dispose();
        }
    }

    /**
     * Renders a fluid 60-second real-time Bezier wave graph for RX and TX speeds.
     */
    private _drawRealtimeGraph(cr: any, w: number, h: number): void {
        const maxRx = Math.max(...this._rxBuffer, 1024 * 10); // Minimum 10 KB/s scale
        const maxTx = Math.max(...this._txBuffer, 1024 * 10);
        const peakSpeed = Math.max(maxRx, maxTx);

        const graphH = h - 34; // keep the waves below the header text row
        const bottomY = h - 12;
        const count = this._rxBuffer.length;
        const stepX = w / (count - 1);

        // Subtle background grid
        cr.setSourceRGBA(...this._ink(0.05, 0.07));
        cr.setLineWidth(0.75);
        for (let i = 1; i <= 3; i++) {
            const y = bottomY - (graphH / 3) * i;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        // Draw RX Curve (Download)
        this._drawBezierWave(cr, this._rxBuffer, peakSpeed, stepX, bottomY, graphH, this._waveColor('rx'));

        // Draw TX Curve (Upload)
        this._drawBezierWave(cr, this._txBuffer, peakSpeed, stepX, bottomY, graphH, this._waveColor('tx'));

        // Top Header Info with neon bullets
        const currentRx = this._rxBuffer[count - 1];
        const currentTx = this._txBuffer[count - 1];

        // Download pill
        const [rxR, rxG, rxB] = this._waveColor('rx');
        cr.setSourceRGBA(rxR, rxG, rxB, 0.95);
        const rxWidth = this._text(cr, `\u2193 ${this._fmtSpeed(currentRx)}`, 8, 14, 9.5);

        // Upload pill
        const [txR, txG, txB] = this._waveColor('tx');
        cr.setSourceRGBA(txR, txG, txB, 0.95);
        this._text(cr, `\u2191 ${this._fmtSpeed(currentTx)}`, 8 + rxWidth + 12, 14, 9.5);

        // Peak Badge
        cr.setSourceRGBA(...this._ink(0.45, 0.5));
        this._text(cr, `Peak: ${this._fmtSpeed(peakSpeed)}`, w - 6, 14, 8.5, true);

        // Bottom axis labels
        cr.setSourceRGBA(...this._ink(0.3, 0.38));
        this._text(cr, '-60s', 6, h - 2, 8);
        this._text(cr, 'now', w - 6, h - 2, 8, true);
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

        // Fill path under wave with smooth gradient
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
        grad.addColorStopRGBA(0, rgb[0], rgb[1], rgb[2], 0.38);
        grad.addColorStopRGBA(0.8, rgb[0], rgb[1], rgb[2], 0.08);
        grad.addColorStopRGBA(1, rgb[0], rgb[1], rgb[2], 0.0);
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

        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 1.0);
        cr.setLineWidth(1.8);
        cr.stroke();
    }

    private _drawMonthlyGraph(cr: any, w: number, h: number): void {
        if (this._dailyData.length === 0) return;

        const numDays = this._dailyData.length;
        const barSpacing = 3;
        const barWidth = Math.max(2, (w / numDays) - barSpacing);
        const maxBarHeight = h - 34; // keep bars below the header text row
        const bottomY = h - 12;

        // Subtle horizontal guide lines
        cr.setSourceRGBA(...this._ink(0.05, 0.07));
        cr.setLineWidth(0.75);
        for (let i = 1; i <= 3; i++) {
            const y = bottomY - (maxBarHeight / 3) * i;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        for (let i = 0; i < numDays; i++) {
            const val = this._dailyData[i];
            if (val === 0 && (i + 1) !== this._lastUpdateDay) continue;

            const barH = Math.max(2, (val / this._peakValue) * maxBarHeight);
            const x = i * (barWidth + barSpacing);
            const y = bottomY - barH;

            if ((i + 1) === this._lastUpdateDay) {
                // Today's bar in the download color (neon cyan is unreadable on light)
                const [r, g, b] = this._waveColor('rx');
                const grad = new (Cairo as any).LinearGradient(x, y, x, bottomY);
                grad.addColorStopRGBA(0, r, g, b, 1.0);
                grad.addColorStopRGBA(1, r, g, b, 0.5);
                cr.setSource(grad);
            } else if (this._lightMode) {
                // Past days muted slate-blue bar (the dark-mode "frosted
                // glass" white-on-dark fill would be invisible on light)
                const grad = new (Cairo as any).LinearGradient(x, y, x, bottomY);
                grad.addColorStopRGBA(0, 0.42, 0.48, 0.58, 0.55);
                grad.addColorStopRGBA(1, 0.42, 0.48, 0.58, 0.22);
                cr.setSource(grad);
            } else {
                // Past days subtle frosted glass bar
                const grad = new (Cairo as any).LinearGradient(x, y, x, bottomY);
                grad.addColorStopRGBA(0, 1, 1, 1, 0.35);
                grad.addColorStopRGBA(1, 1, 1, 1, 0.12);
                cr.setSource(grad);
            }

            cr.rectangle(x, y, barWidth, barH);
            cr.fill();
        }

        cr.setSourceRGBA(...this._ink(0.8, 0.85));
        this._text(cr, `Monthly Peak: ${this._fmt(this._peakValue)}`, 8, 14, 9.5);

        cr.setSourceRGBA(...this._ink(0.4, 0.45));
        this._text(cr, 'Day 1', 0, h - 2, 8);
        this._text(cr, `Day ${numDays}`, w, h - 2, 8, true);
    }

    // Pango instead of Cairo's toy text API, which has no font fallback (\u2193/\u2191 drew as boxes).
    // `x` is the left edge (right edge when alignRight), `y` the baseline; returns the text width.
    private _text(cr: any, text: string, x: number, y: number, sizePx: number, alignRight = false): number {
        const layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string('Sans');
        font.set_absolute_size(sizePx * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_text(text, -1);
        const width = layout.get_pixel_extents()[1]?.width ?? 0;
        cr.moveTo(alignRight ? x - width : x, y - layout.get_baseline() / Pango.SCALE);
        PangoCairo.show_layout(cr, layout);
        return width;
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

