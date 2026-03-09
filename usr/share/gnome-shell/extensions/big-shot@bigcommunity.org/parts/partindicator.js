/**
 * Big Shot — Panel indicator during recording
 *
 * Shows a spinner while pipeline is starting, then the recording timer.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import { PartUI } from './partbase.js';

export class PartIndicator extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        this._spinner = null;
        this._isReady = false;
    }

    /**
     * Called when the pipeline is being initialized
     * Shows a spinner in the panel indicator
     */
    onPipelineStarting() {
        this._isReady = false;

        // Find the screencast indicator in the panel
        const indicator = Main.panel.statusArea?.screenRecording;
        if (!indicator) return;

        const indicatorActor = indicator;
        if (!indicatorActor.add_child) return;

        // Replace the timer content with a spinner
        if (!this._spinner) {
            this._spinner = new Animation.Spinner(16, { animate: true });
        }

        if (indicatorActor.first_child) {
            this._originalChild = indicatorActor.first_child;
            this._originalChild.visible = false;
        }

        try {
            indicatorActor.add_child(this._spinner);
            this._spinner.play();
        } catch {
            // Indicator structure may differ between GNOME versions
        }
    }

    /**
     * Called when the pipeline is ready and recording has started
     * Removes spinner and shows the regular timer
     */
    onPipelineReady() {
        this._isReady = true;

        if (this._spinner) {
            this._spinner.stop();
            this._spinner.get_parent()?.remove_child(this._spinner);
        }

        if (this._originalChild) {
            this._originalChild.visible = true;
            this._originalChild = null;
        }
    }

    destroy() {
        this.onPipelineReady();
        this._spinner?.destroy();
        this._spinner = null;
        super.destroy();
    }
}
