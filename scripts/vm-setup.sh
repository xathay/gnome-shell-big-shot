#!/bin/bash
# vm-setup.sh — Setup AND update Big-Shot in a development VM (idempotent).
#
# Run this script inside the VM. Safe to run multiple times — first time
# it clones + installs everything; subsequent runs do `git pull` and
# reinstall to pick up code changes.
#
# Usage (first time):
#   curl -fsSL https://raw.githubusercontent.com/xathay/gnome-shell-big-shot/dev-talesam/scripts/vm-setup.sh | bash
#
# Usage (iterate after pushing changes):
#   bash ~/gnome-shell-big-shot/scripts/vm-setup.sh
#
# After running: log out and back in to reload the GNOME Shell extension.
# (On X11 you can also Alt+F2 → 'r' → Enter to reload without logging out.)
#
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

REPO_URL="https://github.com/xathay/gnome-shell-big-shot.git"
BRANCH="dev-talesam"
PROJ_DIR="$HOME/gnome-shell-big-shot"
UUID="big-shot@bigcommunity.org"
EXT_DST="/usr/share/gnome-shell/extensions/$UUID"
HELPER_DST_DIR="/usr/lib/big-shot"

echo "=== Big-Shot dev VM setup/update ==="
echo "  branch: $BRANCH"
echo "  source: $REPO_URL"
echo ""

# --- 1. VM-friendly keybindings (avoid host conflicts) ---
echo "[1/6] Configuring keyboard shortcuts (VM-safe)…"

# Disable Super key overlay so it doesn't fight the host
gsettings set org.gnome.mutter overlay-key '' 2>/dev/null || true

# Activities Overview → Ctrl+Super (since Super alone is disabled)
gsettings set org.gnome.shell.keybindings toggle-overview "['<Ctrl>Super_L']" 2>/dev/null || true

# Screenshot UI → Ctrl+Print
gsettings set org.gnome.shell.keybindings show-screenshot-ui "['<Ctrl>Print']" 2>/dev/null || true

# Direct screenshot → Ctrl+Shift+Print
gsettings set org.gnome.shell.keybindings screenshot "['<Ctrl><Shift>Print']" 2>/dev/null || true

# Big-Shot keybindings — use Ctrl+Alt combos because Super is disabled in the VM
# (the gschema defaults to <Super><Shift>R/W for end users)
dconf write /org/gnome/shell/extensions/big-shot/scrolling-capture "['<Ctrl><Alt>r']" 2>/dev/null || true
dconf write /org/gnome/shell/extensions/big-shot/forensic-capture "['<Ctrl><Alt>w']" 2>/dev/null || true

echo "  Super       → disabled (use Ctrl+Super for Activities)"
echo "  Ctrl+Print  → Screenshot UI"
echo "  Ctrl+Alt+R  → Scrolling capture (new)"
echo "  Ctrl+Alt+W  → Forensic web capture (new)"

# --- 2. Clone or pull the project ---
echo "[2/6] Syncing project source…"

if [[ -d "$PROJ_DIR/.git" ]]; then
    echo "  exists at $PROJ_DIR — fetching + checking out $BRANCH"
    git -C "$PROJ_DIR" fetch --all --prune
    git -C "$PROJ_DIR" checkout "$BRANCH"
    git -C "$PROJ_DIR" pull --ff-only
else
    git clone --branch "$BRANCH" "$REPO_URL" "$PROJ_DIR"
fi

# --- 3. Install extension (rsync-like copy) ---
echo "[3/6] Installing extension to $EXT_DST…"

EXT_SRC="$PROJ_DIR/usr/share/gnome-shell/extensions/$UUID"
if [[ ! -d "$EXT_SRC" ]]; then
    echo "  ERROR: extension source not found at $EXT_SRC" >&2
    exit 1
fi

sudo mkdir -p "$(dirname "$EXT_DST")"
# Delete destination first so removed files actually disappear
sudo rm -rf "$EXT_DST"
sudo cp -a "$EXT_SRC" "$EXT_DST"
echo "  copied $(find "$EXT_SRC" -type f | wc -l) files"

# --- 4. Compile gsettings schema ---
echo "[4/6] Compiling gsettings schema…"

if [[ -d "$EXT_DST/schemas" ]]; then
    sudo glib-compile-schemas "$EXT_DST/schemas/"
    echo "  $(ls "$EXT_DST/schemas/")"
else
    echo "  no schemas/ — skipping"
fi

# --- 5. Install forensic helper ---
echo "[5/6] Installing forensic helper to $HELPER_DST_DIR/…"

HELPER_SRC="$PROJ_DIR/usr/lib/big-shot/forensic_capture.py"
if [[ -f "$HELPER_SRC" ]]; then
    sudo mkdir -p "$HELPER_DST_DIR"
    sudo cp -a "$HELPER_SRC" "$HELPER_DST_DIR/"
    sudo chmod 755 "$HELPER_DST_DIR/forensic_capture.py"
    echo "  installed $HELPER_DST_DIR/forensic_capture.py"
else
    echo "  forensic_capture.py not found in source — skipping"
fi

# --- 6. Enable extension + dependency hints ---
echo "[6/6] Enabling extension…"
gnome-extensions enable "$UUID" 2>/dev/null || true

# Probe optional deps (don't auto-install — let the user decide)
echo ""
echo "=== Optional dependencies ==="
have() { command -v "$1" >/dev/null 2>&1; }
python_has() { python3 -c "import $1" 2>/dev/null; }

OPTDEPS_MISSING=()
have openssl || OPTDEPS_MISSING+=("openssl (forensic RFC 3161 timestamp)")
have curl    || OPTDEPS_MISSING+=("curl (forensic RFC 3161 timestamp)")
python_has playwright    || OPTDEPS_MISSING+=("python-playwright (forensic capture engine)")
python_has cryptography  || OPTDEPS_MISSING+=("python-cryptography (full TLS cert parsing)")

if [[ ${#OPTDEPS_MISSING[@]} -gt 0 ]]; then
    echo "  Missing (forensic feature will degrade or be unavailable):"
    for d in "${OPTDEPS_MISSING[@]}"; do echo "    - $d"; done
    echo ""
    echo "  Install on BigLinux/CachyOS/Arch:"
    echo "    sudo pacman -S openssl curl python-cryptography"
    echo "    # python-playwright via pip (bundles chromium ~200MB):"
    echo "    pip install --user playwright && python -m playwright install chromium"
else
    echo "  All optional dependencies satisfied ✓"
fi

# --- Summary ---
cat <<EOF

=== Setup complete ===

To activate changes:
  Wayland: log out and back in
  X11:     Alt+F2 → 'r' → Enter (full Shell reload)

To test the new features:
  1. Scrolling capture: Ctrl+Alt+R  → captures focused window
  2. Forensic capture:  Ctrl+Alt+W  → modal asks for URL
  3. Standard screenshot: Ctrl+Print

To iterate after pushing more commits:
  bash $PROJ_DIR/scripts/vm-setup.sh

To watch logs:
  journalctl --user -f -o cat | grep -i 'big shot'
EOF
