/**
 * Big Shot — Main contextual toolbar
 *
 * Appears above the screenshot UI controls.
 * Switches between Screenshot tools (annotation) and Screencast tools (audio/fps/resolution).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';
import { PALETTE } from '../drawing/colors.js';

// Drawing modes mapped to icon names and labels
const SCREENSHOT_TOOLS = [
    { id: 'pen',       icon: 'big-shot-pen-symbolic',       label: () => _('Pen'),        key: '1' },
    { id: 'arrow',     icon: 'big-shot-arrow-symbolic',     label: () => _('Arrow'),      key: '2' },
    { id: 'line',      icon: 'big-shot-line-symbolic',      label: () => _('Line'),       key: '3' },
    { id: 'rect',      icon: 'big-shot-rect-symbolic',      label: () => _('Rectangle'),  key: '4' },
    { id: 'circle',    icon: 'big-shot-circle-symbolic',    label: () => _('Oval'),       key: '5' },
    { id: 'text',      icon: 'big-shot-text-symbolic',      label: () => _('Text'),       key: '6' },
    { id: 'highlight', icon: 'big-shot-highlight-symbolic', label: () => _('Highlighter'), key: '7' },
    { id: 'censor',    icon: 'big-shot-censor-symbolic',    label: () => _('Censor'),     key: '8' },
    { id: 'number',    icon: 'big-shot-number-symbolic',    label: () => _('Number'),     key: '9' },
];

const BEAUTIFY_TOOLS = [
    { id: 'gradient', icon: 'big-shot-gradient-symbolic', label: () => _('Background') },
    { id: 'crop',     icon: 'big-shot-crop-symbolic',     label: () => _('Crop') },
    { id: 'padding',  icon: 'big-shot-padding-symbolic',  label: () => _('Padding') },
];

export class PartToolbar extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._activeTool = null;
        this._toolButtons = new Map();

        this._buildToolbar();
    }

    _buildToolbar() {
        // Main container — uses the native GNOME screenshot type button container
        // style to integrate seamlessly with the bottom area controls
        this._container = new St.BoxLayout({
            style_class: 'screenshot-ui-type-button-container',
            vertical: false,
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Annotation tools — use native screenshot-ui-type-button style
        for (const tool of SCREENSHOT_TOOLS) {
            const btn = this._createToolButton(tool);
            this._container.add_child(btn);
            this._toolButtons.set(tool.id, btn);
        }

        // Separator between drawing tools and beautify tools
        const sep1 = new St.Widget({
            style: 'width: 1px; min-height: 20px; background: rgba(255,255,255,0.15); margin: 4px 2px;',
        });
        this._container.add_child(sep1);

        // Beautify tools (gradient, crop, padding)
        for (const tool of BEAUTIFY_TOOLS) {
            const btn = this._createToolButton(tool);
            this._container.add_child(btn);
            this._toolButtons.set(tool.id, btn);
        }

        // Separator between tools and style controls
        const sep2 = new St.Widget({
            style: 'width: 1px; min-height: 20px; background: rgba(255,255,255,0.15); margin: 4px 2px;',
        });
        this._container.add_child(sep2);

        // Style controls: color, fill, size
        this._currentColorHex = '#ed333b';
        this._fillColorHex = null;

        this._colorButton = new St.Button({
            style_class: 'screenshot-ui-type-button',
            style: 'padding: 8px;',
            can_focus: true,
            accessible_name: _('Stroke Color'),
            child: new St.Widget({
                style: `background: #ed333b; border-radius: 50%; width: 18px; height: 18px;`,
            }),
        });
        this._colorButton.connect('clicked', () => this._showColorPopup('stroke'));
        this._container.add_child(this._colorButton);

        this._fillButton = new St.Button({
            style_class: 'screenshot-ui-type-button',
            style: 'padding: 8px;',
            can_focus: true,
            accessible_name: _('Fill Color'),
            child: new St.Widget({
                style: 'background: transparent; border: 2px dashed rgba(255,255,255,0.5); ' +
                       'border-radius: 50%; width: 18px; height: 18px;',
            }),
        });
        this._fillButton.connect('clicked', () => this._showColorPopup('fill'));
        this._container.add_child(this._fillButton);

        this._sizeButton = new St.Button({
            style_class: 'screenshot-ui-type-button',
            child: new St.Label({ text: '3', y_align: Clutter.ActorAlign.CENTER }),
            can_focus: true,
            accessible_name: _('Brush Size'),
        });
        this._sizeButton.connect('clicked', () => this._cycleBrushSize());
        this._container.add_child(this._sizeButton);

        // Separator before undo/redo
        const sep3 = new St.Widget({
            style: 'width: 1px; min-height: 20px; background: rgba(255,255,255,0.15); margin: 4px 2px;',
        });
        this._container.add_child(sep3);

        // Undo/Redo
        this._undoButton = new St.Button({
            style_class: 'screenshot-ui-type-button',
            child: new St.Icon({ icon_name: 'edit-undo-symbolic', icon_size: 16 }),
            can_focus: true,
            accessible_name: _('Undo'),
        });
        this._undoButton.connect('clicked', () => this._onUndo());
        this._container.add_child(this._undoButton);

        this._redoButton = new St.Button({
            style_class: 'screenshot-ui-type-button',
            child: new St.Icon({ icon_name: 'edit-redo-symbolic', icon_size: 16 }),
            can_focus: true,
            accessible_name: _('Redo'),
        });
        this._redoButton.connect('clicked', () => this._onRedo());
        this._container.add_child(this._redoButton);

        // Insert into the native GNOME bottom area group (above type buttons)
        const bottomGroup = this._ui._bottomAreaGroup ?? this._ui._content;
        if (bottomGroup) {
            bottomGroup.insert_child_at_index(this._container, 0);
        } else {
            // Fallback: add directly to the screenshot UI
            this._ui.add_child(this._container);
        }

        // Initially hidden — shown when screenshot mode is active
        this._container.visible = false;

        // Listen for UI open/close
        this._connectSignal(this._ui, 'notify::visible', () => {
            this._onUIVisibilityChanged();
        });
    }

    _createToolButton(tool) {
        const btn = new St.Button({
            style_class: 'screenshot-ui-type-button',
            toggle_mode: true,
            can_focus: true,
            child: new St.Icon({
                icon_name: tool.icon,
                icon_size: 16,
            }),
        });

        btn._toolId = tool.id;
        btn.set_accessible_name(tool.label());

        btn.connect('clicked', () => this._onToolClicked(tool.id, btn));

        return btn;
    }

    _onToolClicked(toolId, btn) {
        // Toggle off other tools
        for (const [id, otherBtn] of this._toolButtons) {
            if (id !== toolId) {
                otherBtn.checked = false;
            }
        }

        if (btn.checked) {
            this._activeTool = toolId;
        } else {
            this._activeTool = null;
        }

        // Notify listeners (annotation overlay, beautify tools)
        this._onToolChanged(this._activeTool);
    }

    _onToolChanged(toolId) {
        // Can be connected externally via callback
        this._toolChangedCallback?.(toolId);
    }

    /**
     * Set an external callback for tool changes.
     */
    onToolChanged(callback) {
        this._toolChangedCallback = callback;
    }

    /**
     * Programmatically select a tool by id (used by keyboard shortcuts).
     * Pass null to deselect all → enters selection/move mode.
     */
    selectTool(toolId) {
        if (toolId === null) {
            // Deselect all
            for (const [, btn] of this._toolButtons)
                btn.checked = false;
            this._activeTool = null;
            this._onToolChanged(null);
            return;
        }

        const btn = this._toolButtons.get(toolId);
        if (!btn) return;

        // Deselect others
        for (const [id, otherBtn] of this._toolButtons) {
            otherBtn.checked = (id === toolId);
        }
        this._activeTool = toolId;
        this._onToolChanged(toolId);
    }

    get activeTool() {
        return this._activeTool;
    }

    _cycleBrushSize() {
        const sizes = [1, 2, 3, 5, 8, 12];
        const current = parseInt(this._sizeButton.child.text) || 3;
        const idx = sizes.indexOf(current);
        const next = sizes[(idx + 1) % sizes.length];
        this._sizeButton.child.text = String(next);
    }

    get brushSize() {
        return parseInt(this._sizeButton.child.text) || 3;
    }

    _showColorPopup(target) {
        // Remove existing popup
        this._closeColorPopup();

        this._colorPopup = new St.BoxLayout({
            style_class: 'big-shot-color-popup',
            style: 'background: rgba(30,30,30,0.95); border-radius: 8px; padding: 8px; ' +
                   'border: 1px solid rgba(255,255,255,0.15);',
            vertical: true,
            reactive: true,
        });

        // Grid: 2 rows x 6 cols
        for (let row = 0; row < 2; row++) {
            const rowBox = new St.BoxLayout({ vertical: false });
            for (let col = 0; col < 6; col++) {
                const color = PALETTE[row * 6 + col];
                const swatch = new St.Button({
                    style: `background: ${color}; width: 24px; height: 24px; ` +
                           'border-radius: 4px; margin: 2px;',
                    reactive: true,
                    can_focus: true,
                    accessible_name: color,
                });
                swatch.connect('clicked', () => {
                    this._applyColor(target, color);
                    this._closeColorPopup();
                });
                rowBox.add_child(swatch);
            }
            this._colorPopup.add_child(rowBox);
        }

        // "No fill" button for fill target
        if (target === 'fill') {
            const noFillBtn = new St.Button({
                style_class: 'screenshot-ui-show-pointer-button',
                label: _('No Fill'),
                can_focus: true,
                style: 'margin-top: 4px; font-size: 11px;',
            });
            noFillBtn.connect('clicked', () => {
                this._applyColor('fill', null);
                this._closeColorPopup();
            });
            this._colorPopup.add_child(noFillBtn);
        }

        // Position popup above the color button
        const anchor = target === 'fill' ? this._fillButton : this._colorButton;
        this._ui.add_child(this._colorPopup);

        // Position near the button, clamped to screen bounds
        const [bx, by] = anchor.get_transformed_position();
        const monitor = global.display.get_current_monitor();
        const monitorGeo = global.display.get_monitor_geometry(monitor);
        let px = bx - 40;
        let py = by - this._colorPopup.height - 8;
        px = Math.max(monitorGeo.x, Math.min(px, monitorGeo.x + monitorGeo.width - this._colorPopup.width));
        py = Math.max(monitorGeo.y, py);
        this._colorPopup.set_position(px, py);

        // Close on click outside (after slight delay to avoid immediate close)
        this._popupTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._popupTimeoutId = 0;
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._colorPopupClickId = global.stage.connect('button-press-event', () => {
                this._closeColorPopup();
                return Clutter.EVENT_PROPAGATE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyColor(target, color) {
        if (target === 'stroke') {
            this._currentColorHex = color;
            this._colorButton.child.set_style(
                `background: ${color}; border-radius: 50%; width: 18px; height: 18px;`
            );
        } else {
            this._fillColorHex = color;
            if (color) {
                this._fillButton.child.set_style(
                    `background: ${color}; border-radius: 50%; width: 18px; height: 18px;`
                );
            } else {
                this._fillButton.child.set_style(
                    'background: transparent; border: 2px dashed rgba(255,255,255,0.5); ' +
                    'border-radius: 50%; width: 18px; height: 18px;'
                );
            }
        }
    }

    _closeColorPopup() {
        if (this._popupTimeoutId) {
            GLib.source_remove(this._popupTimeoutId);
            this._popupTimeoutId = 0;
        }
        if (this._colorPopupClickId) {
            global.stage.disconnect(this._colorPopupClickId);
            this._colorPopupClickId = null;
        }
        this._colorPopup?.destroy();
        this._colorPopup = null;
    }

    get currentColor() {
        return this._currentColorHex || '#ed333b';
    }

    get fillColor() {
        return this._fillColorHex;
    }

    _onUndo() {
        // Will be connected to drawing overlay
    }

    _onRedo() {
        // Will be connected to drawing overlay
    }

    _onUIVisibilityChanged() {
        if (this._ui.visible) {
            // Show toolbar only in screenshot mode (not cast)
            if (!this._isCastMode) {
                this._animateIn();
            }
        } else {
            this._animateOut();
        }
    }

    _onModeChanged(isCast) {
        super._onModeChanged(isCast);
        if (isCast) {
            this._animateOut();
        } else if (this._ui.visible) {
            this._animateIn();
        }
    }

    _animateIn() {
        this._container.visible = true;
        this._container.opacity = 0;
        this._container.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _animateOut() {
        this._container.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._container.visible = false;
            },
        });
    }

    destroy() {
        this._closeColorPopup();
        if (this._container) {
            const parent = this._container.get_parent();
            if (parent)
                parent.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._toolButtons.clear();
        super.destroy();
    }
}
