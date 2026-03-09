/**
 * Big Shot — Drawing Actions
 *
 * All annotation tools that can be placed on a screenshot.
 * Each action knows how to draw itself via Cairo and report its bounds.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// =============================================================================
// DRAWING MODES
// =============================================================================

export const DrawingMode = Object.freeze({
    SELECT:      'SELECT',
    PEN:         'PEN',
    ARROW:       'ARROW',
    LINE:        'LINE',
    RECT:        'RECT',
    CIRCLE:      'CIRCLE',
    TEXT:        'TEXT',
    HIGHLIGHTER: 'HIGHLIGHTER',
    CENSOR:      'CENSOR',
    NUMBER:      'NUMBER',
});

// =============================================================================
// DRAWING OPTIONS
// =============================================================================

export class DrawingOptions {
    constructor({
        mode = DrawingMode.PEN,
        primaryColor = [0.93, 0.2, 0.23, 1.0],
        fillColor = null,
        borderColor = null,
        size = 3,
        font = 'Sans',
    } = {}) {
        this.mode = mode;
        this.primaryColor = primaryColor;
        this.fillColor = fillColor;
        this.borderColor = borderColor;
        this.size = size;
        this.font = font;
    }

    clone() {
        return new DrawingOptions({
            mode: this.mode,
            primaryColor: [...this.primaryColor],
            fillColor: this.fillColor ? [...this.fillColor] : null,
            borderColor: this.borderColor ? [...this.borderColor] : null,
            size: this.size,
            font: this.font,
        });
    }
}

// =============================================================================
// BASE ACTION
// =============================================================================

class DrawingAction {
    draw(_cr, _toWidget, _scale) {
        throw new Error('Not implemented');
    }

    getBounds() {
        throw new Error('Not implemented');
    }

    containsPoint(x, y) {
        const [minX, minY, maxX, maxY] = this.getBounds();
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    translate(_dx, _dy) {
        throw new Error('Not implemented');
    }
}

// =============================================================================
// PEN (freehand stroke with Bézier smoothing)
// =============================================================================

export class StrokeAction extends DrawingAction {
    constructor(stroke, options) {
        super();
        this.stroke = stroke;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        if (this.stroke.length < 2) return;

        const coords = this.stroke.map(([x, y]) => toWidget(x, y));
        const lineWidth = this.options.size * scale;

        cr.setLineWidth(lineWidth);
        cr.setLineCap(1); // ROUND
        cr.setLineJoin(1); // ROUND
        cr.setSourceRGBA(...this.options.primaryColor);

        cr.moveTo(...coords[0]);
        for (let i = 1; i < coords.length - 1; i++) {
            const [x1, y1] = coords[i];
            const [x2, y2] = coords[i + 1];
            const midX = (x1 + x2) * 0.5;
            const midY = (y1 + y2) * 0.5;
            cr.curveTo(x1, y1, x1, y1, midX, midY);
        }
        cr.lineTo(...coords[coords.length - 1]);
        cr.stroke();
    }

    getBounds() {
        if (!this.stroke.length) return [0, 0, 0, 0];
        const xs = this.stroke.map(p => p[0]);
        const ys = this.stroke.map(p => p[1]);
        const pad = this.options.size / 2;
        return [Math.min(...xs) - pad, Math.min(...ys) - pad,
                Math.max(...xs) + pad, Math.max(...ys) + pad];
    }

    translate(dx, dy) {
        this.stroke = this.stroke.map(([x, y]) => [x + dx, y + dy]);
    }
}

// =============================================================================
// ARROW
// =============================================================================

export class ArrowAction extends DrawingAction {
    constructor(start, end, shift, options) {
        super();
        this.options = options;
        this.start = start;

        if (shift) {
            const dx = Math.abs(end[0] - start[0]);
            const dy = Math.abs(end[1] - start[1]);
            this.end = dx > dy ? [end[0], start[1]] : [start[0], end[1]];
        } else {
            this.end = end;
        }
    }

    draw(cr, toWidget, scale) {
        const [sx, sy] = toWidget(...this.start);
        const [ex, ey] = toWidget(...this.end);
        const dist = Math.hypot(ex - sx, ey - sy);
        if (dist < 2) return;

        const width = this.options.size * 1.75 * scale;
        const angle = Math.atan2(ey - sy, ex - sx);
        const headSize = this.options.size * 3 * 1.75 * scale *
            Math.min(1.0, Math.max(0.3, dist / (120 * scale)));
        const arrowAngle = Math.PI / 6;

        cr.setLineWidth(width);
        cr.setLineCap(1); // ROUND
        cr.setSourceRGBA(...this.options.primaryColor);

        // Shaft
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();

        // Arrowhead
        const lx = ex + headSize * Math.cos(angle + Math.PI - arrowAngle);
        const ly = ey + headSize * Math.sin(angle + Math.PI - arrowAngle);
        const rx = ex + headSize * Math.cos(angle + Math.PI + arrowAngle);
        const ry = ey + headSize * Math.sin(angle + Math.PI + arrowAngle);

        cr.moveTo(ex, ey);
        cr.lineTo(lx, ly);
        cr.stroke();
        cr.moveTo(ex, ey);
        cr.lineTo(rx, ry);
        cr.stroke();
    }

    getBounds() {
        const pad = this.options.size * 3 * 1.75;
        return [
            Math.min(this.start[0], this.end[0]) - pad,
            Math.min(this.start[1], this.end[1]) - pad,
            Math.max(this.start[0], this.end[0]) + pad,
            Math.max(this.start[1], this.end[1]) + pad,
        ];
    }

    translate(dx, dy) {
        this.start = [this.start[0] + dx, this.start[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// LINE
// =============================================================================

export class LineAction extends ArrowAction {
    draw(cr, toWidget, scale) {
        const [sx, sy] = toWidget(...this.start);
        const [ex, ey] = toWidget(...this.end);

        const width = this.options.size * 1.75 * scale;
        cr.setLineWidth(width);
        cr.setLineCap(1);
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.moveTo(sx, sy);
        cr.lineTo(ex, ey);
        cr.stroke();
    }
}

// =============================================================================
// RECTANGLE
// =============================================================================

export class RectAction extends DrawingAction {
    constructor(start, end, shift, options) {
        super();
        this.options = options;
        this.start = start;
        this.end = end;
        this.shift = shift;
    }

    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        if (this.shift) {
            const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
            x2 = x2 < x1 ? x1 - size : x1 + size;
            y2 = y2 < y1 ? y1 - size : y1 + size;
        }

        const strokeOff = (this.options.size * scale) / 2;
        const x = Math.min(x1, x2) + strokeOff;
        const y = Math.min(y1, y2) + strokeOff;
        const w = Math.abs(x2 - x1) - this.options.size * scale;
        const h = Math.abs(y2 - y1) - this.options.size * scale;

        if (w <= 0 || h <= 0) return;

        if (this.options.fillColor) {
            cr.setSourceRGBA(...this.options.fillColor);
            cr.rectangle(x, y, w, h);
            cr.fill();
        }

        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(this.options.size * scale);
        cr.rectangle(x, y, w, h);
        cr.stroke();
    }

    getBounds() {
        return [
            Math.min(this.start[0], this.end[0]),
            Math.min(this.start[1], this.end[1]),
            Math.max(this.start[0], this.end[0]),
            Math.max(this.start[1], this.end[1]),
        ];
    }

    translate(dx, dy) {
        this.start = [this.start[0] + dx, this.start[1] + dy];
        this.end = [this.end[0] + dx, this.end[1] + dy];
    }
}

// =============================================================================
// CIRCLE / OVAL
// =============================================================================

export class CircleAction extends RectAction {
    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        if (this.shift) {
            const size = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
            x2 = x2 < x1 ? x1 - size : x1 + size;
            y2 = y2 < y1 ? y1 - size : y1 + size;
        }

        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        const rx = (Math.abs(x2 - x1) - this.options.size * scale) / 2;
        const ry = (Math.abs(y2 - y1) - this.options.size * scale) / 2;

        if (rx <= 0 || ry <= 0) return;

        cr.save();
        cr.translate(cx, cy);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();

        if (this.options.fillColor) {
            cr.setSourceRGBA(...this.options.fillColor);
            cr.fillPreserve();
        }

        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(this.options.size * scale);
        cr.stroke();
    }
}

// =============================================================================
// TEXT
// =============================================================================

export class TextAction extends DrawingAction {
    constructor(position, text, options, fontSize = 16) {
        super();
        this.position = position;
        this.text = text;
        this.options = options;
        this.fontSize = fontSize;
    }

    draw(cr, toWidget, scale) {
        if (!this.text.trim()) return;

        const [wx, wy] = toWidget(...this.position);
        const size = this.fontSize * scale;

        cr.selectFontFace(this.options.font, 0, 0); // NORMAL, NORMAL
        cr.setFontSize(size);

        const extents = cr.textExtents(this.text);
        const tx = wx - extents.width / 2 - extents.xBearing;
        const ty = wy;

        // Background fill
        if (this.options.fillColor) {
            const pad = 4 * scale;
            cr.setSourceRGBA(...this.options.fillColor);
            const bgX = tx - pad + extents.xBearing;
            const bgY = ty - size - pad + extents.yBearing;
            const bgW = extents.width + 2 * pad;
            const bgH = size + 2 * pad;

            // Rounded rectangle
            const r = Math.min(6 * scale, Math.min(bgW, bgH) / 4);
            cr.newSubPath();
            cr.arc(bgX + r, bgY + r, r, Math.PI, 3 * Math.PI / 2);
            cr.arc(bgX + bgW - r, bgY + r, r, 3 * Math.PI / 2, 0);
            cr.arc(bgX + bgW - r, bgY + bgH - r, r, 0, Math.PI / 2);
            cr.arc(bgX + r, bgY + bgH - r, r, Math.PI / 2, Math.PI);
            cr.closePath();
            cr.fill();
        }

        // Text
        cr.moveTo(tx, ty);
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.showText(this.text);
    }

    getBounds() {
        const pad = this.fontSize + 8;
        const [x, y] = this.position;
        const estimatedWidth = this.text.length * this.fontSize * 0.6;
        return [
            x - estimatedWidth / 2 - pad,
            y - this.fontSize - pad,
            x + estimatedWidth / 2 + pad,
            y + pad,
        ];
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
    }
}

// =============================================================================
// HIGHLIGHTER
// =============================================================================

export class HighlighterAction extends StrokeAction {
    constructor(stroke, options, shift) {
        if (shift && stroke.length >= 2) {
            const start = stroke[0];
            const end = stroke[stroke.length - 1];
            super([start, [end[0], start[1]]], options);
        } else {
            super(stroke, options);
        }
    }

    draw(cr, toWidget, scale) {
        if (this.stroke.length < 2) return;

        const coords = this.stroke.map(([x, y]) => toWidget(x, y));

        cr.save();
        // Cairo.Operator.MULTIPLY = 14 (for highlight blending effect)
        cr.setOperator(14);
        cr.setSourceRGBA(...this.options.primaryColor);
        cr.setLineWidth(this.options.size * scale * 2);
        cr.setLineCap(0); // BUTT

        cr.moveTo(...coords[0]);
        for (let i = 1; i < coords.length; i++) {
            cr.lineTo(...coords[i]);
        }
        cr.stroke();
        cr.restore();
    }
}

// =============================================================================
// CENSOR (pixelation)
// =============================================================================

export class CensorAction extends RectAction {
    draw(cr, toWidget, scale) {
        let [x1, y1] = toWidget(...this.start);
        let [x2, y2] = toWidget(...this.end);

        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);

        if (w < 1 || h < 1) return;

        // Draw a solid dark overlay to simulate censoring
        // Real pixelation would need the source image data
        cr.save();
        cr.rectangle(x, y, w, h);
        cr.clip();

        const blockSize = 8 * scale;
        const blocksX = Math.max(1, Math.floor(w / blockSize));
        const blocksY = Math.max(1, Math.floor(h / blockSize));

        for (let bx = 0; bx < blocksX; bx++) {
            for (let by = 0; by < blocksY; by++) {
                // Alternate colors for mosaic effect
                const shade = ((bx + by) % 2 === 0) ? 0.3 : 0.5;
                cr.setSourceRGBA(shade, shade, shade, 0.9);
                cr.rectangle(
                    x + bx * blockSize,
                    y + by * blockSize,
                    blockSize,
                    blockSize
                );
                cr.fill();
            }
        }
        cr.restore();
    }
}

// =============================================================================
// NUMBER STAMP
// =============================================================================

export class NumberStampAction extends DrawingAction {
    constructor(position, number, options) {
        super();
        this.position = position;
        this.number = number;
        this.options = options;
    }

    draw(cr, toWidget, scale) {
        const [wx, wy] = toWidget(...this.position);
        const r = this.options.size * 2 * scale;

        // Circle background
        cr.setSourceRGBA(...(this.options.fillColor || this.options.primaryColor));
        cr.arc(wx, wy, r, 0, 2 * Math.PI);
        cr.fill();

        // Circle border
        if (this.options.borderColor) {
            cr.setSourceRGBA(...this.options.borderColor);
            cr.setLineWidth(2 * scale);
            cr.arc(wx, wy, r, 0, 2 * Math.PI);
            cr.stroke();
        }

        // Number text
        cr.selectFontFace('Sans', 0, 1); // NORMAL, BOLD
        cr.setFontSize(r * 1.2);
        const text = String(this.number);
        const ext = cr.textExtents(text);
        const tx = wx - ext.width / 2 - ext.xBearing;
        const ty = wy + ext.height / 2;

        if (this.options.borderColor) {
            cr.moveTo(tx, ty);
            cr.textPath(text);
            cr.setSourceRGBA(...this.options.borderColor);
            cr.setLineWidth(4 * scale);
            cr.strokePreserve();
        }

        cr.setSourceRGBA(1, 1, 1, 1); // White text
        cr.moveTo(tx, ty);
        cr.showText(text);
    }

    getBounds() {
        const r = this.options.size * 2 + 5;
        const [x, y] = this.position;
        return [x - r, y - r, x + r, y + r];
    }

    containsPoint(px, py) {
        const [x, y] = this.position;
        const r = this.options.size * 2 + 5;
        return (px - x) ** 2 + (py - y) ** 2 <= r ** 2;
    }

    translate(dx, dy) {
        this.position = [this.position[0] + dx, this.position[1] + dy];
    }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a drawing action from the current mode and input
 */
export function createAction(mode, data, options) {
    switch (mode) {
        case DrawingMode.PEN:
            return new StrokeAction(data.stroke, options);
        case DrawingMode.ARROW:
            return new ArrowAction(data.start, data.end, data.shift, options);
        case DrawingMode.LINE:
            return new LineAction(data.start, data.end, data.shift, options);
        case DrawingMode.RECT:
            return new RectAction(data.start, data.end, data.shift, options);
        case DrawingMode.CIRCLE:
            return new CircleAction(data.start, data.end, data.shift, options);
        case DrawingMode.TEXT:
            return new TextAction(data.position, data.text, options, data.fontSize);
        case DrawingMode.HIGHLIGHTER:
            return new HighlighterAction(data.stroke, options, data.shift);
        case DrawingMode.CENSOR:
            return new CensorAction(data.start, data.end, false, options);
        case DrawingMode.NUMBER:
            return new NumberStampAction(data.position, data.number, options);
        default:
            return null;
    }
}
