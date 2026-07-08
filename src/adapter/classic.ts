/**
 * Revenge Classic / Vendetta implementation of the Adapter contract.
 *
 * This is the ONLY file that touches the client-mod runtime. Everything here is
 * resolved LAZILY and DEFENSIVELY:
 *   - The runtime object is read as `globalThis.vendetta` (a safe property read
 *     that yields undefined if absent) rather than a bare `vendetta` identifier
 *     (which throws a ReferenceError at module-eval time and silently bricks the
 *     whole plugin).
 *   - Every metro/store/common lookup is deferred until first use and wrapped so
 *     a missing piece degrades gracefully instead of taking down the plugin.
 *   - diagnose() reports exactly what resolved, so a broken build is readable
 *     on-device via the self-check instead of an inert card.
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

// ---- safe, memoized resolution of the runtime ------------------------------

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

// Read the runtime object without risking a ReferenceError.
const V = lazy<any>(() => (globalThis as any).vendetta);

const metro = lazy<any>(() => V()?.metro);
const common = lazy<any>(() => metro()?.common);
const patcherMod = lazy<any>(() => V()?.patcher);
// Plugin storage lives under different names across forks; try the known ones.
const storageMod = lazy<any>(() => V()?.storage ?? V()?.plugin?.storage);
const uiMod = lazy<any>(() => V()?.ui);

const findByProps = (...names: string[]): any => {
  try {
    return metro()?.findByProps?.(...names);
  } catch {
    return undefined;
  }
};
const findByStoreName = (name: string): any => {
  try {
    return metro()?.findByStoreName?.(name);
  } catch {
    return undefined;
  }
};

const MessageStore = lazy<any>(() => findByStoreName("MessageStore"));
const ChannelStore = lazy<any>(() => findByStoreName("ChannelStore"));
const FluxDispatcher = lazy<any>(
  () => common()?.FluxDispatcher ?? findByProps("dispatch", "subscribe")
);
const ReactRef = lazy<any>(() => common()?.React);
const ReactNativeRef = lazy<any>(() => common()?.ReactNative);

// Native file module — names vary across builds; probe several shapes.
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

// ---- KV (Vendetta storage proxy, with in-memory fallback) ------------------

// If the storage proxy isn't available, fall back to a session-only object so
// the plugin still runs (it just won't persist until we wire storage correctly).
const memKV: Record<string, unknown> = {};

const kv: KV = {
  get(key, fallback) {
    try {
      const s = storageMod();
      if (s) {
        const v = s[key];
        return v === undefined ? fallback : v;
      }
    } catch {
      /* fall through to memory */
    }
    return (memKV[key] as any) ?? fallback;
  },
  set(key, value) {
    try {
      const s = storageMod();
      if (s) {
        s[key] = value;
        return;
      }
    } catch {
      /* fall through to memory */
    }
    memKV[key] = value;
  },
};

// ---- Patcher ---------------------------------------------------------------

const patch: Patcher = {
  onDispatch(handler) {
    try {
      const p = patcherMod();
      const fd = FluxDispatcher();
      if (!p?.before || !fd) return () => {};
      return p.before("dispatch", fd, (args: any[]) => {
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

// Getters so destructuring in the UI factories resolves at call time (by which
// point the runtime is initialized), not at module-eval time.
const uiToolkit: UIToolkit = {
  get React() {
    return ReactRef();
  },
  get ReactNative() {
    return ReactNativeRef();
  },
  showToast(msg) {
    try {
      uiMod()?.toasts?.showToast?.(msg);
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
  const vendettaKeys = (() => {
    try {
      const v = V();
      return v ? Object.keys(v) : [];
    } catch {
      return [];
    }
  })();

  const fileModuleMethods = (() => {
    try {
      const fm = FileModule();
      if (!fm) return [];
      const keys = new Set<string>();
      let obj: any = fm;
      while (obj && obj !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(obj)) keys.add(k);
        obj = Object.getPrototypeOf(obj);
      }
      return [...keys].filter((k) => {
        try {
          return typeof fm[k] === "function";
        } catch {
          return false;
        }
      }).sort();
    } catch {
      return [];
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

  return {
    platform: "revenge-classic",
    // Reuse fileModuleMethods to also carry the vendetta-global summary in the
    // first entry, so the self-check surfaces whether the runtime was found.
    fileModuleMethods:
      vendettaKeys.length > 0
        ? [`vendetta global keys: ${vendettaKeys.join(", ")}`, ...fileModuleMethods]
        : ["vendetta global: NOT FOUND", ...fileModuleMethods],
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
