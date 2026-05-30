/**
 * linux-wallpaperengine GNOME Shell Extension — Wallpaper Manager
 *
 * Core logic:
 *   1. Discovers renderer windows (title starts with @linux-wallpaperengine!)
 *   2. Injects Clutter.Clone actors into GNOME's desktop background
 *   3. Hides renderer windows from overview, Alt+Tab, and dash
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
 * A managed wallpaper window: wraps one renderer window and its Clutter.Clone.
 */
class ManagedWallpaper {
    constructor(metaWindow, windowActor, info) {
        this.metaWindow = metaWindow;
        this.windowActor = windowActor;
        this.info = info;         // {monitor, width, height}
        this._clone = null;       // Clutter.Clone of the window actor
        this._backgroundActor = null;
    }

    /**
     * Create (or re-create) the Clutter.Clone and insert it into the given
     * background actor (the desktop background widget for one monitor).
     */
    inject(backgroundActor) {
        if (!backgroundActor || !this.windowActor) {
            return;
        }

        // Remove previous clone if any
        this.remove();

        // Create a visual clone of the renderer window
        this._clone = new Clutter.Clone({
            source: this.windowActor,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
        });

        // Match the background actor's dimensions
        const width = backgroundActor.width || this.info.width;
        const height = backgroundActor.height || this.info.height;
        this._clone.set_size(width, height);
        this._clone.set_position(0, 0);

        // Add to the background, behind everything else
        backgroundActor.add_child(this._clone);
        this._clone.lower_bottom();

        this._backgroundActor = backgroundActor;

        // Fade in
        this._clone.opacity = 0;
        this._clone.ease({
            opacity: 255,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Remove the clone from the background actor (with fade out).
     */
    remove() {
        if (this._clone) {
            const clone = this._clone;
            this._clone = null;
            clone.ease({
                opacity: 0,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    clone.destroy();
                },
            });
        }
        this._backgroundActor = null;
    }

    /**
     * Destroy immediately (used on disable).
     */
    destroy() {
        if (this._clone) {
            this._clone.destroy();
            this._clone = null;
        }
        this._backgroundActor = null;
        this.metaWindow = null;
        this.windowActor = null;
    }
}

export class WallpaperManager {
    constructor() {
        this._wallpapers = new Map();   // monitorName → ManagedWallpaper
        this._injectionManager = new InjectionManager();
        this._signalIds = [];
        this._enabled = false;

        // Do an initial scan for windows that are already mapped
        this._discoverExistingWindows();

        // Listen for new/destroyed windows
        this._connectWindowSignals();

        // Set up background injection
        this._initBackgroundInjection();

        // Hide renderer windows from UI
        this._initWindowHiding();

        this._enabled = true;
        log('lwpe: enabled');
    }

    /* ------------------------------------------------------------------ */
    /*  Window discovery                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Parse window title for renderer metadata.
     * @returns {{monitor:string, width:number, height:number}|null}
     */
    _parseTitle(title) {
        if (!title || !title.startsWith(APPLICATION_ID)) {
            return null;
        }
        try {
            const jsonStart = title.indexOf('{');
            if (jsonStart === -1) return null;
            const jsonStr = title.substring(jsonStart);
            const info = JSON.parse(jsonStr);
            if (info.monitor) {
                return info;
            }
        } catch (e) {
            log(`lwpe: failed to parse window title: ${e}`);
        }
        return null;
    }

    /**
     * Scan all currently-mapped windows for renderer windows.
     */
    _discoverExistingWindows() {
        const actors = global.get_window_actors();
        for (const actor of actors) {
            const metaWindow = actor.meta_window || actor.get_meta_window();
            if (metaWindow) {
                this._onWindowMapped(metaWindow, actor);
            }
        }
    }

    /**
     * Called when a new window is mapped.
     */
    _onWindowMapped(metaWindow, actor) {
        if (!metaWindow) return;
        const title = metaWindow.get_title();
        const info = this._parseTitle(title);
        if (!info) return;

        const monitorName = info.monitor;
        log(`lwpe: found renderer window for ${monitorName}`);

        // If we already have a wallpaper for this monitor, destroy old one
        if (this._wallpapers.has(monitorName)) {
            const existing = this._wallpapers.get(monitorName);
            existing.destroy();
        }

        const managed = new ManagedWallpaper(metaWindow, actor, info);
        this._wallpapers.set(monitorName, managed);

        // Try to inject into the matching background actor
        this._tryInject(monitorName, managed);
    }

    /**
     * Called when a window is unmapped/destroyed.
     */
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

    /**
     * Monkey-patch BackgroundManager._createBackgroundActor so every
     * newly-created background gets our wallpaper clone injected.
     */
    _initBackgroundInjection() {
        try {
            const self = this;
            this._injectionManager.overrideMethod(
                Background.BackgroundManager.prototype,
                '_createBackgroundActor',
                originalMethod => {
                    return function () {
                        const actor = originalMethod.call(this);
                        // 'this' is the BackgroundManager instance
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

    /**
     * Called after _createBackgroundActor completes.
     * Try to inject the wallpaper for this background manager's monitor.
     */
    _onBackgroundCreated(bgManager, backgroundActor) {
        if (!this._enabled) return;

        const monitorName = this._getMonitorName(bgManager);
        if (!monitorName) return;

        const managed = this._wallpapers.get(monitorName);
        if (managed) {
            log(`lwpe: injecting wallpaper into ${monitorName} background`);
            managed.inject(backgroundActor);
        }
    }

    /**
     * Try to find the right background manager for a monitor and inject.
     */
    _tryInject(monitorName, managed) {
        try {
            // Walk the background group managers to find one for this monitor
            const groups = Main.backgroundGroup?._backgroundGroupManagers || [];
            for (const bgGroup of groups) {
                const mgr = bgGroup._bgManager;
                if (!mgr) continue;
                const name = this._getMonitorName(mgr);
                if (name === monitorName) {
                    const actor = mgr.actor || mgr._bgWidget;
                    if (actor) {
                        managed.inject(actor);
                        return;
                    }
                }
            }
        } catch (e) {
            // Background group not yet initialized
        }
    }

    /**
     * Get the monitor connector name from a BackgroundManager instance.
     */
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

            // Get first physical monitor in this logical monitor
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
    /*  Window hiding from UI                                              */
    /* ------------------------------------------------------------------ */

    _isRendererWindow(metaWindow) {
        if (!metaWindow) return false;
        try {
            const title = metaWindow.get_title ? metaWindow.get_title() : metaWindow.title;
            return title && title.startsWith(APPLICATION_ID);
        } catch (e) {
            return false;
        }
    }

    _initWindowHiding() {
        // 1. Hide from get_window_actors (used by overview, workspaces)
        try {
            this._injectionManager.overrideMethod(
                Shell.Global.prototype,
                'get_window_actors',
                originalMethod => {
                    return function () {
                        return originalMethod.call(this).filter(
                            actor => {
                                const win = actor.meta_window || actor.get_meta_window?.();
                                if (!win) return true;
                                const title = win.get_title?.() || win.title;
                                return !(title && title.startsWith(APPLICATION_ID));
                            }
                        );
                    };
                }
            );
        } catch (e) {
            log(`lwpe: failed to override get_window_actors: ${e.message}`);
        }

        // 2. Hide from Alt+Tab / Ctrl+Alt+Tab
        try {
            this._injectionManager.overrideMethod(
                Meta.Display.prototype,
                'get_tab_list',
                originalMethod => {
                    return function (type, workspace) {
                        const list = originalMethod.call(this, type, workspace);
                        return list.filter(mw => {
                            try {
                                const title = mw.get_title?.() || mw.title;
                                return !(title && title.startsWith(APPLICATION_ID));
                            } catch (e) {
                                return true;
                            }
                        });
                    };
                }
            );
        } catch (e) {
            log(`lwpe: failed to override get_tab_list: ${e.message}`);
        }

        // 3. Hide from workspace overview window previews
        try {
            this._injectionManager.overrideMethod(
                Workspace.Workspace.prototype,
                '_isOverviewWindow',
                originalMethod => {
                    return function (window) {
                        try {
                            const title = window.get_title?.() || window.title;
                            if (title && title.startsWith(APPLICATION_ID)) {
                                return false;
                            }
                        } catch (e) {
                            // fall through
                        }
                        return originalMethod.call(this, window);
                    };
                }
            );
        } catch (e) {
            log(`lwpe: failed to override Workspace._isOverviewWindow: ${e.message}`);
        }

        // 4. Hide from workspace thumbnails
        try {
            this._injectionManager.overrideMethod(
                WorkspaceThumbnail.WorkspaceThumbnail.prototype,
                '_isOverviewWindow',
                originalMethod => {
                    return function (window) {
                        try {
                            const title = window.get_title?.() || window.title;
                            if (title && title.startsWith(APPLICATION_ID)) {
                                return false;
                            }
                        } catch (e) {
                            // fall through
                        }
                        return originalMethod.call(this, window);
                    };
                }
            );
        } catch (e) {
            log(`lwpe: failed to override WorkspaceThumbnail._isOverviewWindow: ${e.message}`);
        }

        log('lwpe: window hiding active');
    }

    /* ------------------------------------------------------------------ */
    /*  Signal connections                                                 */
    /* ------------------------------------------------------------------ */

    _connectWindowSignals() {
        // Listen for new windows
        try {
            const id = global.display.connect('window-created', (_display, metaWindow) => {
                // Delay slightly to let the window actor be created
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    const actor = metaWindow.get_compositor_private();
                    if (actor) {
                        this._onWindowMapped(metaWindow, actor);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            });
            this._signalIds.push({obj: global.display, id});
        } catch (e) {
            log(`lwpe: failed to connect window-created: ${e.message}`);
        }

        // Listen for monitors-changed
        try {
            const id = Main.layoutManager.connect('monitors-changed', () => {
                // Re-trigger background injection for new/updated monitors
                try {
                    Main.layoutManager._updateBackgrounds();
                } catch (e) {
                    log(`lwpe: failed to update backgrounds: ${e.message}`);
                }
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

        // Destroy all managed wallpapers
        for (const managed of this._wallpapers.values()) {
            managed.destroy();
        }
        this._wallpapers.clear();

        // Restore all overridden methods
        if (this._injectionManager) {
            this._injectionManager.clear();
            this._injectionManager = null;
        }

        // Disconnect signals
        for (const {obj, id} of this._signalIds) {
            if (obj && typeof obj.disconnect === 'function') {
                try {
                    obj.disconnect(id);
                } catch (e) {
                    // Signal may have already been disconnected
                }
            }
        }
        this._signalIds = [];

        log('lwpe: disabled');
    }
}
