/**
 * The logging brain. Wires dispatcher events -> store + cache.
 * Pure orchestration over the Adapter interface; no Discord/RN imports.
 */

import type { Adapter, RawMessage } from "../adapter/types";
import { AttachmentCache } from "./cache";
import { LogEntry } from "./schema";
import { LogStore } from "./store";

export interface LoggerSettings {
  logDeletes: boolean;
  logEdits: boolean;
  /** Keep deleted messages visible in-chat instead of removing them. */
  keepInChat: boolean;
  /** Proactively cache media for these guild IDs (admin server, etc.). */
  watchedGuilds: string[];
  cacheAttachments: boolean;
}

export class Logger {
  private a: Adapter;
  private store: LogStore;
  private cache: AttachmentCache;
  private settings: LoggerSettings;
  private unpatch: (() => void) | null = null;

  constructor(
    adapter: Adapter,
    store: LogStore,
    cache: AttachmentCache,
    settings: LoggerSettings
  ) {
    this.a = adapter;
    this.store = store;
    this.cache = cache;
    this.settings = settings;
  }

  start() {
    this.unpatch = this.a.patcher.onDispatch((action) => {
      const p = this.a.normalize(action);
      if (!p) return;
      switch (p.type) {
        case "MESSAGE_DELETE":
          this.onDelete(p.channelId, p.id, p.guildId);
          // Swallow the event to keep the message in-chat if configured.
          if (this.settings.keepInChat && this.settings.logDeletes) return false;
          break;
        case "MESSAGE_DELETE_BULK":
          for (const id of p.ids) this.onDelete(p.channelId, id, p.guildId);
          if (this.settings.keepInChat && this.settings.logDeletes) return false;
          break;
        case "MESSAGE_UPDATE":
          this.onUpdate(p.message);
          break;
        case "MESSAGE_CREATE":
          this.onCreate(p.message, p.channelId);
          break;
      }
    });
  }

  stop() {
    this.unpatch?.();
    this.unpatch = null;
    // Best-effort final flush so nothing buffered is lost on unload.
    this.store.flush();
  }

  updateSettings(s: LoggerSettings) {
    this.settings = s;
  }

  private authorName(m?: RawMessage): string | undefined {
    return m?.author?.global_name ?? m?.author?.username;
  }

  private async onDelete(channelId: string, messageId: string, guildId?: string) {
    if (!this.settings.logDeletes) return;
    const msg = this.a.stores.getMessage(channelId, messageId);
    if (!msg) return; // not in client cache; nothing to preserve

    const gid = guildId ?? this.a.stores.getChannelGuildId(channelId);
    const attachments = (msg.attachments ?? []).map((att) =>
      this.cache.descriptorFor(att)
    );

    const entry: LogEntry = {
      schema: 1,
      kind: "deleted",
      messageId,
      channelId,
      guildId: gid,
      authorId: msg.author?.id,
      authorName: this.authorName(msg),
      content: msg.content ?? "",
      sentAt: msg.timestamp ? Date.parse(msg.timestamp) : undefined,
      loggedAt: Date.now(),
      attachments,
    };
    await this.store.append(entry);

    // Race the CDN: try to grab bytes before the deleted URL 404s.
    if (this.settings.cacheAttachments) {
      for (const raw of msg.attachments ?? []) {
        this.cache.capture(messageId, raw).then((path) => {
          if (path) {
            this.store.updateAttachment(channelId, messageId, raw.id, {
              localPath: path,
              cached: true,
            });
          }
        });
      }
    }
  }

  private async onUpdate(message: RawMessage) {
    if (!this.settings.logEdits) return;
    // MESSAGE_UPDATE fires for embeds too; only log real content changes.
    if (typeof message.content !== "string") return;
    const channelId = message.channel_id;
    const gid = this.a.stores.getChannelGuildId(channelId);

    const entry: LogEntry = {
      schema: 1,
      kind: "edited",
      messageId: message.id,
      channelId,
      guildId: gid,
      authorId: message.author?.id,
      authorName: this.authorName(message),
      content: message.content,
      sentAt: message.timestamp ? Date.parse(message.timestamp) : undefined,
      loggedAt: Date.now(),
      revisions: [{ content: message.content, at: Date.now() }],
      attachments: [],
    };
    await this.store.append(entry);
  }

  private onCreate(message: RawMessage, channelId: string) {
    if (!this.settings.cacheAttachments) return;
    const gid =
      message.guild_id ?? this.a.stores.getChannelGuildId(channelId);
    if (!gid || !this.settings.watchedGuilds.includes(gid)) return;
    // Proactive pre-cache; fire and forget.
    for (const raw of message.attachments ?? []) {
      this.cache.capture(message.id, raw);
    }
  }
}
