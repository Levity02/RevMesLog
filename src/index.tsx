/**
 * Plugin entry point.
 *
 * This is the ONLY place platform choice is made: import the Classic adapter,
 * build the core against its interface, and expose the Vendetta lifecycle
 * hooks. To move to Next, swap the one import below for ./adapter/next.
 */

import { adapter } from "./adapter/classic";
import { createLogger, LoggerSettings } from "./core/logger";
import { createLogStore } from "./core/store";
import { createAttachmentCache } from "./core/cache";
import { makeLogViewer } from "./ui/LogViewer";
import { makeSettings } from "./ui/Settings";

const SETTINGS_KEY = "settings";

const DEFAULT_SETTINGS: LoggerSettings = {
  logDeletes: true,
  logEdits: true,
  keepInChat: false,
  watchedGuilds: [],
  cacheAttachments: true,
};

// ---- wiring ----------------------------------------------------------------

const store = createLogStore(adapter);
const cache = createAttachmentCache(adapter, {
  maxBytes: 512 * 1024 * 1024, // 512 MB LRU ceiling; tune per device
  maxFileBytes: 64 * 1024 * 1024, // skip anything over 64 MB
});

function loadSettings(): LoggerSettings {
  return adapter.kv.get<LoggerSettings>(SETTINGS_KEY, DEFAULT_SETTINGS);
}
function saveSettings(s: LoggerSettings) {
  adapter.kv.set(SETTINGS_KEY, s);
  logger.updateSettings(s);
}

const logger = createLogger(adapter, store, cache, loadSettings());

const LogViewer = makeLogViewer(adapter, store, cache);
const openViewer = () => adapter.nav.pushScreen("Message Log", LogViewer);

const Settings = makeSettings(adapter, loadSettings, saveSettings, openViewer);

// ---- Vendetta lifecycle ----------------------------------------------------

// The Revenge/Vendetta loader reads a plugin's DEFAULT export as the instance:
// an object with onLoad/onUnload (and optional settings). Named exports don't
// register — the loader finds no instance, which is why the toggle/settings go
// inert. So everything the client calls lives on this one default-exported object.
export default {
  onLoad() {
    logger.start();
    // Diagnostic: surface whether the runtime modules resolved, via channels
    // that work even if the settings screen doesn't — a toast and the debug log.
    try {
      adapter
        .diagnose()
        .then((d) => {
          const summary = d.fileModuleMethods[0] ?? "(no summary)";
          adapter.ui.showToast(`MLR loaded — ${summary}`);
          console.log("[MessageLoggerRevenge] diagnose:", JSON.stringify(d));
        })
        .catch((e) => {
          console.log("[MessageLoggerRevenge] diagnose failed:", String(e));
        });
    } catch (e) {
      console.log("[MessageLoggerRevenge] onLoad diagnostic error:", String(e));
    }
  },
  onUnload() {
    logger.stop();
  },
  // Rendered on the plugin's settings page.
  settings: Settings,
};
