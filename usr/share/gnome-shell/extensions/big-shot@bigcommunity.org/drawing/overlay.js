/**
 * Big Shot — Drawing Overlay
 *
 * A transparent Clutter.Actor overlay on top of the screenshot preview.
 * Handles mouse/touch input for drawing annotations using Cairo.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Cairo from 'gi://cairo';

import {
    DrawingMode,
    DrawingOptions,
    createAction,
} from './actions.js';

export class DrawingOverlay {
    constructor(screenshotUI, toolbar) {
        this._ui = screenshotUI;
        this._toolbar = toolbar;
        this._actions = [];
        this._undoStack = [];
        this._currentStroke = null;
        this._startPoint = null;
        this._isDrawing = false;
        this._nextNumber = 1;

        // Selection / move state
        this._selectedAction = null;
        this._isDragging = false;
        this._dragStart = null;

        this._buildOverlay();
    }

    _buildOverlay() {
        // Create a transparent canvas actor that covers the screenshot area
        this._canvas = new Clutter.Canvas();
        this._actor = new Clutter.Actor({
            reactive: true,
            x_expand: true,
            y_expand: true,
        });
        this._actor.set_content(this._canvas);

        // Connect canvas draw
        this._canvasDrawId = this._canvas.connect('draw', (canvas, cr, width, height) => {
            this._onDraw(cr, width, height);
        });

        // Connect input events
        this._pressId = this._actor.connect('button-press-event', (actor, event) => {
            return this._onButtonPress(event);
        });
        this._releaseId = this._actor.connect('button-release-event', (actor, event) => {
            return this._onButtonRelease(event);
        });
        this._motionId = this._actor.connect('motion-event', (actor, event) => {
            return this._onMotion(event);
        });

        // Key events for shortcuts
        this._keyId = this._actor.connect('key-press-event', (actor, event) => {
            return this._onKeyPress(event);
        });

        // Initially hidden
        this._actor.visible = false;

        // Add to screenshot UI
        if (this._ui) {
            this._ui.add_child(this._actor);
        }
    }

    show(width, height) {
        this._actor.set_size(width, height);
        this._canvas.set_size(width, height);
        this._actor.visible = true;
        this._canvas.invalidate();
    }

    hide() {
        this._actor.visible = false;
    }

    _getOptions() {
        const toolbar = this._toolbar;
        const mode = toolbar?.activeTool?.toUpperCase() || DrawingMode.PEN;
        const colorHex = toolbar?.currentColor || '#ed333b';
        const fillHex = toolbar?.fillColor;
        const size = toolbar?.brushSize || 3;

        let fillColor = null;
        if (mode === DrawingMode.NUMBER) {
            fillColor = this._hexToRGBA(colorHex);
        } else if (fillHex) {
            fillColor = this._hexToRGBA(fillHex);
        }

        return new DrawingOptions({
            mode,
            primaryColor: this._hexToRGBA(colorHex),
            size,
            fillColor,
        });
    }

    _hexToRGBA(hex) {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return [r, g, b, 1.0];
    }

    _toImageCoords(x, y) {
        // Convert widget coordinates to image coordinates
        // For now, 1:1 mapping (will be adjusted when crop/zoom is implemented)
        return [x, y];
    }

    _toWidgetCoords(x, y) {
        return [x, y];
    }

    // =========================================================================
    // INPUT HANDLERS
    // =========================================================================

    _onButtonPress(event) {
        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);

        // Selection mode: no tool active → select/move objects
        if (!this._toolbar?.activeTool) {
            // Try to find an action under the cursor (top-most first)
            let found = null;
            for (let i = this._actions.length - 1; i >= 0; i--) {
                if (this._actions[i].containsPoint(ix, iy)) {
                    found = this._actions[i];
                    break;
                }
            }

            this._selectedAction = found;
            if (found) {
                this._isDragging = true;
                this._dragStart = [ix, iy];
            }
            this._canvas.invalidate();
            return Clutter.EVENT_STOP;
        }

        // Drawing mode
        const mode = this._toolbar.activeTool.toUpperCase();
        this._isDrawing = true;
        this._startPoint = [ix, iy];

        if (mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) {
            this._currentStroke = [[ix, iy]];
        }

        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);

        // Drag mode — moving selected action
        if (this._isDragging && this._selectedAction && this._dragStart) {
            const dx = ix - this._dragStart[0];
            const dy = iy - this._dragStart[1];
            this._selectedAction.translate(dx, dy);
            this._dragStart = [ix, iy];
            this._canvas.invalidate();
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_PROPAGATE;

        const mode = this._toolbar.activeTool?.toUpperCase();

        if ((mode === DrawingMode.PEN || mode === DrawingMode.HIGHLIGHTER) && this._currentStroke) {
            this._currentStroke.push([ix, iy]);
            this._canvas.invalidate();
        }

        return Clutter.EVENT_STOP;
    }

    _onButtonRelease(event) {
        // End drag
        if (this._isDragging) {
            this._isDragging = false;
            this._dragStart = null;
            return Clutter.EVENT_STOP;
        }

        if (!this._isDrawing) return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const [ix, iy] = this._toImageCoords(x, y);
        const mode = this._toolbar.activeTool?.toUpperCase();
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const options = this._getOptions();

        let action = null;

        switch (mode) {
            case DrawingMode.PEN:
                if (this._currentStroke?.length > 1) {
                    action = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
                }
                break;
            case DrawingMode.HIGHLIGHTER:
                if (this._currentStroke?.length > 1) {
                    action = createAction(DrawingMode.HIGHLIGHTER, {
                        stroke: this._currentStroke, shift
                    }, options);
                }
                break;
            case DrawingMode.ARROW:
                action = createAction(DrawingMode.ARROW, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.LINE:
                action = createAction(DrawingMode.LINE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.RECT:
                action = createAction(DrawingMode.RECT, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CIRCLE:
                action = createAction(DrawingMode.CIRCLE, {
                    start: this._startPoint, end: [ix, iy], shift
                }, options);
                break;
            case DrawingMode.CENSOR:
                action = createAction(DrawingMode.CENSOR, {
                    start: this._startPoint, end: [ix, iy]
                }, options);
                break;
            case DrawingMode.TEXT:
                // Show text entry popover instead of hardcoded text
                this._showTextPopover(this._startPoint, options);
                this._isDrawing = false;
                this._currentStroke = null;
                this._startPoint = null;
                return Clutter.EVENT_STOP;
            case DrawingMode.NUMBER:
                action = createAction(DrawingMode.NUMBER, {
                    position: this._startPoint,
                    number: this._nextNumber++,
                }, options);
                break;
        }

        if (action) {
            this._actions.push(action);
            this._undoStack = []; // Clear redo stack on new action
        }

        this._isDrawing = false;
        this._currentStroke = null;
        this._startPoint = null;
        this._canvas.invalidate();

        return Clutter.EVENT_STOP;
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;

        // Ctrl+Z = Undo
        if (ctrl && !shift && key === Clutter.KEY_z) {
            this.undo();
            return Clutter.EVENT_STOP;
        }

        // Ctrl+Shift+Z or Ctrl+Y = Redo
        if ((ctrl && shift && key === Clutter.KEY_z) || (ctrl && key === Clutter.KEY_y)) {
            this.redo();
            return Clutter.EVENT_STOP;
        }

        // Delete = remove last action (or selected action)
        if (key === Clutter.KEY_Delete || key === Clutter.KEY_BackSpace) {
            if (this._selectedAction) {
                const idx = this._actions.indexOf(this._selectedAction);
                if (idx >= 0) {
                    this._undoStack.push(this._actions.splice(idx, 1)[0]);
                    this._selectedAction = null;
                    this._canvas.invalidate();
                }
            } else if (this._actions.length > 0) {
                this._undoStack.push(this._actions.pop());
                this._canvas.invalidate();
            }
            return Clutter.EVENT_STOP;
        }

        // Keyboard tool shortcuts: 1-9 → tools, 0 or S → select mode
        const TOOL_KEYS = {
            [Clutter.KEY_1]: 'pen',
            [Clutter.KEY_2]: 'arrow',
            [Clutter.KEY_3]: 'line',
            [Clutter.KEY_4]: 'rect',
            [Clutter.KEY_5]: 'circle',
            [Clutter.KEY_6]: 'text',
            [Clutter.KEY_7]: 'highlight',
            [Clutter.KEY_8]: 'censor',
            [Clutter.KEY_9]: 'number',
        };

        if (!ctrl && !shift && TOOL_KEYS[key]) {
            this._toolbar?.selectTool(TOOL_KEYS[key]);
            return Clutter.EVENT_STOP;
        }

        // 0 or S → selection mode
        if (!ctrl && !shift && (key === Clutter.KEY_0 || key === Clutter.KEY_s)) {
            this._toolbar?.selectTool(null); // Deselect all → enter select mode
            return Clutter.EVENT_STOP;
        }

        // Escape → deselect current selection
        if (key === Clutter.KEY_Escape) {
            if (this._selectedAction) {
                this._selectedAction = null;
                this._canvas.invalidate();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // =========================================================================
    // TEXT POPOVER
    // =========================================================================

    _showTextPopover(position, options) {
        this._closeTextPopover();

        const [wx, wy] = this._toWidgetCoords(position[0], position[1]);

        this._textPopover = new St.BoxLayout({
            style: 'background: rgba(30,30,30,0.95); border-radius: 8px; padding: 8px; ' +
                   'border: 1px solid rgba(255,255,255,0.15);',
            vertical: false,
            reactive: true,
        });

        this._textEntry = new St.Entry({
            hint_text: 'Text…',
            style: 'width: 200px; min-height: 28px; font-size: 14px;',
            can_focus: true,
        });

        const confirmBtn = new St.Button({
            style_class: 'screenshot-ui-show-pointer-button',
            child: new St.Icon({ icon_name: 'object-select-symbolic', icon_size: 16 }),
            can_focus: true,
        });

        const confirmAction = () => {
            const text = this._textEntry.get_text().trim();
            if (text) {
                const action = createAction(DrawingMode.TEXT, {
                    position,
                    text,
                    fontSize: options.size * 5,
                }, options);
                if (action) {
                    this._actions.push(action);
                    this._undoStack = [];
                    this._canvas.invalidate();
                }
            }
            this._closeTextPopover();
        };

        confirmBtn.connect('clicked', confirmAction);
        this._textEntry.clutter_text.connect('activate', confirmAction);

        // Escape closes without adding
        this._textEntry.clutter_text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeTextPopover();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._textPopover.add_child(this._textEntry);
        this._textPopover.add_child(confirmBtn);

        this._ui.add_child(this._textPopover);
        this._textPopover.set_position(
            Math.max(0, wx - 100),
            Math.max(0, wy - 44)
        );

        // Focus the entry after a frame
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._textEntry?.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeTextPopover() {
        this._textPopover?.destroy();
        this._textPopover = null;
        this._textEntry = null;
    }

    // =========================================================================
    // UNDO / REDO
    // =========================================================================

    undo() {
        if (this._actions.length === 0) return;
        this._undoStack.push(this._actions.pop());
        this._canvas.invalidate();
    }

    redo() {
        if (this._undoStack.length === 0) return;
        this._actions.push(this._undoStack.pop());
        this._canvas.invalidate();
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    _onDraw(cr, width, height) {
        // Clear
        cr.save();
        cr.setOperator(0); // CLEAR
        cr.paint();
        cr.restore();

        const scale = 1.0; // Will be dynamic with zoom
        const toWidget = (x, y) => this._toWidgetCoords(x, y);

        // Draw all committed actions
        for (const action of this._actions) {
            cr.save();
            action.draw(cr, toWidget, scale);
            cr.restore();
        }

        // Draw current in-progress stroke
        if (this._isDrawing && this._currentStroke && this._currentStroke.length > 1) {
            const options = this._getOptions();
            const mode = this._toolbar.activeTool?.toUpperCase();
            let tempAction;

            if (mode === DrawingMode.PEN) {
                tempAction = createAction(DrawingMode.PEN, { stroke: this._currentStroke }, options);
            } else if (mode === DrawingMode.HIGHLIGHTER) {
                tempAction = createAction(DrawingMode.HIGHLIGHTER, {
                    stroke: this._currentStroke, shift: false
                }, options);
            }

            if (tempAction) {
                cr.save();
                tempAction.draw(cr, toWidget, scale);
                cr.restore();
            }
        }

        // Draw selection bounding box
        if (this._selectedAction) {
            const [minX, minY, maxX, maxY] = this._selectedAction.getBounds();
            const [wx1, wy1] = toWidget(minX, minY);
            const [wx2, wy2] = toWidget(maxX, maxY);
            const pad = 4;

            cr.save();
            cr.setSourceRGBA(0.384, 0.627, 0.917, 0.9); // #62a0ea
            cr.setLineWidth(1.5);
            cr.setDash([4, 4], 0);
            cr.rectangle(wx1 - pad, wy1 - pad, wx2 - wx1 + 2 * pad, wy2 - wy1 + 2 * pad);
            cr.stroke();

            // Small handles at corners
            const handleSize = 5;
            cr.setDash([], 0);
            for (const [hx, hy] of [[wx1 - pad, wy1 - pad], [wx2 + pad, wy1 - pad],
                                     [wx1 - pad, wy2 + pad], [wx2 + pad, wy2 + pad]]) {
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.fill();
                cr.setSourceRGBA(0.384, 0.627, 0.917, 1);
                cr.rectangle(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
                cr.stroke();
            }
            cr.restore();
        }

        return true;
    }

    // =========================================================================
    // CLEANUP
    // =========================================================================

    clear() {
        this._actions = [];
        this._undoStack = [];
        this._nextNumber = 1;
        this._canvas.invalidate();
    }

    destroy() {
        this._closeTextPopover();
        if (this._canvasDrawId) {
            this._canvas.disconnect(this._canvasDrawId);
        }
        if (this._pressId) this._actor.disconnect(this._pressId);
        if (this._releaseId) this._actor.disconnect(this._releaseId);
        if (this._motionId) this._actor.disconnect(this._motionId);
        if (this._keyId) this._actor.disconnect(this._keyId);

        this._actor?.destroy();
        this._actor = null;
        this._canvas = null;
    }
}
