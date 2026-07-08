/**
 * Persistent, sharded log store.
 *
 * - One JSON shard per channel (logs/<channelId>.json) via adapter.files.
 * - A small index in adapter.kv so the viewer lists channels without reading
 *   every shard.
 * - Writes are debounced and coalesced per channel to avoid hammering the
 *   native bridge on bursty deletes (e.g. a bulk purge).
 *
 * Factory (not a class): Hermes rejects class expressions. Closures over the
 * private state below. Depends only on the Adapter interface.
 */

import type { Adapter } from "../adapter/types";
import {
  IndexRow,
  LogEntry,
  LogIndex,
  SCHEMA_VERSION,
  shardKey,
} from "./schema";

const INDEX_KEY = "logIndex";
const FLUSH_MS = 750;

export interface LogStore {
  getIndex(): IndexRow[];
  getChannelLog(channelId: string): Promise<LogEntry[]>;
  append(entry: LogEntry): Promise<void>;
  updateAttachment(
    channelId: string,
    messageId: string,
    attachmentId: string,
    patch: Partial<{ localPath: string; cached: boolean }>
  ): Promise<void>;
  clearChannel(channelId: string): Promise<void>;
  exportChannel(channelId: string): Promise<string>;
  exportChannelToFile(channelId: string): Promise<string>;
  flush(): Promise<void>;
}

export function createLogStore(a: Adapter): LogStore {
  const index = a.kv.get<LogIndex>(INDEX_KEY, {});
  const dirtyChannels = new Set<string>();
  const cache = new Map<string, LogEntry[]>();
  let flushTimer: any = null;

  async function getChannelLog(channelId: string): Promise<LogEntry[]> {
    if (cache.has(channelId)) return cache.get(channelId)!;
    const raw = await a.files.readText(shardKey(channelId));
    let entries: LogEntry[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        entries = []; // corrupt shard — start clean rather than crash the viewer
      }
    }
    cache.set(channelId, entries);
    return entries;
  }

  function touchIndex(channelId: string, guildId?: string) {
    const row = index[channelId] ?? {
      channelId,
      guildId,
      count: 0,
      lastLoggedAt: 0,
    };
    row.count += 1;
    row.lastLoggedAt = Date.now();
    if (guildId) row.guildId = guildId;
    index[channelId] = row;
    a.kv.set(INDEX_KEY, index);
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    const channels = [...dirtyChannels];
    dirtyChannels.clear();
    for (const ch of channels) {
      const list = cache.get(ch) ?? [];
      try {
        await a.files.writeText(shardKey(ch), JSON.stringify(list));
      } catch {
        // re-mark dirty so we retry on next flush rather than lose the write
        dirtyChannels.add(ch);
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => flush(), FLUSH_MS);
  }

  async function exportChannel(channelId: string): Promise<string> {
    const list = await getChannelLog(channelId);
    return JSON.stringify(
      { schema: SCHEMA_VERSION, channelId, exportedAt: Date.now(), entries: list },
      null,
      2
    );
  }

  return {
    getIndex() {
      return Object.values(index).sort((x, y) => y.lastLoggedAt - x.lastLoggedAt);
    },

    getChannelLog,

    async append(entry) {
      entry.schema = SCHEMA_VERSION;
      const list = await getChannelLog(entry.channelId);

      // De-dupe: skip a duplicate delete. For edits, fold new revisions into
      // the existing entry instead of duplicating.
      const existing = list.find(
        (e) => e.messageId === entry.messageId && e.kind === entry.kind
      );
      if (existing) {
        if (entry.kind === "edited") {
          existing.revisions = existing.revisions ?? [];
          const last = existing.revisions[existing.revisions.length - 1];
          if (!last || last.content !== entry.content) {
            existing.revisions.push({ content: entry.content, at: entry.loggedAt });
            existing.content = entry.content;
            existing.loggedAt = entry.loggedAt;
          }
        }
      } else {
        list.unshift(entry); // newest first
      }

      touchIndex(entry.channelId, entry.guildId);
      dirtyChannels.add(entry.channelId);
      scheduleFlush();
    },

    async updateAttachment(channelId, messageId, attachmentId, patch) {
      const list = await getChannelLog(channelId);
      for (const e of list) {
        if (e.messageId !== messageId) continue;
        const att = e.attachments.find((x) => x.id === attachmentId);
        if (att) {
          Object.assign(att, patch);
          dirtyChannels.add(channelId);
          scheduleFlush();
        }
        break;
      }
    },

    async clearChannel(channelId) {
      cache.set(channelId, []);
      dirtyChannels.add(channelId);
      delete index[channelId];
      a.kv.set(INDEX_KEY, index);
      scheduleFlush();
    },

    exportChannel,

    async exportChannelToFile(channelId) {
      const path = `exports/${channelId}_${Date.now()}.json`;
      await a.files.writeText(path, await exportChannel(channelId));
      return path;
    },

    flush,
  };
}
