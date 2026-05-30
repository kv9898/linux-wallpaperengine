/**
 * linux-wallpaperengine GNOME Shell Extension — Wallpaper Manager
 *
 * Core logic:
 *   1. Discovers renderer windows (title starts with @linux-wallpaperengine!)
 *   2. Injects Clutter.Clone actors into GNOME's desktop background
 *   3. Hides renderer windows from overview, Alt+Tab, dock, and app list
 *   4. Keeps renderer windows sticky, at the bottom, and never minimized
 *
 * Window title format (set by the C++ renderer):
 *   @linux-wallpaperengine!{"monitor":"HDMI-1","width":1920,"height":1080}
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

const APPLICATION_ID = '@linux-wallpaperengine!';

/**
 * Managed wallpaper: wraps one renderer window, its Clutter.Clone, and
 * enforces window state (never minimized, always at bottom, sticky).
 */
class ManagedWallpaper {
    constructor(metaWindow, windowActor, info) {
        this.metaWindow = metaWindow;
        this.windowActor = windowActor;
        this.info = info;
        this._clone = null;
        this._backgroundActor = null;
        this._signalIds = [];

        // Keep window sticky (on all workspaces) and at the bottom
        this._enforceWindowState();
    }

    /**
     * Prevent the renderer window from being minimized or raised.
     * If the window minimizes, Mutter stops compositing it, which
     * kills the Clutter.Clone source and shows the static wallpaper.
     */
    _enforceWindowState() {
        if (!this.metaWindow) return;

        // Make sticky so it's always available on every workspace
        try { this.metaWindow.sticky = true; } catch (e) {}

        // Put it at the very bottom of the stack
        try { this.metaWindow.lower(); } catch (e) {}

        // Prevent minimization: re-map if minimized
        try {
            const id = this.metaWindow.connect('notify::minimized', () => {
                if (this.metaWindow.minimized) {
                    this.metaWindow.unminimize();
                    this.metaWindow.lower();
                }
            });
            this._signalIds.push(id);
        } catch (e) {}

        // Prevent being raised above other windows
        try {
            const id = this.metaWindow.connect('raised', () => {
                this.metaWindow.lower();
            });
            this._signalIds.push(id);
        } catch (e) {}

        // Keep it at bottom even if something tries to make it 'above'
        try {
            const id = this.metaWindow.connect('notify::above', () => {
                if (this.metaWindow.above) {
                    this.metaWindow.unmake_above();
                }
            });
            this._signalIds.push(id);
        } catch (e) {}
    }

    inject(backgroundActor) {
        if (!backgroundActor || !this.windowActor) return;

        this.remove();

        this._clone = new Clutter.Clone({
            source: this.windowActor,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });

        const width = backgroundActor.width || this.info.width;
        const height = backgroundActor.height || this.info.height;
        this._clone.set_size(width, height);
        this._clone.set_position(0, 0);

        backgroundActor.add_child(this._clone);
        this._clone.lower_bottom();
        this._backgroundActor = backgroundActor;

        this._clone.opacity = 0;
        this._clone.ease({
            opacity: 255,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    remove() {
        if (this._clone) {
            const clone = this._clone;
            this._clone = null;
            clone.ease({
                opacity: 0,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => { clone.destroy(); },
            });
        }
        this._backgroundActor = null;
    }

    destroy() {
        if (this._clone) {
            this._clone.destroy();
            this._clone = null;
        }
        // Disconnect window state signals
        for (const id of this._signalIds) {
            try { this.metaWindow?.disconnect(id); } catch (e) {}
        }
        this._signalIds = [];
        this._backgroundActor = null;
        this.metaWindow = null;
        this.windowActor = null;
    }
}

export class WallpaperManager {
    constructor() {
        this._wallpapers = new Map();
        this._injectionManager = new InjectionManager();
        this._signalIds = [];
        this._enabled = false;

        this._discoverExistingWindows();
        this._connectWindowSignals();
        this._initBackgroundInjection();
        this._initWindowHiding();
        this._initAppSystemHiding();

        this._enabled = true;
        log('lwpe: enabled');
    }

    /* ------------------------------------------------------------------ */
    /*  Window discovery                                                    */
    /* ------------------------------------------------------------------ */

    _parseTitle(title) {
        if (!title || !title.startsWith(APPLICATION_ID)) return null;
        try {
            const jsonStart = title.indexOf('{');
            if (jsonStart === -1) return null;
            const info = JSON.parse(title.substring(jsonStart));
            if (info.monitor) return info;
        } catch (e) {
            log(`lwpe: failed to parse window title: ${e}`);
        }
        return null;
    }

    _discoverExistingWindows() {
        const actors = global.get_window_actors();
        for (const actor of actors) {
            const metaWindow = actor.meta_window || actor.get_meta_window();
            if (metaWindow) this._onWindowMapped(metaWindow, actor);
        }
    }

    _onWindowMapped(metaWindow, actor) {
        if (!metaWindow) return;
        const title = metaWindow.get_title();
        const info = this._parseTitle(title);
        if (!info) return;

        const monitorName = info.monitor;
        log(`lwpe: found renderer window for ${monitorName}`);

        if (this._wallpapers.has(monitorName)) {
            this._wallpapers.get(monitorName).destroy();
        }

        const managed = new ManagedWallpaper(metaWindow, actor, info);
        this._wallpapers.set(monitorName, managed);
        this._tryInject(monitorName, managed);
    }

    _onWindowUnmapped(metaWindow) {
        if (!metaWindow) return;
        for (const [monitorName, managed] of this._wallpapers) {
            if (managed.metaWindow === metaWindow) {
                log(`lwpe: renderer window for ${monitorName} unmapped`);
                managed.destroy();
                this._wallpapers.delete(monitorName);
                break;
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Background injection                                               */
    /* ------------------------------------------------------------------ */

    _initBackgroundInjection() {
        try {
            const self = this;
            this._injectionManager.overrideMethod(
                Background.BackgroundManager.prototype,
                '_createBackgroundActor',
                originalMethod => {
                    return function () {
                        const actor = originalMethod.call(this);
                        self._onBackgroundCreated(this, actor);
                        return actor;
                    };
                }
            );
            log('lwpe: background injection active');
        } catch (e) {
            log(`lwpe: failed to inject background: ${e.message}`);
        }
    }

    _onBackgroundCreated(bgManager, backgroundActor) {
        if (!this._enabled) return;
        const monitorName = this._getMonitorName(bgManager);
        if (!monitorName) return;
        const managed = this._wallpapers.get(monitorName);
        if (managed) {
            managed.inject(backgroundActor);
        }
    }

    _tryInject(monitorName, managed) {
        try {
            const groups = Main.backgroundGroup?._backgroundGroupManagers || [];
            for (const bgGroup of groups) {
                const mgr = bgGroup._bgManager;
                if (!mgr) continue;
                if (this._getMonitorName(mgr) === monitorName) {
                    const actor = mgr.actor || mgr._bgWidget;
                    if (actor) { managed.inject(actor); return; }
                }
            }
        } catch (e) { /* Background group not yet initialized */ }
    }

    _getMonitorName(bgManager) {
        try {
            const monitor = bgManager._monitor || bgManager.monitor;
            if (!monitor) return null;
            const monitorManager = Meta.MonitorManager.get();
            if (!monitorManager) return null;
            const monIndex = typeof monitor === 'number' ? monitor : monitor.index;
            if (monIndex === undefined || monIndex === null) return null;
            const logicalMonitor = monitorManager.get_logical_monitor_from_number(monIndex);
            if (!logicalMonitor) return null;
            const monitors = logicalMonitor.get_monitors();
            if (monitors && monitors.length > 0 && monitors[0].get_connector()) {
                return monitors[0].get_connector();
            }
        } catch (e) {
            log(`lwpe: failed to get monitor name: ${e.message}`);
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /*  Window hiding from overview, Alt+Tab, workspace previews           */
    /* ------------------------------------------------------------------ */

    _isRendererTitle(title) {
        return title && title.startsWith(APPLICATION_ID);
    }

    _initWindowHiding() {
        // 1. Hide from get_window_actors (used by overview, workspaces)
        try {
            this._injectionManager.overrideMethod(
                Shell.Global.prototype, 'get_window_actors',
                originalMethod => {
                    return function () {
                        return originalMethod.call(this).filter(actor => {
                            const win = actor.meta_window || actor.get_meta_window?.();
                            if (!win) return true;
                            const title = win.get_title?.() || win.title;
                            return !(title && title.startsWith(APPLICATION_ID));
                        });
                    };
                }
            );
        } catch (e) { log(`lwpe: get_window_actors override: ${e.message}`); }

        // 2. Hide from Alt+Tab / Ctrl+Alt+Tab
        try {
            this._injectionManager.overrideMethod(
                Meta.Display.prototype, 'get_tab_list',
                originalMethod => {
                    return function (type, workspace) {
                        return originalMethod.call(this, type, workspace).filter(mw => {
                            try {
                                const title = mw.get_title?.() || mw.title;
                                return !(title && title.startsWith(APPLICATION_ID));
                            } catch (e) { return true; }
                        });
                    };
                }
            );
        } catch (e) { log(`lwpe: get_tab_list override: ${e.message}`); }

        // 3. Hide from workspace overview window previews
        try {
            this._injectionManager.overrideMethod(
                Workspace.Workspace.prototype, '_isOverviewWindow',
                originalMethod => {
                    return function (window) {
                        try {
                            const title = window.get_title?.() || window.title;
                            if (title && title.startsWith(APPLICATION_ID)) return false;
                        } catch (e) {}
                        return originalMethod.call(this, window);
                    };
                }
            );
        } catch (e) { log(`lwpe: Workspace._isOverviewWindow: ${e.message}`); }

        // 4. Hide from workspace thumbnails
        try {
            this._injectionManager.overrideMethod(
                WorkspaceThumbnail.WorkspaceThumbnail.prototype, '_isOverviewWindow',
                originalMethod => {
                    return function (window) {
                        try {
                            const title = window.get_title?.() || window.title;
                            if (title && title.startsWith(APPLICATION_ID)) return false;
                        } catch (e) {}
                        return originalMethod.call(this, window);
                    };
                }
            );
        } catch (e) { log(`lwpe: WorkspaceThumbnail._isOverviewWindow: ${e.message}`); }

        log('lwpe: window hiding active');
    }

    /* ------------------------------------------------------------------ */
    /*  App system hiding — prevents dock/taskbar entry                    */
    /* ------------------------------------------------------------------ */

    _initAppSystemHiding() {
        // 1. Prevent renderer windows from being associated with any app.
        //    Without this, Mutter associates the window with an app by
        //    app_id ("linux-wallpaperengine"), which creates a dock entry.
        try {
            this._injectionManager.overrideMethod(
                Shell.WindowTracker.prototype, 'get_window_app',
                originalMethod => {
                    return function (window) {
                        try {
                            const title = window.get_title?.() || window.title;
                            if (title && title.startsWith(APPLICATION_ID)) return null;
                        } catch (e) {}
                        return originalMethod.call(this, window);
                    };
                }
            );
        } catch (e) { log(`lwpe: WindowTracker.get_window_app: ${e.message}`); }

        // 2. Exclude renderer windows from any app's window list
        try {
            const filterWindows = originalMethod => {
                return function () {
                    return originalMethod.call(this).filter(mw => {
                        try {
                            const title = mw.get_title?.() || mw.title;
                            return !(title && title.startsWith(APPLICATION_ID));
                        } catch (e) { return true; }
                    });
                };
            };

            this._injectionManager.overrideMethod(
                Shell.App.prototype, 'get_windows', filterWindows
            );
            this._injectionManager.overrideMethod(
                Shell.App.prototype, 'get_n_windows',
                originalMethod => {
                    return function () {
                        return this.get_windows().length;
                    };
                }
            );
        } catch (e) { log(`lwpe: App.get_windows: ${e.message}`); }

        // 3. Remove apps that have zero (non-renderer) windows from the dock
        try {
            this._injectionManager.overrideMethod(
                Shell.AppSystem.prototype, 'get_running',
                originalMethod => {
                    return function () {
                        return originalMethod.call(this).filter(
                            app => app.get_n_windows() > 0
                        );
                    };
                }
            );
        } catch (e) { log(`lwpe: AppSystem.get_running: ${e.message}`); }

        log('lwpe: app system hiding active');
    }

    /* ------------------------------------------------------------------ */
    /*  Signal connections                                                 */
    /* ------------------------------------------------------------------ */

    _connectWindowSignals() {
        try {
            const id = global.display.connect('window-created', (_display, metaWindow) => {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    const actor = metaWindow.get_compositor_private();
                    if (actor) this._onWindowMapped(metaWindow, actor);
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._signalIds.push({obj: global.display, id});
        } catch (e) {
            log(`lwpe: failed to connect window-created: ${e.message}`);
        }

        try {
            const id = Main.layoutManager.connect('monitors-changed', () => {
                try { Main.layoutManager._updateBackgrounds(); } catch (e) {}
            });
            this._signalIds.push({obj: Main.layoutManager, id});
        } catch (e) {
            log(`lwpe: failed to connect monitors-changed: ${e.message}`);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Cleanup                                                            */
    /* ------------------------------------------------------------------ */

    destroy() {
        this._enabled = false;

        for (const managed of this._wallpapers.values()) {
            managed.destroy();
        }
        this._wallpapers.clear();

        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        for (const {obj, id} of this._signalIds) {
            if (obj && typeof obj.disconnect === 'function') {
                try { obj.disconnect(id); } catch (e) {}
            }
        }
        this._signalIds = [];

        log('lwpe: disabled');
    }
}
