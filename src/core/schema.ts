/**
 * Persistent log schema. Pure data — no platform dependencies.
 * Versioned so future migrations can transform old logs on read.
 */

export const SCHEMA_VERSION = 1;

export type LogKind = "deleted" | "edited";

export interface CachedAttachment {
  id: string;
  filename: string;
  contentType?: string;
  /** Relative path under the plugin file root, if we captured the bytes. */
  localPath?: string;
  /** Original CDN url — kept for reference even after it 404s. */
  originalUrl?: string;
  size?: number;
  width?: number;
  height?: number;
  /** True once bytes are on disk; false if capture failed/pending. */
  cached: boolean;
}

export interface EditRevision {
  content: string;
  /** ms epoch when we observed this revision. */
  at: number;
}

export interface LogEntry {
  schema: number;
  kind: LogKind;
  messageId: string;
  channelId: string;
  guildId?: string;
  authorId?: string;
  authorName?: string;
  /** For deleted: the last-known content. For edited: the current content. */
  content: string;
  /** Original send time (ms epoch) if known. */
  sentAt?: number;
  /** When we logged the delete/edit (ms epoch). */
  loggedAt: number;
  /** Edit history, oldest first. Only populated for kind==="edited". */
  revisions?: EditRevision[];
  attachments: CachedAttachment[];
}

/** Storage key for a channel's log shard. */
export function shardKey(channelId: string): string {
  return `logs/${channelId}.json`;
}

/** In-memory index entry so the viewer can list channels without loading shards. */
export interface IndexRow {
  channelId: string;
  guildId?: string;
  count: number;
  lastLoggedAt: number;
}

export type LogIndex = Record<string, IndexRow>;
