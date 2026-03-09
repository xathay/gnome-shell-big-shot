/**
 * Big Shot — Enhanced Screenshot & Screencast for GNOME Shell
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Parts
import { PartToolbar } from './parts/parttoolbar.js';
import { PartAnnotation } from './parts/partannotation.js';
import { PartGradient } from './parts/partgradient.js';
import { PartCrop } from './parts/partcrop.js';
import { PartAudio } from './parts/partaudio.js';
import { PartFramerate } from './parts/partframerate.js';
import { PartDownsize } from './parts/partdownsize.js';
import { PartIndicator } from './parts/partindicator.js';
import { PartQuickStop } from './parts/partquickstop.js';

// =============================================================================
// GPU DETECTION (following big-video-converter pattern)
// =============================================================================

/** GPU vendor enum */
const GpuVendor = Object.freeze({
    NVIDIA: 'nvidia',
    AMD: 'amd',
    INTEL: 'intel',
    UNKNOWN: 'unknown',
});

/**
 * Detect GPU vendor using lspci output.
 * Returns an array of detected vendors in priority order.
 */
function detectGpuVendors() {
    try {
        const proc = Gio.Subprocess.new(
            ['lspci'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        const [, stdout] = proc.communicate_utf8(null, null);
        if (!stdout) return [GpuVendor.UNKNOWN];

        const vendors = [];
        const lines = stdout.toLowerCase();

        if (/(?:vga|display controller|3d).*nvidia/.test(lines))
            vendors.push(GpuVendor.NVIDIA);
        if (/(?:vga|display controller).*(?:\bamd\b|\bati\b)/.test(lines))
            vendors.push(GpuVendor.AMD);
        if (/(?:vga|display controller).*intel/.test(lines))
            vendors.push(GpuVendor.INTEL);

        return vendors.length > 0 ? vendors : [GpuVendor.UNKNOWN];
    } catch {
        return [GpuVendor.UNKNOWN];
    }
}

// =============================================================================
// GSTREAMER PIPELINE CONFIGURATIONS
// =============================================================================

/**
 * Pipeline configs grouped by GPU vendor.
 * Each config has:
 *   label    — Human-readable name
 *   src      — Input capsfilter (FRAMERATE_CAPS replaced at runtime)
 *   enc      — Encoder chain
 *   elements — Required GStreamer elements to check
 *   ext      — Output container extension (mp4/webm)
 *   vendors  — Array of GPU vendors this config works on
 *   lowpower — Optional, use low-power VAAPI mode
 */
const VIDEO_PIPELINES = [
    // ── NVIDIA (CUDA + NVENC) ──
    {
        id: 'nvidia-cuda-h264-nvenc',
        label: 'NVIDIA CUDA H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'capsfilter caps=video/x-raw(memory:CUDAMemory),framerate=FRAMERATE_CAPS ! cudaconvert ! cudadownload',
        enc: 'nvh264enc rc-mode=cbr-hq bitrate=40000 ! h264parse',
        elements: ['cudaupload', 'cudaconvert', 'cudadownload', 'nvh264enc'],
        ext: 'mp4',
    },
    {
        id: 'nvidia-gl-h264-nvenc',
        label: 'NVIDIA GL H.264',
        vendors: [GpuVendor.NVIDIA],
        src: 'capsfilter caps=video/x-raw(memory:GLMemory),framerate=FRAMERATE_CAPS ! gldownload',
        enc: 'nvh264enc rc-mode=cbr-hq bitrate=40000 ! h264parse',
        elements: ['gldownload', 'nvh264enc'],
        ext: 'mp4',
    },
    // ── AMD + Intel (VAAPI) ──
    {
        id: 'vaapi-h264-lp',
        label: 'VAAPI LP H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS',
        enc: 'vaapih264enc rate-control=cbr bitrate=40000 tune=high-compression ! h264parse',
        elements: ['vaapih264enc'],
        lowpower: true,
        ext: 'mp4',
    },
    {
        id: 'vaapi-h264',
        label: 'VAAPI H.264',
        vendors: [GpuVendor.AMD, GpuVendor.INTEL],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS',
        enc: 'vaapih264enc rate-control=cbr bitrate=40000 ! h264parse',
        elements: ['vaapih264enc'],
        ext: 'mp4',
    },
    // ── Software fallbacks (any GPU / no GPU) ──
    {
        id: 'sw-gl-h264-openh264',
        label: 'Software GL H.264',
        vendors: [],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS ! gldownload',
        enc: 'openh264enc complexity=high bitrate=40000000 multi-thread=4 ! h264parse',
        elements: ['gldownload', 'openh264enc'],
        ext: 'mp4',
    },
    {
        id: 'sw-memfd-h264-openh264',
        label: 'Software H.264',
        vendors: [],
        src: 'capsfilter caps=video/x-raw,framerate=FRAMERATE_CAPS',
        enc: 'openh264enc complexity=high bitrate=40000000 multi-thread=4 ! h264parse',
        elements: ['openh264enc'],
        ext: 'mp4',
    },
    {
        id: 'sw-gl-vp8',
        label: 'Software GL VP8',
        vendors: [],
        src: 'capsfilter caps=video/x-raw(memory:DMABuf),framerate=FRAMERATE_CAPS ! gldownload',
        enc: 'vp8enc min_quantizer=10 max_quantizer=50 cq_level=13 cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 ! queue',
        elements: ['gldownload', 'vp8enc'],
        ext: 'webm',
    },
    {
        id: 'sw-memfd-vp8',
        label: 'Software VP8',
        vendors: [],
        src: 'capsfilter caps=video/x-raw,framerate=FRAMERATE_CAPS',
        enc: 'vp8enc min_quantizer=10 max_quantizer=50 cq_level=13 cpu-used=5 threads=4 deadline=1 static-threshold=1000 buffer-size=20000 ! queue',
        elements: ['vp8enc'],
        ext: 'webm',
    },
];

const AUDIO_PIPELINE = {
    vorbis: 'vorbisenc ! queue',
    aac: 'fdkaacenc ! queue',
};

const MUXERS = {
    mp4: 'mp4mux fragment-duration=500 ! queue',
    webm: 'webmmux ! queue',
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a GStreamer element exists on the system
 */
function checkElement(name) {
    try {
        const proc = Gio.Subprocess.new(
            ['gst-inspect-1.0', '--exists', name],
            Gio.SubprocessFlags.NONE
        );
        proc.wait(null);
        return proc.get_successful();
    } catch {
        return false;
    }
}

/**
 * Check if all elements in a pipeline config are available
 */
function checkPipeline(config) {
    return config.elements.every(el => checkElement(el));
}

/**
 * Fix the file path extension after recording
 * GNOME creates files with .unknown extension, we rename to .mp4/.webm
 */
function fixFilePath(filePath, ext) {
    if (!filePath || !ext) return;
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return;
    const newPath = filePath.replace(/\.[^.]+$/, `.${ext}`);
    if (newPath !== filePath) {
        const newFile = Gio.File.new_for_path(newPath);
        try {
            file.move(newFile, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            console.error(`[Big Shot] Failed to rename file: ${e.message}`);
        }
    }
}

// =============================================================================
// MAIN EXTENSION CLASS
// =============================================================================

export default class BigShotExtension extends Extension {
    enable() {
        this._parts = [];
        this._availableConfigs = [];
        this._currentConfigIndex = 0;

        const screenshotUI = Main.screenshotUI;
        if (!screenshotUI) {
            console.error('[Big Shot] ScreenshotUI not found');
            return;
        }

        this._screenshotUI = screenshotUI;

        // Detect available GStreamer pipelines
        this._detectPipelines();

        // Create all parts (modules)
        this._createParts();

        // Monkey-patch screencast proxy
        this._patchScreencast();

        console.log('[Big Shot] Extension enabled');
    }

    disable() {
        // Destroy all parts
        for (const part of this._parts) {
            try {
                part.destroy();
            } catch (e) {
                console.error(`[Big Shot] Error destroying part: ${e.message}`);
            }
        }
        this._parts = [];

        // Revert monkey-patches
        this._unpatchScreencast();

        this._screenshotUI = null;
        this._availableConfigs = [];

        console.log('[Big Shot] Extension disabled');
    }

    _detectPipelines() {
        // 1. Detect GPU vendor(s) via lspci (same as big-video-converter)
        this._gpuVendors = detectGpuVendors();
        console.log(`[Big Shot] Detected GPU vendor(s): ${this._gpuVendors.join(', ')}`);

        const vendorSet = new Set(this._gpuVendors);

        // 2. Build ordered config list:
        //    - First: configs matching detected GPU (NVIDIA, AMD, or Intel — all equal priority)
        //    - Last: software fallbacks (vendors=[])
        const gpuConfigs = []; // Hardware-accelerated for detected GPU
        const swConfigs = [];  // Software fallbacks

        for (const config of VIDEO_PIPELINES) {
            if (!checkPipeline(config))
                continue;

            // Software config (vendors is empty array)
            if (config.vendors.length === 0) {
                swConfigs.push(config);
                continue;
            }

            // GPU config — add if ANY detected vendor matches
            const matches = config.vendors.some(v => vendorSet.has(v));
            if (matches)
                gpuConfigs.push(config);
        }

        // Final order: GPU hardware (your detected vendor) → Software fallback
        this._availableConfigs = [...gpuConfigs, ...swConfigs];

        if (this._availableConfigs.length === 0) {
            console.warn('[Big Shot] No compatible GStreamer pipeline found!');
        } else {
            console.log(`[Big Shot] Pipeline priority (${this._availableConfigs.length} config(s)):`);
            this._availableConfigs.forEach((c, i) => {
                console.log(`  [${i}] ${c.id} — ${c.label}`);
            });
        }
    }

    _createParts() {
        const ui = this._screenshotUI;
        const ext = this;

        // Toolbar — main contextual toolbar above screenshot UI
        this._toolbar = new PartToolbar(ui, ext);
        this._parts.push(this._toolbar);

        // Annotation — connects toolbar to drawing overlay
        this._annotation = new PartAnnotation(ui, ext);
        this._parts.push(this._annotation);

        // Gradient — background gradient picker
        this._gradient = new PartGradient(ui, ext);
        this._parts.push(this._gradient);

        // Crop — crop with padding
        this._crop = new PartCrop(ui, ext);
        this._parts.push(this._crop);

        // Audio — Desktop + Mic toggle buttons
        this._audio = new PartAudio(ui, ext);
        this._parts.push(this._audio);

        // Framerate selector
        this._framerate = new PartFramerate(ui, ext);
        this._parts.push(this._framerate);

        // Downsize selector
        this._downsize = new PartDownsize(ui, ext);
        this._parts.push(this._downsize);

        // Panel indicator (spinner + timer)
        this._indicator = new PartIndicator(ui, ext);
        this._parts.push(this._indicator);

        // Quick Stop
        this._quickstop = new PartQuickStop(ui, ext);
        this._parts.push(this._quickstop);
    }

    _patchScreencast() {
        const screenshotUI = this._screenshotUI;
        const screencastProxy = screenshotUI._screencastService;
        if (!screencastProxy) return;

        // Save original methods
        this._origScreencast = screencastProxy.ScreencastAsync?.bind(screencastProxy);
        this._origScreencastArea = screencastProxy.ScreencastAreaAsync?.bind(screencastProxy);

        const ext = this;

        // Patch ScreencastAsync
        if (this._origScreencast) {
            screencastProxy.ScreencastAsync = function (filePath, options) {
                return ext._screencastCommonAsync(filePath, options, ext._origScreencast);
            };
        }

        // Patch ScreencastAreaAsync
        if (this._origScreencastArea) {
            screencastProxy.ScreencastAreaAsync = function (x, y, width, height, filePath, options) {
                return ext._screencastCommonAsync(filePath, options, (fp, opts) => {
                    return ext._origScreencastArea(x, y, width, height, fp, opts);
                });
            };
        }
    }

    _unpatchScreencast() {
        const screencastProxy = this._screenshotUI?._screencastService;
        if (!screencastProxy) return;

        if (this._origScreencast)
            screencastProxy.ScreencastAsync = this._origScreencast;
        if (this._origScreencastArea)
            screencastProxy.ScreencastAreaAsync = this._origScreencastArea;

        this._origScreencast = null;
        this._origScreencastArea = null;
    }

    async _screencastCommonAsync(filePath, options, originalMethod) {
        if (this._availableConfigs.length === 0) {
            console.log('[Big Shot] No custom pipelines, using GNOME default');
            return originalMethod(filePath, options);
        }

        const framerate = this._framerate?.value ?? 30;
        const downsize = this._downsize?.value ?? 1.0;
        const framerateCaps = `${framerate}/1`;

        // Try each config in cascade: GPU hw → VAAPI → Software
        for (let i = 0; i < this._availableConfigs.length; i++) {
            const config = this._availableConfigs[i];
            const pipeline = this._makePipelineString(config, framerateCaps, downsize);
            const pipelineOptions = { ...options, pipeline };

            console.log(`[Big Shot] Trying pipeline [${i}]: ${config.id} (${config.label})`);
            this._indicator?.onPipelineStarting();

            try {
                const result = await originalMethod(filePath, pipelineOptions);
                console.log(`[Big Shot] Pipeline ${config.id} succeeded`);
                this._indicator?.onPipelineReady();
                fixFilePath(filePath, config.ext);
                return result;
            } catch (e) {
                console.warn(`[Big Shot] Pipeline ${config.id} failed: ${e.message}`);
                // Continue to next config
            }
        }

        // All custom pipelines exhausted — fall back to GNOME's default pipeline
        console.warn('[Big Shot] All pipelines failed, falling back to GNOME default');
        this._indicator?.onPipelineStarting();
        return originalMethod(filePath, options);
    }

    _makePipelineString(config, framerateCaps, downsize) {
        let video = config.src.replace('FRAMERATE_CAPS', framerateCaps);
        video += ` ! ${config.enc}`;

        // Downsize
        if (downsize < 1.0) {
            const scaleStr = `videoscale ! video/x-raw,width=(int)(width*${downsize}),height=(int)(height*${downsize})`;
            video = video.replace('capsfilter', `capsfilter ! ${scaleStr}`);
        }

        const audioInput = this._audio?.makeAudioInput();
        const ext = config.ext;
        const muxer = MUXERS[ext];

        if (audioInput) {
            const audioPipeline = ext === 'mp4' ? AUDIO_PIPELINE.aac : AUDIO_PIPELINE.vorbis;
            return `${video} ! mux. ${audioInput} ! ${audioPipeline} ! mux. ${muxer} name=mux`;
        }

        return `${video} ! ${muxer}`;
    }
}
