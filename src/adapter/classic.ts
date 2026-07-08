/**
 * Revenge Classic / Vendetta implementation of the Adapter contract.
 *
 * The runtime API is provided by the client loader as EXTERNAL modules
 * (@vendetta/*), resolved via require() at load time — NOT as a globalThis
 * property. That's the proven mechanism every working plugin uses. The build
 * marks these external so they compile to require("@vendetta/...") calls.
 *
 * Metro *lookups* (findByProps/findByStoreName results) can still legitimately
 * be undefined on a given build, so those stay lazy + guarded; diagnose()
 * reports what resolved so the self-check is meaningful on-device.
 */

import { findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { showToast } from "@vendetta/ui/toasts";

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

// ---- lazy metro lookups ----------------------------------------------------

function lazy<T>(fn: () => T): () => T {
  let cached: T;
  let done = false;
  return () => {
    if (!done) {
      try {
        cached = fn();
      } catch {
        cached = undefined as unknown as T;
      }
      done = true;
    }
    return cached;
  };
}

const MessageStore = lazy<any>(() => findByStoreName("MessageStore"));
const ChannelStore = lazy<any>(() => findByStoreName("ChannelStore"));

// Native file module — method names vary across builds; probe several shapes.
const FileModule = lazy<any>(
  () =>
    findByProps("writeFile", "fileExists", "readFile") ??
    findByProps("writeFile", "readFile") ??
    findByProps("readFile", "writeFile") ??
    findByProps("writeFile")
);

const BUCKET = "documents";
const ROOT = "MessageLoggerRevenge/";

// ---- Stores ----------------------------------------------------------------

const stores: Stores = {
  getMessage(channelId, messageId) {
    try {
      const m = MessageStore()?.getMessage?.(channelId, messageId);
      return m ? (m.toJS ? m.toJS() : m) : undefined;
    } catch {
      return undefined;
    }
  },
  getChannelGuildId(channelId) {
    try {
      return ChannelStore()?.getChannel?.(channelId)?.guild_id ?? undefined;
    } catch {
      return undefined;
    }
  },
};

// ---- Files -----------------------------------------------------------------

const files: FileIO = {
  root: () => ROOT,
  async exists(path) {
    try {
      return await FileModule()?.fileExists?.(`${BUCKET}/${path}`);
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await FileModule()?.readFile?.(`${BUCKET}/${path}`, "utf8");
    } catch {
      return null;
    }
  },
  async writeText(path, data) {
    await FileModule()?.writeFile?.(BUCKET, path, data, "utf8");
  },
  async readBinaryBase64(path) {
    try {
      return await FileModule()?.readFile?.(`${BUCKET}/${path}`, "base64");
    } catch {
      return null;
    }
  },
  async writeBinaryBase64(path, base64) {
    await FileModule()?.writeFile?.(BUCKET, path, base64, "base64");
  },
  async delete(path) {
    try {
      await FileModule()?.removeFile?.(BUCKET, path);
    } catch {
      /* best-effort */
    }
  },
  async mkdirp(path) {
    try {
      await FileModule()?.createDirectory?.(BUCKET, path);
    } catch {
      /* ignore */
    }
  },
  toImageUri(path) {
    let base = "";
    try {
      base = FileModule()?.getConstants?.().DocumentsDirPath ?? "";
    } catch {
      base = "";
    }
    return `file://${base}/${path}`;
  },
};

// ---- KV (plugin storage proxy, with in-memory fallback) --------------------

const memKV: Record<string, unknown> = {};

const kv: KV = {
  get(key, fallback) {
    try {
      if (storage) {
        const v = storage[key];
        return v === undefined ? fallback : v;
      }
    } catch {
      /* fall through */
    }
    return (memKV[key] as any) ?? fallback;
  },
  set(key, value) {
    try {
      if (storage) {
        storage[key] = value;
        return;
      }
    } catch {
      /* fall through */
    }
    memKV[key] = value;
  },
};

// ---- Patcher ---------------------------------------------------------------

const patch: Patcher = {
  onDispatch(handler) {
    try {
      if (!before || !FluxDispatcher) return () => {};
      return before("dispatch", FluxDispatcher, (args: any[]) => {
        const action = args[0];
        const result = handler(action);
        if (result === false) return [];
      });
    } catch {
      return () => {};
    }
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
      showToast?.(msg);
    } catch {
      /* toasts optional */
    }
  },
};

// ---- Navigation ------------------------------------------------------------

const navHelper = lazy<any>(
  () => findByProps("push", "pushLazy") ?? findByProps("push", "pop")
);
const router = lazy<any>(
  () =>
    findByProps("transitionToGuild") ??
    findByProps("transitionTo") ??
    findByProps("openChannel")
);

const nav: Nav = {
  pushScreen(title, component) {
    try {
      navHelper()?.push?.(component, { title, headerTitle: title });
    } catch {
      uiToolkit.showToast("Couldn't open screen — see diagnostics");
    }
  },
  jumpToMessage(channelId, messageId, guildId) {
    try {
      const r = router();
      if (r?.transitionToGuild) {
        r.transitionToGuild(guildId ?? "@me", channelId, messageId);
        return;
      }
      if (r?.transitionTo) {
        const base = `/channels/${guildId ?? "@me"}/${channelId}`;
        r.transitionTo(messageId ? `${base}/${messageId}` : base);
        return;
      }
      if (r?.openChannel) {
        r.openChannel({ channelId, messageId });
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
      const fm = FileModule();
      if (!fm) return ["FileModule: NOT FOUND"];
      const keys = new Set<string>();
      let obj: any = fm;
      while (obj && obj !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(obj)) keys.add(k);
        obj = Object.getPrototypeOf(obj);
      }
      return [...keys]
        .filter((k) => {
          try {
            return typeof fm[k] === "function";
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      return ["FileModule: error"];
    }
  })();

  const documentsDir = (() => {
    try {
      return FileModule()?.getConstants?.().DocumentsDirPath ?? null;
    } catch {
      return null;
    }
  })();

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

  const runtimeSummary = [
    `React: ${!!React}`,
    `ReactNative: ${!!ReactNative}`,
    `FluxDispatcher: ${!!FluxDispatcher}`,
    `patcher.before: ${!!before}`,
    `storage: ${!!storage}`,
  ].join("  ");

  return {
    platform: "revenge-classic",
    fileModuleMethods: [runtimeSummary, ...fileModuleMethods],
    documentsDir,
    storesResolved: { message: !!MessageStore(), channel: !!ChannelStore() },
    navResolved: !!navHelper()?.push,
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
