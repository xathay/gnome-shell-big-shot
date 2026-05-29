/**
 * Big Shot — Scrolling capture (capture + scroll + stitch)
 *
 * Captures a scrollable region by repeatedly screenshotting, synthesizing a
 * scroll event, and stitching the frames into one tall PNG. Works on any
 * scrollable app — browser pages, WhatsApp/Telegram desktop, Thunderbird,
 * PDF viewers, terminal scrollback, etc.
 *
 * Pipeline:
 *   1. capture frame of region              → GdkPixbuf
 *   2. synthesize scroll-down at region center
 *   3. wait settle delay (~120 ms by default)
 *   4. capture next frame
 *   5. overlap = findVerticalOverlap(prev, curr)
 *      - if overlap == frame_height (frames identical) → end-of-content, stop
 *      - else append curr[overlap..] to canvas
 *   6. safety cap: max frames + total timeout
 *   7. save canvas as PNG → ~/Imagens/BigShot/scroll-<timestamp>.png
 *
 * Triggered by a global keybinding (see schemas/) or by external call
 * (PartScroll.prototype.startScrollingCapture).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartBase } from './partbase.js';

const KEYBINDING_NAME = 'scrolling-capture';

const DEFAULTS = {
    maxFrames: 60,           // safety cap
    totalTimeoutMs: 45_000,  // safety cap
    scrollSettleMs: 150,     // wait after each scroll for the app to redraw
    scrollAmount: 5,         // discrete-scroll ticks per step (≈ 5 mouse-wheel notches)
    overlapSearchRows: 200,  // how many rows from the bottom of prev to search at the top of curr
    minOverlapRows: 4,       // anything less than this is treated as "no overlap"
    endOfContentMatch: 0.995, // similarity threshold to declare end-of-content
};

export class PartScroll extends PartBase {
    constructor(extension) {
        super();
        this._ext = extension;
        this._busy = false;
        this._source = null;
        this._virtualDevice = null;
        this._keybindingRegistered = false;

        this._registerKeybinding();
    }

    _registerKeybinding() {
        try {
            const settings = this._ext.getSettings?.();
            if (settings && settings.list_keys().includes(KEYBINDING_NAME)) {
                Main.wm.addKeybinding(
                    KEYBINDING_NAME,
                    settings,
                    Meta.KeyBindingFlags.NONE,
                    Shell.ActionMode.NORMAL,
                    () => this.startForFocusedWindow(),
                );
                this._keybindingRegistered = true;
                return;
            }
        } catch (e) {
            console.log(`[Big Shot Scroll] settings unavailable: ${e.message}`);
        }
        console.log(
            `[Big Shot Scroll] no schema for '${KEYBINDING_NAME}'; ` +
            `call PartScroll.startForFocusedWindow() to test.`,
        );
    }

    /**
     * Capture the currently focused window using the default scroll
     * configuration. The window is used as the region.
     */
    startForFocusedWindow(overrides = {}) {
        if (this._busy) {
            this._notify(_('Captura rolante em andamento'), _('Aguarde a atual terminar.'));
            return;
        }
        const win = global.display.get_focus_window();
        if (!win) {
            this._notify(_('Sem janela em foco'), _('Foque a janela alvo antes de acionar.'));
            return;
        }
        const rect = win.get_frame_rect();
        this.startScrollingCapture(
            { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            { ...DEFAULTS, ...overrides, windowId: win.get_id() },
        ).catch(e => {
            console.error(`[Big Shot Scroll] capture failed: ${e.message}\n${e.stack}`);
            this._notify(_('Captura rolante falhou'), e.message);
            this._busy = false;
        });
    }

    /**
     * Main entry point — capture a scrollable region.
     * @param {{x,y,width,height}} region  region in stage coords
     * @param {object} opts                merged DEFAULTS + overrides
     */
    async startScrollingCapture(region, opts) {
        this._busy = true;
        const tStart = GLib.get_monotonic_time();
        const frames = [];
        let stitchHeight = 0;
        let lastFrame = null;
        let endDetected = false;

        const progressNotif = this._notify(
            _('Captura rolante iniciada'),
            _('Rolando %d×%d em (%d, %d)…').format(region.width, region.height, region.x, region.y),
            { transient: false },
        );

        try {
            // Frame 0
            const first = await this._captureRegion(region);
            frames.push(first);
            stitchHeight = first.get_height();
            lastFrame = first;

            // Move pointer over the region so synthesized scrolls land there
            this._movePointerTo(region.x + region.width / 2, region.y + region.height / 2);

            for (let i = 1; i < opts.maxFrames; i++) {
                if (GLib.get_monotonic_time() - tStart > opts.totalTimeoutMs * 1000) break;

                this._sendScrollDown(opts.scrollAmount);
                await this._sleepMs(opts.scrollSettleMs);

                const next = await this._captureRegion(region);
                const cmp = findVerticalOverlap(lastFrame, next, opts);

                if (cmp.endOfContent) {
                    endDetected = true;
                    break;
                }

                const newRows = next.get_height() - cmp.overlap;
                if (newRows <= 0) {
                    // No vertical advance — app didn't scroll. One retry, then bail.
                    if (i > 1 && (next.get_height() - cmp.overlap) <= 0) {
                        endDetected = true;
                        break;
                    }
                    continue;
                }

                frames.push({ pixbuf: next, skipRows: cmp.overlap });
                stitchHeight += newRows;
                lastFrame = next;
            }

            const out = stitchFrames(frames, stitchHeight);
            const path = this._buildOutputPath();
            saveAsPng(out, path);
            progressNotif?.destroy();
            this._notifyDone(path, frames.length, endDetected);
        } finally {
            this._busy = false;
        }
    }

    // -------------------------------------------------------------------------
    // Screenshot
    // -------------------------------------------------------------------------

    async _captureRegion({ x, y, width, height }) {
        // Shell.Screenshot.screenshot_area writes a PNG into a GIO output stream.
        // We then read that stream back into a GdkPixbuf for pixel access.
        const stream = Gio.MemoryOutputStream.new_resizable();
        const shooter = new Shell.Screenshot();
        await new Promise((resolve, reject) => {
            shooter.screenshot_area(
                Math.round(x), Math.round(y), Math.round(width), Math.round(height),
                false /* include cursor */,
                stream,
                (_self, res) => {
                    try {
                        shooter.screenshot_area_finish(res);
                        resolve();
                    } catch (e) { reject(e); }
                },
            );
        });
        const bytes = stream.steal_as_bytes();
        const istream = Gio.MemoryInputStream.new_from_bytes(bytes);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(istream, null);
        try { istream.close(null); } catch {}
        return pixbuf;
    }

    // -------------------------------------------------------------------------
    // Synthetic input
    // -------------------------------------------------------------------------

    _virtualPointer() {
        if (this._virtualDevice) return this._virtualDevice;
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        return this._virtualDevice;
    }

    _movePointerTo(x, y) {
        // Absolute motion so the scrolls land on the right window regardless
        // of where the user left the cursor.
        try {
            this._virtualPointer().notify_absolute_motion(
                Clutter.get_current_event_time(),
                x, y,
            );
        } catch (e) {
            console.log(`[Big Shot Scroll] pointer move failed: ${e.message}`);
        }
    }

    _sendScrollDown(amount) {
        const vdev = this._virtualPointer();
        const t = Clutter.get_current_event_time();
        for (let i = 0; i < amount; i++) {
            try {
                vdev.notify_discrete_scroll(
                    t,
                    Clutter.ScrollDirection.DOWN,
                    Clutter.ScrollFinishFlags.NONE,
                );
            } catch (e) {
                // Fallback: some Mutter versions name it notify_scroll_discrete
                try {
                    vdev.notify_scroll_discrete(
                        t,
                        Clutter.ScrollDirection.DOWN,
                        Clutter.ScrollFinishFlags.NONE,
                    );
                } catch (e2) {
                    console.error(`[Big Shot Scroll] scroll failed: ${e2.message}`);
                    return;
                }
            }
        }
    }

    _sleepMs(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // -------------------------------------------------------------------------
    // Output + notifications
    // -------------------------------------------------------------------------

    _buildOutputPath() {
        const dir = GLib.build_filenamev([GLib.get_home_dir(), 'Imagens', 'BigShot']);
        GLib.mkdir_with_parents(dir, 0o755);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        return GLib.build_filenamev([dir, `scroll-${ts}.png`]);
    }

    _ensureSource() {
        if (this._source && !this._source._destroyed) return this._source;
        this._source = new MessageTray.Source({
            title: 'Big Shot',
            iconName: 'camera-photo-symbolic',
        });
        this._source.connect('destroy', () => { this._source = null; });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _notify(title, body, { transient = true } = {}) {
        const source = this._ensureSource();
        const notif = new MessageTray.Notification({
            source, title, body, isTransient: transient,
        });
        source.addNotification(notif);
        return notif;
    }

    _notifyDone(path, framesCount, endDetected) {
        const source = this._ensureSource();
        const body = endDetected
            ? _('Stitched %d frames (alcançou fim do conteúdo).').format(framesCount)
            : _('Stitched %d frames (limite de segurança atingido).').format(framesCount);
        const notif = new MessageTray.Notification({
            source,
            title: _('Captura rolante pronta'),
            body,
            isTransient: false,
        });
        notif.addAction(_('Abrir'), () => {
            try {
                Gio.AppInfo.launch_default_for_uri(
                    Gio.File.new_for_path(path).get_uri(), null);
            } catch {}
        });
        notif.addAction(_('Copiar caminho'), () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, path);
        });
        source.addNotification(notif);
    }

    destroy() {
        if (this._keybindingRegistered) {
            try { Main.wm.removeKeybinding(KEYBINDING_NAME); } catch {}
            this._keybindingRegistered = false;
        }
        if (this._source) {
            try { this._source.destroy(); } catch {}
            this._source = null;
        }
        this._virtualDevice = null;
        super.destroy();
    }
}

// =============================================================================
// Pure functions — overlap detection and stitching (testable in isolation)
// =============================================================================

/**
 * Find the vertical overlap between the bottom of `prev` and the top of `curr`.
 * Returns { overlap: rows, endOfContent: bool, similarity: 0..1 }.
 *
 * Algorithm: for each candidate offset k in [minOverlapRows..searchRows],
 * compute mean absolute difference between prev[H-k .. H] and curr[0 .. k].
 * Pick the k with lowest MAD. Compute similarity = 1 - MAD/255.
 *
 * If similarity >= endOfContentMatch AND overlap covers the whole curr height
 * (or nearly), declare end-of-content.
 *
 * This is O(searchRows × width × 4) bytes per row × searchRows = manageable
 * for typical regions (1920×N) on a modern CPU in well under a frame.
 */
export function findVerticalOverlap(prev, curr, opts = DEFAULTS) {
    const W = curr.get_width();
    const H = curr.get_height();
    if (prev.get_width() !== W || prev.get_height() !== H) {
        return { overlap: 0, endOfContent: false, similarity: 0 };
    }

    const prevBytes = prev.get_pixels(); // Uint8Array, RGBA or RGB
    const currBytes = curr.get_pixels();
    const prevRowstride = prev.get_rowstride();
    const currRowstride = curr.get_rowstride();
    const nChan = prev.get_n_channels();
    const compareBytesPerRow = W * nChan;

    // Quick equality check — pixel-identical full frames means end-of-content.
    if (prevRowstride === currRowstride && prevBytes.length === currBytes.length) {
        let equal = true;
        for (let i = 0; i < prevBytes.length; i++) {
            if (prevBytes[i] !== currBytes[i]) { equal = false; break; }
        }
        if (equal) return { overlap: H, endOfContent: true, similarity: 1 };
    }

    const maxSearch = Math.min(opts.overlapSearchRows, H);
    let bestK = 0;
    let bestMad = Infinity;
    for (let k = opts.minOverlapRows; k <= maxSearch; k++) {
        let sum = 0;
        // Compare last k rows of prev with first k rows of curr.
        for (let r = 0; r < k; r++) {
            const prevRow = (H - k + r) * prevRowstride;
            const currRow = r * currRowstride;
            // Sample every 4th pixel for speed (still robust enough)
            for (let c = 0; c < compareBytesPerRow; c += nChan * 4) {
                sum += Math.abs(prevBytes[prevRow + c] - currBytes[currRow + c]);
                sum += Math.abs(prevBytes[prevRow + c + 1] - currBytes[currRow + c + 1]);
                sum += Math.abs(prevBytes[prevRow + c + 2] - currBytes[currRow + c + 2]);
            }
        }
        const samplesPerRow = Math.ceil(W / 4) * 3;
        const mad = sum / (k * samplesPerRow);
        if (mad < bestMad) {
            bestMad = mad;
            bestK = k;
        }
    }
    const similarity = 1 - bestMad / 255;
    // If the best overlap is large AND highly similar, treat as end-of-content.
    const endOfContent = similarity >= opts.endOfContentMatch && bestK >= H - 2;
    return { overlap: bestK, endOfContent, similarity };
}

/**
 * Concatenate frames vertically. `frames[0]` is the full first frame;
 * subsequent entries are { pixbuf, skipRows } meaning "append pixbuf rows
 * [skipRows..end] to the canvas".
 */
export function stitchFrames(frames, totalHeight) {
    if (frames.length === 0) throw new Error('no frames to stitch');
    const first = frames[0].get_width ? frames[0] : frames[0].pixbuf;
    const W = first.get_width();
    const hasAlpha = first.get_has_alpha();
    const bitsPerSample = first.get_bits_per_sample();
    const colorspace = first.get_colorspace();

    const canvas = GdkPixbuf.Pixbuf.new(colorspace, hasAlpha, bitsPerSample, W, totalHeight);
    canvas.fill(0x00000000);

    let destY = 0;
    // First frame: full
    first.copy_area(0, 0, W, first.get_height(), canvas, 0, destY);
    destY += first.get_height();

    for (let i = 1; i < frames.length; i++) {
        const { pixbuf, skipRows } = frames[i];
        const srcY = skipRows;
        const rows = pixbuf.get_height() - skipRows;
        if (rows <= 0) continue;
        pixbuf.copy_area(0, srcY, W, rows, canvas, 0, destY);
        destY += rows;
    }
    return canvas;
}

function saveAsPng(pixbuf, path) {
    pixbuf.savev(path, 'png', [], []);
}
