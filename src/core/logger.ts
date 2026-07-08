/**
 * The logging brain. Wires dispatcher events -> store + cache.
 * Pure orchestration over the Adapter interface; no Discord/RN imports.
 *
 * Factory (not a class): Hermes rejects class expressions.
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

export interface Logger {
  start(): void;
  stop(): void;
  updateSettings(s: LoggerSettings): void;
}

export function createLogger(
  a: Adapter,
  store: LogStore,
  cache: AttachmentCache,
  initialSettings: LoggerSettings
): Logger {
  let settings = initialSettings;
  let unpatch: (() => void) | null = null;

  function authorName(m?: RawMessage): string | undefined {
    return m?.author?.global_name ?? m?.author?.username;
  }

  async function onDelete(channelId: string, messageId: string, guildId?: string) {
    if (!settings.logDeletes) return;
    const msg = a.stores.getMessage(channelId, messageId);
    if (!msg) return; // not in client cache; nothing to preserve

    const gid = guildId ?? a.stores.getChannelGuildId(channelId);
    const attachments = (msg.attachments ?? []).map((att) =>
      cache.descriptorFor(att)
    );

    const entry: LogEntry = {
      schema: 1,
      kind: "deleted",
      messageId,
      channelId,
      guildId: gid,
      authorId: msg.author?.id,
      authorName: authorName(msg),
      content: msg.content ?? "",
      sentAt: msg.timestamp ? Date.parse(msg.timestamp) : undefined,
      loggedAt: Date.now(),
      attachments,
    };
    await store.append(entry);

    // Race the CDN: try to grab bytes before the deleted URL 404s.
    if (settings.cacheAttachments) {
      for (const raw of msg.attachments ?? []) {
        cache.capture(messageId, raw).then((path) => {
          if (path) {
            store.updateAttachment(channelId, messageId, raw.id, {
              localPath: path,
              cached: true,
            });
          }
        });
      }
    }
  }

  async function onUpdate(message: RawMessage) {
    if (!settings.logEdits) return;
    // MESSAGE_UPDATE fires for embeds too; only log real content changes.
    if (typeof message.content !== "string") return;
    const channelId = message.channel_id;
    const gid = a.stores.getChannelGuildId(channelId);

    const entry: LogEntry = {
      schema: 1,
      kind: "edited",
      messageId: message.id,
      channelId,
      guildId: gid,
      authorId: message.author?.id,
      authorName: authorName(message),
      content: message.content,
      sentAt: message.timestamp ? Date.parse(message.timestamp) : undefined,
      loggedAt: Date.now(),
      revisions: [{ content: message.content, at: Date.now() }],
      attachments: [],
    };
    await store.append(entry);
  }

  function onCreate(message: RawMessage, channelId: string) {
    if (!settings.cacheAttachments) return;
    const gid = message.guild_id ?? a.stores.getChannelGuildId(channelId);
    if (!gid || !settings.watchedGuilds.includes(gid)) return;
    // Proactive pre-cache; fire and forget.
    for (const raw of message.attachments ?? []) {
      cache.capture(message.id, raw);
    }
  }

  return {
    start() {
      unpatch = a.patcher.onDispatch((action) => {
        const p = a.normalize(action);
        if (!p) return;
        switch (p.type) {
          case "MESSAGE_DELETE":
            onDelete(p.channelId, p.id, p.guildId);
            if (settings.keepInChat && settings.logDeletes) return false;
            break;
          case "MESSAGE_DELETE_BULK":
            for (const id of p.ids) onDelete(p.channelId, id, p.guildId);
            if (settings.keepInChat && settings.logDeletes) return false;
            break;
          case "MESSAGE_UPDATE":
            onUpdate(p.message);
            break;
          case "MESSAGE_CREATE":
            onCreate(p.message, p.channelId);
            break;
        }
      });
    },

    stop() {
      unpatch?.();
      unpatch = null;
      store.flush();
    },

    updateSettings(s) {
      settings = s;
    },
  };
}
