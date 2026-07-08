/**
 * Persistent, sharded log store.
 *
 * - One JSON shard per channel (logs/<channelId>.json) via adapter.files.
 * - A small index in adapter.kv so the viewer lists channels without reading
 *   every shard.
 * - Writes are debounced and coalesced per channel to avoid hammering the
 *   native bridge on bursty deletes (e.g. a bulk purge).
 *
 * Depends only on the Adapter interface — no Discord/RN imports.
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

export class LogStore {
  private a: Adapter;
  private index: LogIndex;
  private dirtyChannels = new Set<string>();
  private cache = new Map<string, LogEntry[]>();
  private flushTimer: any = null;

  constructor(adapter: Adapter) {
    this.a = adapter;
    this.index = this.a.kv.get<LogIndex>(INDEX_KEY, {});
  }

  getIndex(): IndexRow[] {
    return Object.values(this.index).sort(
      (x, y) => y.lastLoggedAt - x.lastLoggedAt
    );
  }

  async getChannelLog(channelId: string): Promise<LogEntry[]> {
    if (this.cache.has(channelId)) return this.cache.get(channelId)!;
    const raw = await this.a.files.readText(shardKey(channelId));
    let entries: LogEntry[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        entries = []; // corrupt shard — start clean rather than crash the viewer
      }
    }
    this.cache.set(channelId, entries);
    return entries;
  }

  async append(entry: LogEntry): Promise<void> {
    entry.schema = SCHEMA_VERSION;
    const list = await this.getChannelLog(entry.channelId);

    // De-dupe: if we already logged this exact delete, skip. For edits we
    // fold new revisions into the existing entry instead of duplicating.
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

    this.touchIndex(entry.channelId, entry.guildId);
    this.dirtyChannels.add(entry.channelId);
    this.scheduleFlush();
  }

  /** Patch an attachment record in place once its bytes finish caching. */
  async updateAttachment(
    channelId: string,
    messageId: string,
    attachmentId: string,
    patch: Partial<{ localPath: string; cached: boolean }>
  ): Promise<void> {
    const list = await this.getChannelLog(channelId);
    for (const e of list) {
      if (e.messageId !== messageId) continue;
      const att = e.attachments.find((x) => x.id === attachmentId);
      if (att) {
        Object.assign(att, patch);
        this.dirtyChannels.add(channelId);
        this.scheduleFlush();
      }
      break;
    }
  }

  async clearChannel(channelId: string): Promise<void> {
    this.cache.set(channelId, []);
    this.dirtyChannels.add(channelId);
    delete this.index[channelId];
    this.a.kv.set(INDEX_KEY, this.index);
    this.scheduleFlush();
  }

  /** Serialize a channel's log to a pretty JSON string for export/backup. */
  async exportChannel(channelId: string): Promise<string> {
    const list = await this.getChannelLog(channelId);
    return JSON.stringify(
      { schema: SCHEMA_VERSION, channelId, exportedAt: Date.now(), entries: list },
      null,
      2
    );
  }

  /** Write a channel export to a file and return its path (under the root). */
  async exportChannelToFile(channelId: string): Promise<string> {
    const path = `exports/${channelId}_${Date.now()}.json`;
    await this.a.files.writeText(path, await this.exportChannel(channelId));
    return path;
  }

  private touchIndex(channelId: string, guildId?: string) {
    const row = this.index[channelId] ?? {
      channelId,
      guildId,
      count: 0,
      lastLoggedAt: 0,
    };
    row.count += 1;
    row.lastLoggedAt = Date.now();
    if (guildId) row.guildId = guildId;
    this.index[channelId] = row;
    this.a.kv.set(INDEX_KEY, this.index);
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  async flush(): Promise<void> {
    this.flushTimer = null;
    const channels = [...this.dirtyChannels];
    this.dirtyChannels.clear();
    for (const ch of channels) {
      const list = this.cache.get(ch) ?? [];
      try {
        await this.a.files.writeText(shardKey(ch), JSON.stringify(list));
      } catch {
        // re-mark dirty so we retry on next flush rather than lose the write
        this.dirtyChannels.add(ch);
      }
    }
  }
}
