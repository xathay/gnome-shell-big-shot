<div align="center">

# Big Shot

**Enhanced Screenshot & Screencast for GNOME Shell**

A GNOME Shell extension that transforms the native Print Screen UI into a powerful annotation and recording tool — with drawing tools, gradient backgrounds, audio capture, and GPU-accelerated screencasting.

[![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-46--49-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/) [![GJS](https://img.shields.io/badge/GJS-ES2022-F7DF1E?logo=javascript&logoColor=black)](https://gjs.guide/) [![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE) [![Platform](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)](https://www.gnome.org/) [![GStreamer](https://img.shields.io/badge/GStreamer-1.0-red)](https://gstreamer.freedesktop.org/)

</div>

---

## Overview

**Big Shot** hooks into GNOME Shell's built-in Screenshot UI (activated by `Print Screen`) and extends it with:

- **9 annotation tools** for marking up screenshots in real-time
- **Gradient backgrounds, crop, padding & drop-shadow** for professional-looking captures
- **Desktop + Microphone audio** recording via PulseAudio/PipeWire
- **GPU-accelerated screencasting** with automatic hardware detection (NVIDIA CUDA, AMD/Intel VAAPI)
- **Keyboard-driven workflow** — press `1`–`9` to select tools instantly

No separate windows. No external apps. Everything lives inside the native GNOME UI.

---

## Features

### Screenshot Mode

| Feature | Description |
|---------|-------------|
| **Pen** | Freehand stroke with Bézier curve smoothing |
| **Arrow** | Arrow with proportional head, Shift-snap to axis |
| **Line** | Straight line, Shift-snap to horizontal/vertical |
| **Rectangle** | Outlined or filled rectangle, Shift = square |
| **Oval** | Outlined or filled ellipse, Shift = circle |
| **Text** | Inline text entry via popover with custom font size |
| **Highlighter** | Semi-transparent marker (multiply blend), Shift = horizontal |
| **Censor** | Mosaic pixelation over sensitive areas |
| **Number Stamp** | Sequential numbered circles for step-by-step guides |

**Beautification:**
- 8 gradient background presets with configurable angle (0°–315°)
- Crop with 8 draggable handles + whole-region drag
- Padding: cycle through 0 / 16 / 32 / 48 / 64 px
- Configurable border radius (0 / 8 / 16 / 24 / 32 px)
- Drop-shadow rendering for professional screenshots

**Controls:**
- Expanded color palette popup (12 colors) + separate fill color selector
- Brush size cycling (1, 2, 3, 5, 8, 12)
- Undo/Redo (`Ctrl+Z` / `Ctrl+Shift+Z`)
- Object selection & move (click to select, drag to reposition)

### Screencast Mode

| Feature | Description |
|---------|-------------|
| **Desktop Audio** | Record system audio output via PulseAudio monitor source (`provide-clock=false` for PipeWire sync) |
| **Microphone** | Record microphone input, dynamic channel detection via `Gvc.MixerControl` |
| **Audio Mix** | Simultaneous desktop + mic recording via `audiomixer` with latency compensation |
| **FPS** | 15 / 24 / 30 / 60 frames per second |
| **Resolution** | 100% / 75% / 50% / 33% downscaling |
| **GPU Pipeline** | Auto-detected NVIDIA CUDA, AMD/Intel VAAPI, or software fallback (cascade) |
| **Quick Stop** | Click the panel indicator or re-open the screenshot UI to stop recording |
| **Timer** | Live recording timer (spinner during pipeline startup, timer once recording starts) |
| **Screenshot during recording** | Take screenshots while a screencast is in progress (patched GNOME limitation) |

### GPU Detection

Follows the same detection pattern as [big-video-converter](https://github.com/biglinux/big-video-converter):

```
lspci → detect GPU vendor(s) → select matching pipelines → cascade fallback
```

| Detected GPU | Pipeline Priority |
|---|---|
| NVIDIA | CUDA H.264 → GL H.264 (nvh264enc) |
| AMD | VAAPI LP H.264 → VAAPI H.264 |
| Intel | VAAPI LP H.264 → VAAPI H.264 |
| Fallback | SW memfd H.264 → SW memfd VP8 → SW GL H.264 → SW GL VP8 → GNOME default |

All GPU vendors have **equal priority** — whichever is detected gets hardware-accelerated encoding. Software fallback uses a multi-stage cascade: memfd pipelines first (with `videoconvert`), then GL pipelines (`gldownload`), and finally GNOME's built-in default recorder. The pipeline structure follows GStreamer muxing conventions:

```
[service: pipewiresrc ! capsfilter] ! videoconvert ! queue ! mux. audio ! mux. muxer name=mux [service: ! filesink]
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`9` | Select annotation tool (Pen, Arrow, Line, Rect, Oval, Text, Highlight, Censor, Number) |
| `0` or `S` | Enter selection/move mode |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Delete` / `Backspace` | Remove selected or last object |
| `Escape` | Deselect current object |

---

## Technical Notes

### GNOME Screencast Service Integration

Big Shot monkey-patches the GNOME Shell Screencast D-Bus proxy (`_screencastProxy`) to inject custom GStreamer pipelines. The GNOME screencast service (a separate process since GNOME 49) automatically prepends `pipewiresrc ! capsfilter` and appends `filesink` to the pipeline string, so the extension only provides the encoding/muxing portion.

Key implementation details:
- **No duplicate capsfilter** — the service already adds `capsfilter caps=video/x-raw,max-framerate=F/1`, so the extension's pipelines must NOT include their own capsfilter
- **File extension fix** — the service doesn't provide `fileExtension` for custom pipelines (files would be saved as `.undefined`), so the extension renames the output file using the actual path returned by D-Bus
- **Screenshot during recording** — GNOME normally blocks `screenshotUI.open()` when `_screencastInProgress` is true; the extension patches this to allow screenshots while recording

### Audio Pipeline

Audio capture works via `Gvc.MixerControl` to detect PulseAudio/PipeWire output monitors and microphone inputs:
- `provide-clock=false` on `pulsesrc` prevents clock conflicts with `pipewiresrc`
- Channel count is detected dynamically from the mixer device (not hardcoded)
- `audiomixer latency=100000000` handles synchronization for simultaneous desktop + mic

---

## Compatibility

- **GNOME Shell**: 46, 47, 48, 49
- **Distribution**: Arch Linux (BigLinux / BigCommunity) — works on any Arch-based distro
- **Audio**: PulseAudio / PipeWire (via PulseAudio compatibility)
- **Video**: GStreamer 1.0

---

## Installation

### Arch Linux (PKGBUILD)

```bash
cd pkgbuild
makepkg -si
```

### Manual (for testing)

```bash
chmod +x build.sh
./build.sh
gnome-extensions install --force big-shot.zip
# Log out and back in, or restart GNOME Shell
```

---

## Project Structure

```
gnome-shell-big-shot/
├── usr/share/gnome-shell/extensions/big-shot@bigcommunity.org/
│   ├── metadata.json           # Extension metadata (UUID, shell versions)
│   ├── extension.js            # Main class — GPU detection, pipeline management, monkey-patching
│   ├── stylesheet.css          # Native GNOME Shell CSS styles
│   ├── parts/
│   │   ├── partbase.js         # Base classes (PartBase, PartUI, PartPopupSelect)
│   │   ├── parttoolbar.js      # Contextual toolbar — tool selection, color/size, undo/redo
│   │   ├── partannotation.js   # Connects toolbar ↔ drawing overlay lifecycle
│   │   ├── partgradient.js     # Gradient picker — 8 presets, angle & border-radius controls
│   │   ├── partcrop.js         # Crop overlay — 8 draggable handles + padding
│   │   ├── partaudio.js        # Audio — desktop + mic via Gvc.MixerControl
│   │   ├── partframerate.js    # FPS selector (15/24/30/60)
│   │   ├── partdownsize.js     # Resolution selector (100%/75%/50%/33%)
│   │   ├── partindicator.js    # Panel spinner + recording timer
│   │   └── partquickstop.js    # Quick stop — re-open UI stops recording
│   ├── drawing/
│   │   ├── actions.js          # 9 drawing action classes + factory function
│   │   ├── overlay.js          # Cairo canvas overlay — input handling, selection, text popover
│   │   └── colors.js           # Color palette (12 colors) + hex/RGBA utilities
│   ├── data/
│   │   ├── icons/              # 12 custom SVG symbolic icons
│   │   └── gradients.js        # Gradient presets + paintGradient/paintDropShadow/paintRoundedRect
│   └── po/
│       ├── big-shot.pot        # Gettext template (20 strings)
│       ├── en.po               # English
│       ├── pt_BR.po            # Brazilian Portuguese
│       ├── es.po               # Spanish
│       ├── fr.po               # French
│       └── de.po               # German
├── pkgbuild/
│   ├── PKGBUILD               # Arch Linux package build
│   └── pkgbuild.install        # Post-install hooks
├── LICENSE                     # GPL-2.0-or-later
└── README.md
```

---

## Dependencies

### Required

| Package | Purpose |
|---------|---------|
| `gnome-shell` >= 46 | Host shell |
| `gstreamer` | Video pipeline framework |
| `gst-plugins-base` | Base GStreamer elements |
| `gst-plugins-good` | Common codecs and muxers |

### Optional (for hardware encoding)

| Package | Purpose |
|---------|---------|
| `gst-plugins-bad` | VAAPI hardware encoding (AMD/Intel) |
| `gst-plugin-openh264` | H.264 software encoding |
| `nvidia-utils` | NVIDIA CUDA/NVENC encoding |
| `gst-plugins-ugly` | Additional codecs |

### Build

| Package | Purpose |
|---------|---------|
| `gettext` | Compile `.po` → `.mo` translations |

---

## Translations

Big Shot supports 5 languages out of the box:

| Language | File |
|----------|------|
| English | `po/en.po` |
| Brazilian Portuguese | `po/pt_BR.po` |
| Spanish | `po/es.po` |
| French | `po/fr.po` |
| German | `po/de.po` |

To add a new language, copy `po/big-shot.pot` to `po/<LANG>.po` and translate all 20 strings.

---

## Acknowledgments

Big Shot was inspired by and based on the following projects:

- **[Gradia](https://github.com/AlexanderVanhee/Gradia)** — Screenshot beautification tool for GNOME that inspired the gradient backgrounds, crop, padding, and drop-shadow features.
- **[GNOME Shell Screencast Extra Feature](https://github.com/WSID/gnome-shell-screencast-extra-feature)** — GNOME Shell extension for enhanced screencast recording that served as the foundation for the audio capture, GPU pipeline detection, and screencast monkey-patching approach.

---

## License

[GPL-2.0-or-later](LICENSE) — Copyright © 2024 BigCommunity
