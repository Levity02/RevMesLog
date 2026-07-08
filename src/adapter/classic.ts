/**
 * Revenge Classic / Vendetta implementation of the Adapter contract.
 *
 * This is the ONLY file in the plugin that reads from `vendetta.*` and the
 * native module registry. When porting to Next, clone this file as next.ts and
 * reimplement each member against the new API.
 */

import type {
  Adapter,
  Diagnostics,
  FileIO,
  KV,
  Nav,
  Net,
  Patcher,
  Stores,
  UIToolkit,
  RawMessage,
} from "./types";

// Vendetta globals are injected at runtime; declare loosely.
declare const vendetta: any;

const {
  metro: { findByStoreName, findByProps, common },
  patcher,
  storage,
  ui,
} = vendetta;

const { React, ReactNative } = common;
const { FluxDispatcher, Constants } = common;

// Native FileModule — same bridge Revenge uses for its own loader config.
const FileModule =
  findByProps("writeFile", "fileExists", "readFile") ??
  findByProps("writeFile", "readFile");

const PLUGIN_DIR = "MessageLoggerRevenge";
// Vendetta's file APIs are rooted at the app documents dir; we namespace under it.
const ROOT = `${PLUGIN_DIR}/`;

// ---- Stores ----------------------------------------------------------------

const MessageStore = findByStoreName("MessageStore");
const ChannelStore = findByStoreName("ChannelStore");

const stores: Stores = {
  getMessage(channelId, messageId) {
    try {
      const m = MessageStore.getMessage(channelId, messageId);
      return m ? (m.toJS ? m.toJS() : m) : undefined;
    } catch {
      return undefined;
    }
  },
  getChannelGuildId(channelId) {
    try {
      return ChannelStore.getChannel(channelId)?.guild_id ?? undefined;
    } catch {
      return undefined;
    }
  },
};

// ---- Files -----------------------------------------------------------------

// "documents" is the storage bucket constant FileModule expects on Android.
const BUCKET = "documents";

const files: FileIO = {
  root: () => ROOT,
  async exists(path) {
    try {
      return await FileModule.fileExists(`${BUCKET}/${path}`);
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await FileModule.readFile(`${BUCKET}/${path}`, "utf8");
    } catch {
      return null;
    }
  },
  async writeText(path, data) {
    await FileModule.writeFile(BUCKET, path, data, "utf8");
  },
  async readBinaryBase64(path) {
    try {
      return await FileModule.readFile(`${BUCKET}/${path}`, "base64");
    } catch {
      return null;
    }
  },
  async writeBinaryBase64(path, base64) {
    // base64 through the bridge avoids UTF-8 mangling of binary data.
    await FileModule.writeFile(BUCKET, path, base64, "base64");
  },
  async delete(path) {
    try {
      await FileModule.removeFile?.(BUCKET, path);
    } catch {
      /* best-effort */
    }
  },
  async mkdirp(path) {
    // Most FileModule impls create parent dirs on write; this is a no-op guard.
    try {
      await FileModule.createDirectory?.(BUCKET, path);
    } catch {
      /* ignore */
    }
  },
  toImageUri(path) {
    // FileModule exposes the documents dir path; RN can load file:// from it.
    const base = FileModule.getConstants?.().DocumentsDirPath ?? "";
    return `file://${base}/${path}`;
  },
};

// ---- KV (Vendetta storage proxy: auto-persisted JSON) ----------------------

const kv: KV = {
  get(key, fallback) {
    const v = storage[key];
    return v === undefined ? fallback : v;
  },
  set(key, value) {
    storage[key] = value;
  },
};

// ---- Patcher ---------------------------------------------------------------

const patch: Patcher = {
  onDispatch(handler) {
    // `before` lets us inspect and optionally cancel by returning [].
    return patcher.before("dispatch", FluxDispatcher, (args: any[]) => {
      const action = args[0];
      const result = handler(action);
      if (result === false) return []; // swallow: replace args with empty
    });
  },
};

// ---- Net -------------------------------------------------------------------

const net: Net = {
  async fetchBase64(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? undefined;
      const buf = await res.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + chunk) as unknown as number[]
        );
      }
      // btoa is available in the Hermes/RN runtime via polyfill.
      const base64 = (globalThis as any).btoa(binary);
      return { base64, contentType };
    } catch {
      return null;
    }
  },
};

// ---- UI --------------------------------------------------------------------

const uiToolkit: UIToolkit = {
  React,
  ReactNative,
  showToast(msg) {
    try {
      ui.toasts.showToast(msg);
    } catch {
      /* toasts optional */
    }
  },
};

// ---- Navigation ------------------------------------------------------------

// Resolve navigation helpers once. Names drift across builds, so we probe a
// few known shapes and fall back gracefully.
const Navigation = findByProps("push", "pushLazy") ?? findByProps("push", "pop");
const Router =
  findByProps("transitionToGuild") ??
  findByProps("transitionTo") ??
  findByProps("openChannel");

const nav: Nav = {
  pushScreen(title, component) {
    try {
      Navigation?.push?.(component, { title, headerTitle: title });
    } catch {
      uiToolkit.showToast("Couldn't open screen — see diagnostics");
    }
  },
  jumpToMessage(channelId, messageId, guildId) {
    try {
      if (Router?.transitionToGuild) {
        // guildId "@me" for DMs; Discord accepts the literal for DM channels.
        Router.transitionToGuild(guildId ?? "@me", channelId, messageId);
        return;
      }
      if (Router?.transitionTo) {
        const base = `/channels/${guildId ?? "@me"}/${channelId}`;
        Router.transitionTo(messageId ? `${base}/${messageId}` : base);
        return;
      }
      if (Router?.openChannel) {
        Router.openChannel({ channelId, messageId });
        return;
      }
      uiToolkit.showToast("No navigation route available");
    } catch {
      uiToolkit.showToast("Jump failed — see diagnostics");
    }
  },
};

// ---- Diagnostics -----------------------------------------------------------

async function diagnose(): Promise<Diagnostics> {
  const fileModuleMethods = (() => {
    try {
      const keys = new Set<string>();
      let obj = FileModule;
      while (obj && obj !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(obj)) keys.add(k);
        obj = Object.getPrototypeOf(obj);
      }
      return [...keys].filter((k) => typeof (FileModule as any)[k] === "function").sort();
    } catch {
      return [];
    }
  })();

  const documentsDir = (() => {
    try {
      return FileModule.getConstants?.().DocumentsDirPath ?? null;
    } catch {
      return null;
    }
  })();

  // Round-trip a tiny file to confirm the write/read path names are right.
  let fileRoundTripOK: boolean | null = null;
  try {
    const probe = `${ROOT}.probe`;
    await files.writeText(probe, "ok");
    const back = await files.readText(probe);
    fileRoundTripOK = back === "ok";
    await files.delete(probe);
  } catch {
    fileRoundTripOK = false;
  }

  return {
    platform: "revenge-classic",
    fileModuleMethods,
    documentsDir,
    storesResolved: { message: !!MessageStore, channel: !!ChannelStore },
    navResolved: !!(Navigation?.push),
    fileRoundTripOK,
  };
}

// ---- normalize -------------------------------------------------------------

function normalize(action: any) {
  if (!action || typeof action.type !== "string") return null;
  switch (action.type) {
    case "MESSAGE_DELETE":
      return {
        type: "MESSAGE_DELETE" as const,
        id: action.id,
        channelId: action.channelId,
        guildId: action.guildId,
      };
    case "MESSAGE_DELETE_BULK":
      return {
        type: "MESSAGE_DELETE_BULK" as const,
        ids: action.ids ?? [],
        channelId: action.channelId,
        guildId: action.guildId,
      };
    case "MESSAGE_UPDATE":
      if (!action.message?.id) return null;
      return { type: "MESSAGE_UPDATE" as const, message: action.message as RawMessage };
    case "MESSAGE_CREATE":
      if (!action.message?.id) return null;
      return {
        type: "MESSAGE_CREATE" as const,
        message: action.message as RawMessage,
        channelId: action.channelId,
      };
    default:
      return null;
  }
}

export const adapter: Adapter = {
  platform: "revenge-classic",
  stores,
  files,
  kv,
  patcher: patch,
  net,
  ui: uiToolkit,
  nav,
  diagnose,
  normalize,
};
