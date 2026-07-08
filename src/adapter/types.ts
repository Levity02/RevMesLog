/**
 * Platform adapter contract.
 *
 * Everything that touches Discord internals, the RN bridge, or the client-mod
 * runtime lives behind this interface. The core (logger, store, cache, schema)
 * and the UI depend ONLY on this contract — never on `vendetta.*` directly.
 *
 * To port to Revenge Next later, write a second file that implements Adapter
 * against the Next API and swap which one src/index.ts imports. Nothing in
 * core/ or ui/ should need to change.
 */

// ---- Discord dispatch shapes (the subset we care about) --------------------

export interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: { id: string; username?: string; global_name?: string | null };
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: RawAttachment[];
  [k: string]: unknown;
}

export interface RawAttachment {
  id: string;
  filename?: string;
  url?: string;
  proxy_url?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

export type DispatchType =
  | "MESSAGE_DELETE"
  | "MESSAGE_DELETE_BULK"
  | "MESSAGE_UPDATE"
  | "MESSAGE_CREATE";

export interface DeletePayload {
  type: "MESSAGE_DELETE";
  id: string;
  channelId: string;
  guildId?: string;
}
export interface DeleteBulkPayload {
  type: "MESSAGE_DELETE_BULK";
  ids: string[];
  channelId: string;
  guildId?: string;
}
export interface UpdatePayload {
  type: "MESSAGE_UPDATE";
  message: RawMessage;
}
export interface CreatePayload {
  type: "MESSAGE_CREATE";
  message: RawMessage;
  channelId: string;
}

// ---- Store access ----------------------------------------------------------

export interface Stores {
  /** Full message record from the client cache, or undefined if evicted. */
  getMessage(channelId: string, messageId: string): RawMessage | undefined;
  getChannelGuildId(channelId: string): string | undefined;
}

// ---- File IO (native bridge) ----------------------------------------------

/**
 * A minimal file API backed by the client's native FileModule.
 * `writeBinary`/`readBinary` deal in base64 so binary attachments survive the
 * JS<->native bridge intact — this is the mobile analogue of the desktop
 * fs-shim corruption fix, handled correctly at the source.
 */
export interface FileIO {
  /** Root directory the plugin may write to, already suffixed with a slash. */
  root(): string;
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, data: string): Promise<void>;
  readBinaryBase64(path: string): Promise<string | null>;
  writeBinaryBase64(path: string, base64: string): Promise<void>;
  delete(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  /** URI usable as an RN <Image> source, e.g. file:///.../foo.png */
  toImageUri(path: string): string;
}

// ---- Small persistent KV (for index/metadata, not bulk logs) ---------------

export interface KV {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

// ---- Patcher ---------------------------------------------------------------

export type Unpatch = () => void;

export interface Patcher {
  /** Patch FluxDispatcher.dispatch. Handler runs before the original dispatch.
   *  Return `false` from the handler to swallow the event (keep msg in-chat). */
  onDispatch(handler: (action: any) => boolean | void): Unpatch;
}

// ---- Network ---------------------------------------------------------------

export interface Net {
  /** Fetch a URL to base64. Used to race the CDN before a deleted URL 404s. */
  fetchBase64(url: string): Promise<{ base64: string; contentType?: string } | null>;
}

// ---- Navigation ------------------------------------------------------------

export interface Nav {
  /** Push a full-screen component onto Discord's navigation stack. */
  pushScreen(title: string, component: any): void;
  /** Navigate to a channel and (if given) scroll to a specific message. */
  jumpToMessage(channelId: string, messageId?: string, guildId?: string): void;
}

// ---- Diagnostics -----------------------------------------------------------

/** Runtime self-check output, so the on-device surface can be verified without
 *  a desktop debugger. Every field is best-effort and never throws. */
export interface Diagnostics {
  platform: string;
  fileModuleMethods: string[];
  documentsDir: string | null;
  storesResolved: { message: boolean; channel: boolean };
  navResolved: boolean;
  fileRoundTripOK: boolean | null;
}

// ---- UI toolkit refs -------------------------------------------------------

/** React / RN / component-library handles the UI layer needs, resolved once. */
export interface UIToolkit {
  React: any;
  ReactNative: any;
  showToast(msg: string): void;
}

// ---- The adapter -----------------------------------------------------------

export interface Adapter {
  platform: "revenge-classic" | "revenge-next";
  stores: Stores;
  files: FileIO;
  kv: KV;
  patcher: Patcher;
  net: Net;
  ui: UIToolkit;
  nav: Nav;
  /** Run a best-effort self-check of the runtime surface. */
  diagnose(): Promise<Diagnostics>;
  /** Normalize a raw dispatch action into a typed payload we understand. */
  normalize(
    action: any
  ):
    | DeletePayload
    | DeleteBulkPayload
    | UpdatePayload
    | CreatePayload
    | null;
}
