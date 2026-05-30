# linux-wallpaperengine GNOME Shell Extension

A companion GNOME Shell extension that enables desktop background support for linux-wallpaperengine on GNOME/Wayland.

## How It Works

GNOME's Mutter compositor does not support the `zwlr_layer_shell_v1` protocol used by linux-wallpaperengine's Wayland driver. This extension bridges that gap:

1. The C++ renderer creates standard Wayland windows (xdg-shell) with encoded window titles
2. This extension discovers those windows and injects `Clutter.Clone` actors into GNOME Shell's desktop background
3. The original renderer windows are hidden from Alt+Tab, Overview, and the dash

Architecture follows the approach pioneered by [gnome-ext-hanabi](https://github.com/jeffshee/gnome-ext-hanabi).

## Requirements

- GNOME Shell 45, 46, 47, or 48
- Wayland session
- linux-wallpaperengine built with Wayland support (`ENABLE_WAYLAND`)

## Installation

```bash
# Symlink into the GNOME Shell extensions directory
ln -s $(pwd) ~/.local/share/gnome-shell/extensions/linux-wallpaperengine@github.io

# Restart GNOME Shell (X11/Wayland: Alt+F2, type 'r', press Enter)
# Enable the extension
gnome-extensions enable linux-wallpaperengine@github.io

# Alternatively, enable via the GNOME Extensions app
```

## Usage

Start linux-wallpaperengine with the `--gnome` flag and `--screen-root`:

```bash
# Single screen
linux-wallpaperengine --gnome --screen-root eDP-1 --bg 2317494988

# Multiple screens
linux-wallpaperengine --gnome --screen-root HDMI-1 --bg 2317494988 \
                       --screen-root eDP-1 --bg 1108150151
```

Find your monitor names:
```bash
# On GNOME/Wayland
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
    --object-path /org/gnome/Mutter/DisplayConfig \
    --method org.gnome.Mutter.DisplayConfig.GetResources | grep -oP '"([^"]+)"' | head -1
```

## Troubleshooting

- **Wallpaper not showing**: Verify the extension is enabled (`gnome-extensions info linux-wallpaperengine@github.io`)
- **Window visible in overview**: Restart GNOME Shell (Alt+F2, `r`)
- **Multi-monitor issues**: Make sure each `--screen-root` name matches exactly what `wl-info` or Mutter reports
- **Logs**: `journalctl -f -o cat /usr/bin/gnome-shell | grep lwpe`
