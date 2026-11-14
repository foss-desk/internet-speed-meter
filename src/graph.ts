// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 MD Mojahid <aammojahid@gmail.com>

import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { KB, MB, fmtSize, fmtSpeed } from './format.js';
import { StatsManager, dayKey } from './stats.js';

export type GraphMode = 'realtime' | 'monthly';

type RGB = [number, number, number];

const WIDTH = 300;
const HEIGHT = 85;
const REALTIME_SAMPLES = 60;
// Keeps the plot below the header text row and above the axis labels.
const HEADER_HEIGHT = 34;
const FOOTER_HEIGHT = 12;

// Download (rx) and upload (tx) colors: saturated for the dark backdrop, darker shades for the light one.
const WAVE_COLORS: Record<'rx' | 'tx', { dark: RGB; light: RGB }> = {
    rx: { dark: [0.0, 0.82, 1.0], light: [0.039, 0.494, 0.643] },
    tx: { dark: [0.97, 0.34, 0.99], light: [0.671, 0.204, 0.431] },
};

// Cairo-drawn traffic graph: the last 60 samples as waves, or this month's daily totals as bars.
export class ActivityGraph extends St.DrawingArea {
    static {
        GObject.registerClass({ GTypeName: 'SpeedMeterActivityGraph' }, this);
    }

    private _mode: GraphMode = 'realtime';
    private _lightMode = false;
    private _rxSamples: number[] = new Array(REALTIME_SAMPLES).fill(0);
    private _txSamples: number[] = new Array(REALTIME_SAMPLES).fill(0);
    private _dailyTotals: number[] = [];
    private _monthlyPeak = 0;
    private _lastUpdateDay = -1;

    constructor() {
        super({ style_class: 'speed-meter-graph', x_expand: true, y_expand: true });
        this.set_size(WIDTH, HEIGHT);
    }

    setMode(mode: GraphMode): void {
        this._mode = mode;
        this.queue_repaint();
    }

    // Grid lines and labels are painted, not styled, so they follow the theme through this flag.
    setLightMode(light: boolean): void {
        this._lightMode = light;
        this.queue_repaint();
    }

    pushRealtimeSample(rxPerSec: number, txPerSec: number): void {
        this._rxSamples.shift();
        this._rxSamples.push(Math.max(0, rxPerSec));
        this._txSamples.shift();
        this._txSamples.push(Math.max(0, txPerSec));
        if (this._mode === 'realtime')
            this.queue_repaint();
    }

    updateFromStats(stats: StatsManager): void {
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daily = stats.getDailyData();
        this._dailyTotals = [];
        this._monthlyPeak = 10 * MB;
        for (let day = 1; day <= daysInMonth; day++) {
            const data = daily[dayKey(new Date(now.getFullYear(), now.getMonth(), day))];
            const total = data ? data.rx + data.tx : 0;
            this._dailyTotals.push(total);
            this._monthlyPeak = Math.max(this._monthlyPeak, total);
        }
        this._lastUpdateDay = now.getDate();
        if (this._mode === 'monthly')
            this.queue_repaint();
    }

    vfunc_repaint(): void {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (this._mode === 'realtime')
            this._drawRealtime(cr, width, height);
        else
            this._drawMonthly(cr, width, height);
        // Free the native context now instead of waiting for garbage collection.
        cr.$dispose();
    }

    private _ink(alphaDark: number, alphaLight: number): [number, number, number, number] {
        return this._lightMode ? [0.08, 0.1, 0.13, alphaLight] : [1, 1, 1, alphaDark];
    }

    private _waveColor(kind: 'rx' | 'tx'): RGB {
        return this._lightMode ? WAVE_COLORS[kind].light : WAVE_COLORS[kind].dark;
    }

    private _drawGrid(cr: Cairo.Context, width: number, bottom: number, plotHeight: number): void {
        cr.setSourceRGBA(...this._ink(0.05, 0.07));
        cr.setLineWidth(0.75);
        for (let i = 1; i <= 3; i++) {
            const y = bottom - plotHeight / 3 * i;
            cr.moveTo(0, y);
            cr.lineTo(width, y);
            cr.stroke();
        }
    }

    private _drawRealtime(cr: Cairo.Context, width: number, height: number): void {
        const peak = Math.max(...this._rxSamples, ...this._txSamples, 10 * KB);
        const plotHeight = height - HEADER_HEIGHT;
        const bottom = height - FOOTER_HEIGHT;
        this._drawGrid(cr, width, bottom, plotHeight);

        this._drawWave(cr, this._rxSamples, peak, width, bottom, plotHeight, this._waveColor('rx'));
        this._drawWave(cr, this._txSamples, peak, width, bottom, plotHeight, this._waveColor('tx'));

        const last = REALTIME_SAMPLES - 1;
        cr.setSourceRGBA(...this._waveColor('rx'), 0.95);
        const rxWidth = this._text(cr, `↓ ${fmtSpeed(this._rxSamples[last])}`, 8, 14, 9.5);
        cr.setSourceRGBA(...this._waveColor('tx'), 0.95);
        this._text(cr, `↑ ${fmtSpeed(this._txSamples[last])}`, 8 + rxWidth + 12, 14, 9.5);

        cr.setSourceRGBA(...this._ink(0.45, 0.5));
        this._text(cr, _('Peak: %s').format(fmtSpeed(peak)), width - 6, 14, 8.5, true);
        cr.setSourceRGBA(...this._ink(0.3, 0.38));
        this._text(cr, '-60s', 6, height - 2, 8);
        this._text(cr, _('now'), width - 6, height - 2, 8, true);
    }

    // Filled area under a smooth curve through the samples, then the curve itself on top.
    private _drawWave(cr: Cairo.Context, samples: number[], peak: number, width: number, bottom: number,
        plotHeight: number, rgb: RGB): void {
        const step = width / (samples.length - 1);
        const points = samples.map((value, i) => [i * step, bottom - Math.min(plotHeight, value / peak * plotHeight)]);
        const traceCurve = () => {
            for (let i = 1; i < points.length; i++) {
                const [x0, y0] = points[i - 1];
                const [x1, y1] = points[i];
                const midX = (x0 + x1) / 2;
                cr.curveTo(midX, y0, midX, y1, x1, y1);
            }
        };

        cr.moveTo(0, bottom);
        cr.lineTo(points[0][0], points[0][1]);
        traceCurve();
        cr.lineTo(width, bottom);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, 0, 0, bottom);
        fill.addColorStopRGBA(0, ...rgb, 0.38);
        fill.addColorStopRGBA(0.8, ...rgb, 0.08);
        fill.addColorStopRGBA(1, ...rgb, 0);
        cr.setSource(fill);
        cr.fill();

        cr.moveTo(points[0][0], points[0][1]);
        traceCurve();
        cr.setSourceRGBA(...rgb, 1);
        cr.setLineWidth(1.8);
        cr.stroke();
    }

    private _drawMonthly(cr: Cairo.Context, width: number, height: number): void {
        const days = this._dailyTotals.length;
        if (days === 0)
            return;

        const spacing = 3;
        const barWidth = Math.max(2, width / days - spacing);
        const plotHeight = height - HEADER_HEIGHT;
        const bottom = height - FOOTER_HEIGHT;
        this._drawGrid(cr, width, bottom, plotHeight);

        // Today stands out in the download color; past days are a muted bar.
        const pastColor: RGB = this._lightMode ? [0.42, 0.48, 0.58] : [1, 1, 1];
        const pastAlpha: [number, number] = this._lightMode ? [0.55, 0.22] : [0.35, 0.12];
        this._dailyTotals.forEach((total, index) => {
            const isToday = index + 1 === this._lastUpdateDay;
            if (total === 0 && !isToday)
                return;
            const barHeight = Math.max(2, total / this._monthlyPeak * plotHeight);
            const x = index * (barWidth + spacing);
            const y = bottom - barHeight;
            const gradient = new Cairo.LinearGradient(x, y, x, bottom);
            const [rgb, top, base] = isToday ? [this._waveColor('rx'), 1, 0.5] : [pastColor, ...pastAlpha];
            gradient.addColorStopRGBA(0, ...rgb, top);
            gradient.addColorStopRGBA(1, ...rgb, base);
            cr.setSource(gradient);
            cr.rectangle(x, y, barWidth, barHeight);
            cr.fill();
        });

        cr.setSourceRGBA(...this._ink(0.8, 0.85));
        this._text(cr, _('Monthly Peak: %s').format(fmtSize(this._monthlyPeak)), 8, 14, 9.5);
        cr.setSourceRGBA(...this._ink(0.4, 0.45));
        this._text(cr, _('Day %d').format(1), 0, height - 2, 8);
        this._text(cr, _('Day %d').format(days), width, height - 2, 8, true);
    }

    // Pango rather than Cairo's toy text API, which has no font fallback (the arrows drew as boxes).
    // `x` is the left edge (the right edge when alignRight) and `y` the baseline; returns the text width.
    private _text(cr: Cairo.Context, text: string, x: number, y: number, sizePx: number, alignRight = false): number {
        const layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string('Sans');
        font.set_absolute_size(sizePx * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_text(text, -1);
        const [width] = layout.get_pixel_size();
        cr.moveTo(alignRight ? x - width : x, y - layout.get_baseline() / Pango.SCALE);
        PangoCairo.show_layout(cr, layout);
        return width;
    }
}
