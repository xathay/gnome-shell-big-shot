/**
 * Big Shot — Audio recording (Desktop + Mic)
 *
 * Adds toggle buttons for desktop audio and microphone capture.
 * Uses PulseAudio via Gvc.MixerControl to detect audio devices.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gvc from 'gi://Gvc';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartUI } from './partbase.js';

// =============================================================================
// IconLabelButton — Toggle button with icon and label
// =============================================================================

class IconLabelButton {
    constructor(iconName, label, accessible) {
        this.active = false;

        this._box = new St.BoxLayout({
            vertical: false,
            style: 'spacing: 6px;',
        });

        this._icon = new St.Icon({
            icon_name: iconName,
            icon_size: 16,
        });

        this._label = new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._icon);
        this._box.add_child(this._label);

        this.button = new St.Button({
            style_class: 'screenshot-ui-type-button',
            toggle_mode: true,
            can_focus: true,
            child: this._box,
            accessible_name: accessible || label,
        });

        this.button.connect('notify::checked', () => {
            this.active = this.button.checked;
        });
    }

    setTooltip(text) {
        this.button.set_accessible_name(text);
    }

    destroy() {
        this.button?.destroy();
    }
}

// =============================================================================
// PartAudio — Desktop + Mic audio capture
// =============================================================================

export class PartAudio extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._desktopDevice = null;
        this._micDevice = null;

        // Initialize audio mixer
        this._mixer = new Gvc.MixerControl({ name: 'Big Shot Audio' });
        this._mixer.open();

        // Wait for mixer to be ready
        this._mixerReadyId = this._mixer.connect('state-changed', () => {
            if (this._mixer.get_state() === Gvc.MixerControlState.READY) {
                this._onMixerReady();
            }
        });

        // Create UI buttons
        this._createButtons();
    }

    _createButtons() {
        // Desktop audio button
        this._desktopBtn = new IconLabelButton(
            'audio-speakers-symbolic',
            _('Desktop Audio'),
            _('Record Desktop Audio')
        );

        // Mic button
        this._micBtn = new IconLabelButton(
            'audio-input-microphone-symbolic',
            _('Microphone'),
            _('Record Microphone')
        );

        // Add buttons to the native type button container (same as Selection/Screen/Window)
        const typeContainer = this._ui._typeButtonContainer;
        if (typeContainer) {
            typeContainer.add_child(this._desktopBtn.button);
            typeContainer.add_child(this._micBtn.button);
        }

        // Only visible in cast mode
        this._desktopBtn.button.visible = false;
        this._micBtn.button.visible = false;
    }

    _disconnectMixer() {
        if (this._mixerReadyId) {
            this._mixer?.disconnect(this._mixerReadyId);
            this._mixerReadyId = null;
        }
    }

    _onMixerReady() {
        this._disconnectMixer();
        this._updateDevices();
    }

    _updateDevices() {
        // Get default output (desktop audio)
        const defaultSink = this._mixer.get_default_sink();
        if (defaultSink) {
            this._desktopDevice = defaultSink.get_name() + '.monitor';
            const desc = defaultSink.get_description() || _('Desktop');
            this._desktopBtn.setTooltip(
                _('Record Desktop Audio') + '\n' + desc
            );
        }

        // Get default input (microphone)
        const defaultSource = this._mixer.get_default_source();
        if (defaultSource) {
            this._micDevice = defaultSource.get_name();
            const desc = defaultSource.get_description() || _('Mic');
            this._micBtn.setTooltip(
                _('Record Microphone') + '\n' + desc
            );
        }
    }

    /**
     * Build the GStreamer audio input pipeline string
     * Returns null if no audio selected
     */
    makeAudioInput() {
        this._updateDevices();

        const desktopActive = this._desktopBtn.active && this._desktopDevice;
        const micActive = this._micBtn.active && this._micDevice;

        if (!desktopActive && !micActive) return null;

        const audioCaps = 'audio/x-raw,channels=2,rate=48000';
        // Escape device names to prevent pipeline injection
        const dDev = desktopActive ? GLib.shell_quote(this._desktopDevice) : '';
        const mDev = micActive ? GLib.shell_quote(this._micDevice) : '';

        if (desktopActive && micActive) {
            return `audiomixer name=mix ! capsfilter caps=${audioCaps} ! audioconvert ! queue pulsesrc device=${dDev} ! capsfilter caps=${audioCaps} ! audioconvert ! queue ! mix. pulsesrc device=${mDev} ! capsfilter caps=${audioCaps} ! audioconvert ! queue ! mix.`;
        }

        if (desktopActive) {
            return `pulsesrc device=${dDev} ! capsfilter caps=${audioCaps} ! audioconvert ! queue`;
        }

        // micActive
        return `pulsesrc device=${mDev} ! capsfilter caps=${audioCaps} ! audioconvert ! queue`;
    }

    _onModeChanged(isCast) {
        this._desktopBtn.button.visible = isCast;
        this._micBtn.button.visible = isCast;
    }

    destroy() {
        if (this._desktopBtn?.button) {
            const parent = this._desktopBtn.button.get_parent();
            if (parent) parent.remove_child(this._desktopBtn.button);
            this._desktopBtn.destroy();
        }
        if (this._micBtn?.button) {
            const parent = this._micBtn.button.get_parent();
            if (parent) parent.remove_child(this._micBtn.button);
            this._micBtn.destroy();
        }
        this._disconnectMixer();
        this._mixer?.close();
        this._mixer = null;
        super.destroy();
    }
}
