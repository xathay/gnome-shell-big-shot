/**
 * Big Shot — Quick Stop for screencast
 *
 * If recording is in progress and user triggers screenshot (Ctrl+Alt+Shift+R),
 * stop the recording instead of opening the screenshot UI.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PartUI } from './partbase.js';

export class PartQuickStop extends PartUI {
    constructor(screenshotUI, extension) {
        super(screenshotUI, extension);

        // Monkey-patch the screenshot UI open method
        this._origOpen = this._ui.open?.bind(this._ui);
        if (this._origOpen) {
            const self = this;
            this._ui.open = function (...args) {
                return self._interceptOpen(...args);
            };
        }
    }

    _interceptOpen(...args) {
        // Check if we're in screencast mode and already recording
        const recorder = Main.screenshotUI?._recorder;
        if (recorder?.is_recording?.()) {
            // Stop the recording instead of opening UI
            try {
                recorder.close();
                Main.screenshotUI?.close();
            } catch (e) {
                console.error(`[Big Shot] Quick stop error: ${e.message}`);
            }
            return;
        }

        // Normal open
        return this._origOpen?.(...args);
    }

    destroy() {
        if (this._origOpen) {
            this._ui.open = this._origOpen;
            this._origOpen = null;
        }
        super.destroy();
    }
}
