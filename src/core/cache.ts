/**
 * Attachment cache manager.
 *
 * On the desktop MLV2 this needed a localhost server to bridge disk -> DOM.
 * On React Native there's no such wall: we write bytes to the app sandbox and
 * point an <Image> at file://. So this class just does capture + eviction.
 *
 * Two capture triggers:
 *   1. Reactive: at delete time, race the CDN before the URL 404s.
 *   2. Proactive: on MESSAGE_CREATE in a watched guild, pre-cache media so a
 *      later delete already has the bytes on disk.
 *
 * Depends only on the Adapter interface.
 */

import type { Adapter, RawAttachment } from "../adapter/types";
import { CachedAttachment } from "./schema";

export interface CacheConfig {
  /** Max total bytes of cached media before LRU eviction kicks in. */
  maxBytes: number;
  /** Skip files bigger than this (bytes). */
  maxFileBytes: number;
}

interface CacheMeta {
  path: string;
  size: number;
  lastUsed: number;
}

const CACHE_INDEX_KEY = "attachmentCacheIndex";

export class AttachmentCache {
  private a: Adapter;
  private cfg: CacheConfig;
  private meta: Record<string, CacheMeta>;

  constructor(adapter: Adapter, cfg: CacheConfig) {
    this.a = adapter;
    this.cfg = cfg;
    this.meta = this.a.kv.get<Record<string, CacheMeta>>(CACHE_INDEX_KEY, {});
  }

  private mediaPath(messageId: string, att: RawAttachment): string {
    const safe = (att.filename ?? att.id).replace(/[^\w.\-]/g, "_");
    return `media/${messageId}_${att.id}_${safe}`;
  }

  descriptorFor(att: RawAttachment): CachedAttachment {
    return {
      id: att.id,
      filename: att.filename ?? att.id,
      contentType: att.content_type,
      originalUrl: att.url ?? att.proxy_url,
      size: att.size,
      width: att.width,
      height: att.height,
      cached: false,
    };
  }

  /**
   * Attempt to fetch+persist an attachment. Returns the local path on success.
   * Safe to call repeatedly; skips work if already cached.
   */
  async capture(
    messageId: string,
    att: RawAttachment
  ): Promise<string | null> {
    const url = att.url ?? att.proxy_url;
    if (!url) return null;
    if (att.size && att.size > this.cfg.maxFileBytes) return null;

    const path = this.mediaPath(messageId, att);
    if (this.meta[path]) {
      this.meta[path].lastUsed = Date.now();
      this.persistMeta();
      return path;
    }

    const fetched = await this.a.net.fetchBase64(url);
    if (!fetched) return null;

    try {
      await this.a.files.writeBinaryBase64(path, fetched.base64);
    } catch {
      return null;
    }

    // base64 is ~4/3 the byte size; approximate on-disk size.
    const approxBytes = Math.floor((fetched.base64.length * 3) / 4);
    this.meta[path] = { path, size: approxBytes, lastUsed: Date.now() };
    this.persistMeta();
    await this.evictIfNeeded();
    return path;
  }

  imageUri(localPath: string): string {
    return this.a.files.toImageUri(localPath);
  }

  private async evictIfNeeded() {
    let total = Object.values(this.meta).reduce((n, m) => n + m.size, 0);
    if (total <= this.cfg.maxBytes) return;
    const byAge = Object.values(this.meta).sort((x, y) => x.lastUsed - y.lastUsed);
    for (const m of byAge) {
      if (total <= this.cfg.maxBytes) break;
      await this.a.files.delete(m.path);
      total -= m.size;
      delete this.meta[m.path];
    }
    this.persistMeta();
  }

  private persistMeta() {
    this.a.kv.set(CACHE_INDEX_KEY, this.meta);
  }
}
