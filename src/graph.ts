// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2025 Mojahid <mojahid@lunecode.com>

import Cairo from 'gi://cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { StatsManager, TrafficData } from './stats.js';

/**
 * HIGH-PERFORMANCE Monthly History Graph.
 * Optimized with Lazy-Caching to minimize CPU/RAM impact.
 */
class ActivityGraphImpl extends St.DrawingArea {
    private _dailyData: number[] = [];
    private _peakValue: number = 0;
    private _lastUpdateDay: number = -1;

    _init() {
        super._init({
            style_class: 'speed-meter-graph',
            can_focus: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        this.set_size(300, 80);
        this.connect('repaint', (area: any) => this._draw(area));
    }

    vfunc_get_preferred_width(_forHeight: number): [number, number] {
        return [300, 300];
    }

    vfunc_get_preferred_height(_forWidth: number): [number, number] {
        return [80, 80];
    }

    /**
     * Efficiently updates stats with lazy-caching.
     * Only re-processes data if the day has changed.
     */
    updateFromStats(stats: StatsManager): void {
        const now = new Date();
        const currentDay = now.getDate();
        
        // Lazy-Cache: Skip if we already updated today (unless data is missing)
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
        this.queue_repaint();
    }

    private _draw(area: any): void {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        if (w <= 0 || h <= 0 || this._dailyData.length === 0) return;

        const numDays = this._dailyData.length;
        const barSpacing = 4;
        const barWidth = Math.max(2, (w / numDays) - barSpacing);
        const maxBarHeight = h - 25;
        const bottomY = h - 12;

        // Draw Background Grid
        cr.setSourceRGBA(1, 1, 1, 0.08);
        cr.setLineWidth(0.8);
        for (let i = 1; i <= 4; i++) {
            const y = (maxBarHeight / 4) * i;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }

        // Draw Bars
        for (let i = 0; i < numDays; i++) {
            const val = this._dailyData[i];
            const barH = Math.max(1, (val / this._peakValue) * maxBarHeight);
            const x = i * (barWidth + barSpacing);
            const y = bottomY - barH;

            const isToday = (i + 1) === this._lastUpdateDay;
            
            if (isToday) {
                // Vibrant Gradient for today
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

        // Labels
        this._drawLabel(cr, `Peak: ${this._fmt(this._peakValue)}`, 5, 15);
        this._drawDayLabels(cr, w, h, numDays);
    }

    private _drawLabel(cr: any, text: string, x: number, y: number): void {
        cr.setSourceRGBA(1, 1, 1, 0.7);
        cr.selectFontFace("Inter", 0, 0);
        cr.setFontSize(11);
        cr.moveTo(x, y);
        cr.showText(text);
    }

    private _drawDayLabels(cr: any, w: number, h: number, numDays: number): void {
        cr.setSourceRGBA(1, 1, 1, 0.4);
        cr.setFontSize(10);
        cr.moveTo(0, h - 2);
        cr.showText("Day 1");
        cr.moveTo(w - 45, h - 2);
        cr.showText(`Day ${numDays}`);
    }

    private _fmt(bytes: number): string {
        if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
        if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
        if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${bytes} B`;
    }
}

export const ActivityGraph = GObject.registerClass({
    GTypeName: 'SpeedMeterActivityGraph',
}, ActivityGraphImpl);

export type ActivityGraph = ActivityGraphImpl;
