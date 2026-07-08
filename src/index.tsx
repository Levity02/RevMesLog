/**
 * Plugin entry point.
 *
 * This is the ONLY place platform choice is made: import the Classic adapter,
 * build the core against its interface, and expose the Vendetta lifecycle
 * hooks. To move to Next, swap the one import below for ./adapter/next.
 */

import { adapter } from "./adapter/classic";
import { Logger, LoggerSettings } from "./core/logger";
import { LogStore } from "./core/store";
import { AttachmentCache } from "./core/cache";
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

const store = new LogStore(adapter);
const cache = new AttachmentCache(adapter, {
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

const logger = new Logger(adapter, store, cache, loadSettings());

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
  },
  onUnload() {
    logger.stop();
  },
  // Rendered on the plugin's settings page.
  settings: Settings,
};
