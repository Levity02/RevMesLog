/**
 * Attachment cache manager.
 *
 * On the desktop MLV2 this needed a localhost server to bridge disk -> DOM.
 * On React Native there's no such wall: we write bytes to the app sandbox and
 * point an <Image> at file://. So this just does capture + eviction.
 *
 * Two capture triggers:
 *   1. Reactive: at delete time, race the CDN before the URL 404s.
 *   2. Proactive: on MESSAGE_CREATE in a watched guild, pre-cache media so a
 *      later delete already has the bytes on disk.
 *
 * Implemented as a factory (not a class): this Hermes build rejects class
 * expressions, so the whole codebase avoids `class` and uses closures.
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

export interface AttachmentCache {
  descriptorFor(att: RawAttachment): CachedAttachment;
  capture(messageId: string, att: RawAttachment): Promise<string | null>;
  imageUri(localPath: string): string;
}

export function createAttachmentCache(
  a: Adapter,
  cfg: CacheConfig
): AttachmentCache {
  const meta = a.kv.get<Record<string, CacheMeta>>(CACHE_INDEX_KEY, {});

  function persistMeta() {
    a.kv.set(CACHE_INDEX_KEY, meta);
  }

  function mediaPath(messageId: string, att: RawAttachment): string {
    const safe = (att.filename ?? att.id).replace(/[^\w.\-]/g, "_");
    return `media/${messageId}_${att.id}_${safe}`;
  }

  async function evictIfNeeded() {
    let total = Object.values(meta).reduce((n, m) => n + m.size, 0);
    if (total <= cfg.maxBytes) return;
    const byAge = Object.values(meta).sort((x, y) => x.lastUsed - y.lastUsed);
    for (const m of byAge) {
      if (total <= cfg.maxBytes) break;
      await a.files.delete(m.path);
      total -= m.size;
      delete meta[m.path];
    }
    persistMeta();
  }

  return {
    descriptorFor(att) {
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
    },

    async capture(messageId, att) {
      const url = att.url ?? att.proxy_url;
      if (!url) return null;
      if (att.size && att.size > cfg.maxFileBytes) return null;

      const path = mediaPath(messageId, att);
      if (meta[path]) {
        meta[path].lastUsed = Date.now();
        persistMeta();
        return path;
      }

      const fetched = await a.net.fetchBase64(url);
      if (!fetched) return null;

      try {
        await a.files.writeBinaryBase64(path, fetched.base64);
      } catch {
        return null;
      }

      // base64 is ~4/3 the byte size; approximate on-disk size.
      const approxBytes = Math.floor((fetched.base64.length * 3) / 4);
      meta[path] = { path, size: approxBytes, lastUsed: Date.now() };
      persistMeta();
      await evictIfNeeded();
      return path;
    },

    imageUri(localPath) {
      return a.files.toImageUri(localPath);
    },
  };
}
