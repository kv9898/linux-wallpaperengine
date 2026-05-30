/**
 * linux-wallpaperengine GNOME Shell Extension - Wallpaper Manager
 *
 * This intentionally follows gnome-ext-hanabi's Shell-side structure:
 *   - LiveWallpaper clones the renderer's surface actor into GNOME's background.
 *   - ManagedWindow parses state from the renderer title, minimizes the renderer
 *     window (so it doesn't cover the desktop), and pins the surface container
 *     actor at (0,0) so it remains composited.
 *   - Shell overrides hide renderer windows from overview, Alt+Tab, and apps.
 *
 * Window title format (set by the C++ renderer):
 *   @linux-wallpaperengine!{"monitor":"HDMI-1","position":[0,0],
 *     "keepAtBottom":true,"keepMinimized":true,"keepPosition":true}
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const APPLICATION_ID = '@linux-wallpaperengine!';
const BACKGROUND_FADE_ANIMATION_TIME = 1000;

function getWindowTitle(window) {
    try {
        return window?.get_title?.() || window?.title || '';
    } catch (e) {
        return '';
    }
}

function isRendererWindow(window) {
    return getWindowTitle(window).startsWith(APPLICATION_ID);
}

function isRendererActor(actor) {
    const window = actor?.meta_window || actor?.get_meta_window?.();
    return isRendererWindow(window);
}

const LiveWallpaper = GObject.registerClass({
    GTypeName: 'LWPELiveWallpaper',
}, class LiveWallpaper extends St.Widget {
    constructor(backgroundActor) {
        super({
            layout_manager: new Clutter.BinLayout(),
            width: backgroundActor.width,
            height: backgroundActor.height,
            reactive: false,
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });

        this._backgroundActor = backgroundActor;
        this._monitorIndex = backgroundActor.monitor;
        this._wallpaper = null;
        this._retryId = 0;

        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        this._monitorWidth = monitor?.width ?? backgroundActor.width;
        this._monitorHeight = monitor?.height ?? backgroundActor.height;

        backgroundActor.layout_manager = new Clutter.BinLayout();
        backgroundActor.add_child(this);

        this._applyWallpaper();
    }

    _applyWallpaper() {
        const operation = () => {
            const source = this._getSource();

            if (!source) {
                return GLib.SOURCE_CONTINUE;
            }

            this._wallpaper = new Clutter.Clone({
                source,
                pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            });
            this._wallpaper.connect('destroy', () => {
                this._wallpaper = null;
            });

            this._wallpaper.set_size(this._monitorWidth, this._monitorHeight);
            this.add_child(this._wallpaper);
            this._fade();
            this._retryId = 0;
            log(`lwpe: wallpaper applied on monitor ${this._monitorIndex}`);

            return GLib.SOURCE_REMOVE;
        };

        if (operation() === GLib.SOURCE_CONTINUE) {
            this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, operation);
        }
    }

    /**
     * Find the best source actor to clone.
     *
     * Cloning the MetaWindowActor directly has a problem: when the window is
     * minimized, some Mutter versions make MetaWindowActor.paint() return
     * early, producing a static snapshot in the clone.
     *
     * Instead we clone the *surface container* child of the window actor.
     * This child holds the actual Wayland/X11 surface texture and its paint
     * function doesn't check window state — it always paints the latest
     * committed buffer.  The ManagedWindow pins this child at (0,0) so it
     * stays accessible even while the window is minimized.
     */
    _getSource() {
        let windowActors = [];
        try {
            windowActors = global.get_window_actors(false);
        } catch (e) {
            windowActors = global.get_window_actors();
        }

        const rendererActors = windowActors.filter(isRendererActor);
        const renderer = rendererActors.find(actor => {
            try {
                return actor.meta_window.get_monitor() === this._monitorIndex;
            } catch (e) {
                return false;
            }
        });

        if (!renderer) return null;

        // Try known surface-container type names (Wayland → X11 fallback)
        const children = renderer.get_children?.() ?? [];
        const surfaceTypes = [
            'MetaSurfaceContainerActorWayland',
            'MetaSurfaceActorWayland',
            'MetaSurfaceContainerActorX11',
            'MetaSurfaceActorX11',
        ];
        for (const typeName of surfaceTypes) {
            const surface = children.find(c => {
                try { return GObject.type_name(c) === typeName; } catch (e) { return false; }
            });
            if (surface) {
                log(`lwpe: cloning surface actor ${typeName}`);
                return surface;
            }
        }

        // Unknown surface type — log children for debugging & fall back
        const childTypes = children.map(c => {
            try { return GObject.type_name(c); } catch (e) { return '?'; }
        });
        log(`lwpe: no known surface child, children: [${childTypes.join(', ')}]`);

        return renderer;
    }

    _fade(visible = true) {
        this.ease({
            opacity: visible ? 255 : 0,
            duration: BACKGROUND_FADE_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    destroy() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }

        super.destroy();
    }
});

class ManagedWindow {
    constructor(window) {
        this._window = window;
        this._signals = [];
        this._surfaceContainer = null;
        this._surfacePositionId = 0;
        this._states = {
            position: [0, 0],
            keepAtBottom: false,
            keepMinimized: false,
            keepPosition: false,
        };

        this._signals.push(this._window.connect('notify::title', () => {
            this._parseTitle();
        }));
        this._signals.push(this._window.connect_after('shown', () => {
            if (this._states.keepMinimized) this._window.minimize();
        }));
        this._signals.push(this._window.connect_after('raised', () => {
            if (this._states.keepAtBottom) this._window.lower();
        }));
        this._signals.push(this._window.connect('notify::above', () => {
            if (this._states.keepAtBottom && this._window.above) {
                this._window.unmake_above();
            }
        }));
        this._signals.push(this._window.connect('notify::minimized', () => {
            if (this._states.keepMinimized && !this._window.minimized) {
                this._window.minimize();
            }
        }));
        this._signals.push(this._window.connect('position-changed', () => {
            if (this._states.keepPosition) {
                const [x, y] = this._states.position;
                this._window.move_frame(true, x, y);
            }
        }));

        // GNOME 45+ (issue #3159): when a window is minimized, Mutter
        // moves the surface container actor to a negative position to
        // hide it.  We pin it at (0,0) so the Clutter.Clone — which
        // now sources from this child directly — always sees the
        // latest frame at the correct position.
        this._pinSurfaceContainer();

        this._parseTitle();
    }

    _pinSurfaceContainer() {
        const windowActor = this._window.get_compositor_private?.();
        const children = windowActor?.get_children?.() ?? [];

        const surfaceTypes = [
            'MetaSurfaceContainerActorWayland',
            'MetaSurfaceActorWayland',
            'MetaSurfaceContainerActorX11',
            'MetaSurfaceActorX11',
        ];
        for (const typeName of surfaceTypes) {
            const surface = children.find(c => {
                try { return GObject.type_name(c) === typeName; } catch (e) { return false; }
            });
            if (surface) {
                this._surfaceContainer = surface;
                this._surfacePositionId = surface.connect('notify::position', () => {
                    surface.set_position(0, 0);
                });
                log(`lwpe: pinning surface container ${typeName} at (0,0)`);
                return;
            }
        }

        // Log children types for debugging
        const childTypes = children.map(c => {
            try { return GObject.type_name(c); } catch (e) { return '?'; }
        });
        log(`lwpe: no surface container found, children: [${childTypes.join(', ')}]`);
    }

    _parseTitle() {
        const title = getWindowTitle(this._window);
        if (!title.startsWith(APPLICATION_ID)) return;

        const json = title.substring(APPLICATION_ID.length);
        try {
            const newStates = JSON.parse(json);
            this._states = {...this._states, ...newStates};
        } catch (e) {
            log(`lwpe: failed to parse renderer title: ${e.message}`);
        }

        this._refresh();
    }

    _refresh() {
        if (this._states.keepAtBottom && this._window.above) {
            this._window.unmake_above();
        }
        if (this._states.keepAtBottom) {
            this._window.lower();
        }
        if (this._states.keepMinimized && !this._window.minimized) {
            this._window.minimize();
        }
        if (this._states.keepPosition) {
            const [x, y] = this._states.position;
            this._window.move_frame(true, x, y);
        }
    }

    disconnect() {
        if (this._surfaceContainer && this._surfacePositionId) {
            this._surfaceContainer.disconnect(this._surfacePositionId);
        }

        this._signals.forEach(signal => {
            this._window.disconnect(signal);
        });
        this._signals = [];
        this._surfaceContainer = null;
        this._surfacePositionId = 0;
        this._window = null;
    }
}

class WindowManager {
    constructor() {
        this._windows = new Set();
        this._mapId = 0;
    }

    enable() {
        this._mapId = global.window_manager.connect_after('map', (_wm, windowActor) => {
            const window = windowActor.get_meta_window();
            if (isRendererWindow(window)) {
                this.addWindow(window);
            }
        });

        let windowActors = [];
        try {
            windowActors = global.get_window_actors(false);
        } catch (e) {
            windowActors = global.get_window_actors();
        }

        windowActors.filter(isRendererActor).forEach(actor => this.addWindow(actor));
    }

    disable() {
        this._windows.forEach(window => this._clearWindow(window));
        this._windows.clear();

        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }
    }

    addWindow(window) {
        if (window.get_meta_window) {
            window = window.get_meta_window();
        }

        if (this._windows.has(window)) return;

        window.lwpeManaged = new ManagedWindow(window);
        window.lwpeUnmanagedId = window.connect('unmanaged', _window => {
            this._clearWindow(_window);
            this._windows.delete(_window);
        });
        this._windows.add(window);
    }

    _clearWindow(window) {
        if (!window.lwpeManaged) return;

        window.disconnect(window.lwpeUnmanagedId);
        window.lwpeManaged.disconnect();
        window.lwpeManaged = null;
        window.lwpeUnmanagedId = 0;
    }
}

export class WallpaperManager {
    constructor() {
        this._injectionManager = new InjectionManager();
        this._wallpaperActors = new Set();
        this._windowManager = new WindowManager();

        this._enable();
        log('lwpe: enabled');
    }

    _reloadBackgrounds() {
        this._wallpaperActors.forEach(actor => actor.destroy());
        this._wallpaperActors.clear();

        try { Main.layoutManager._updateBackgrounds(); } catch (e) {}
        try { Main.screenShield?._dialog?._updateBackgrounds?.(); } catch (e) {}
        try {
            Main.overview?._overview?._controls?._workspacesDisplay?._updateWorkspacesViews?.();
        } catch (e) {}
    }

    _enable() {
        this._injectionManager.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            originalMethod => {
                return function () {
                    const backgroundActor = originalMethod.call(this);
                    this.videoActor = new LiveWallpaper(backgroundActor);

                    const manager = global.lwpeWallpaperManager;
                    manager?._wallpaperActors.add(this.videoActor);
                    this.videoActor.connect('destroy', actor => {
                        manager?._wallpaperActors.delete(actor);
                    });

                    return backgroundActor;
                };
            }
        );

        this._injectionManager.overrideMethod(
            Shell.Global.prototype,
            'get_window_actors',
            originalMethod => {
                return function (hideRenderer = true) {
                    const windowActors = originalMethod.call(this);
                    return hideRenderer
                        ? windowActors.filter(actor => !isRendererActor(actor))
                        : windowActors;
                };
            }
        );

        this._injectionManager.overrideMethod(
            Workspace.Workspace.prototype,
            '_isOverviewWindow',
            originalMethod => {
                return function (window) {
                    return isRendererWindow(window) ? false : originalMethod.apply(this, [window]);
                };
            }
        );

        this._injectionManager.overrideMethod(
            WorkspaceThumbnail.WorkspaceThumbnail.prototype,
            '_isOverviewWindow',
            originalMethod => {
                return function (window) {
                    return isRendererWindow(window) ? false : originalMethod.apply(this, [window]);
                };
            }
        );

        this._injectionManager.overrideMethod(
            Meta.Display.prototype,
            'get_tab_list',
            originalMethod => {
                return function (type, workspace) {
                    return originalMethod.apply(this, [type, workspace])
                        .filter(window => !isRendererWindow(window));
                };
            }
        );

        this._injectionManager.overrideMethod(
            Shell.WindowTracker.prototype,
            'get_window_app',
            originalMethod => {
                return function (window) {
                    return isRendererWindow(window) ? null : originalMethod.apply(this, [window]);
                };
            }
        );

        this._injectionManager.overrideMethod(
            Shell.App.prototype,
            'get_windows',
            originalMethod => {
                return function () {
                    return originalMethod.call(this).filter(window => !isRendererWindow(window));
                };
            }
        );

        this._injectionManager.overrideMethod(
            Shell.App.prototype,
            'get_n_windows',
            _originalMethod => {
                return function () {
                    return this.get_windows().length;
                };
            }
        );

        this._injectionManager.overrideMethod(
            Shell.AppSystem.prototype,
            'get_running',
            originalMethod => {
                return function () {
                    return originalMethod.call(this).filter(app => app.get_n_windows() > 0);
                };
            }
        );

        global.lwpeWallpaperManager = this;
        this._windowManager.enable();
        this._reloadBackgrounds();
    }

    destroy() {
        this._windowManager.disable();
        this._injectionManager.clear();
        this._reloadBackgrounds();

        if (global.lwpeWallpaperManager === this) {
            global.lwpeWallpaperManager = null;
        }

        log('lwpe: disabled');
    }
}
