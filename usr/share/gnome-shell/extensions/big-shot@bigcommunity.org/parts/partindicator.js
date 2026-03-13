/**
 * Big Shot — Panel indicator during recording
 *
 * Shows a spinner while pipeline is starting, then the recording timer.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { PartUI } from './partbase.js';

export class PartIndicator extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);
        this._isReady = false;
    }

    /**
     * Called when the pipeline is being initialized.
     * No-op: pipeline detection is fast, no visual indicator needed.
     * Previously showed a spinner that broke the native indicator layout.
     */
    onPipelineStarting() {
        this._isReady = false;
    }

    /**
     * Called when the pipeline is ready and recording has started.
     */
    onPipelineReady() {
        this._isReady = true;
    }

    destroy() {
        super.destroy();
    }
}
