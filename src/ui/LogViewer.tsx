/**
 * Log viewer UI.
 *
 * Pure React Native (no DOM/CSS — this is the mobile rebuild of MLV2's log
 * panel). It receives everything it needs via props so it stays testable and
 * platform-agnostic; the adapter supplies React/RN at construction time.
 */

import type { Adapter } from "../adapter/types";
import { IndexRow, LogEntry } from "../core/schema";
import { LogStore } from "../core/store";
import { AttachmentCache } from "../core/cache";
import { diffWords } from "../core/diff";

export function makeLogViewer(
  a: Adapter,
  store: LogStore,
  cache: AttachmentCache
) {
  const { React, ReactNative } = a.ui;
  const { View, Text, Pressable, FlatList, Image, TextInput } = ReactNative;
  // React arrives via the adapter as `any`; give the hooks real signatures.
  const useState = React.useState as <S>(
    init: S | (() => S)
  ) => [S, (v: S | ((p: S) => S)) => void];
  const useEffect = React.useEffect as (
    fn: () => void | (() => void),
    deps?: unknown[]
  ) => void;
  const useMemo = React.useMemo as <T>(fn: () => T, deps: unknown[]) => T;

  function fmt(ts: number): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  const styles = {
    row: { padding: 12, borderBottomWidth: 0.5, borderColor: "#333" },
    chanTitle: { fontSize: 15, fontWeight: "600", color: "#fff" },
    meta: { fontSize: 12, color: "#8a8a8a", marginTop: 2 },
    deleted: { color: "#f04747" },
    edited: { color: "#dcddde" },
    author: { fontSize: 13, fontWeight: "600", color: "#dcddde" },
    content: { fontSize: 14, color: "#dcddde", marginTop: 2 },
    thumb: { width: 120, height: 120, marginTop: 6, borderRadius: 6 },
    tabBar: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#333" },
    tab: { flex: 1, padding: 10, alignItems: "center" },
    tabActive: { borderBottomWidth: 2, borderColor: "#5865f2" },
    tabText: { color: "#dcddde", fontSize: 14 },
    empty: { padding: 24, color: "#8a8a8a", textAlign: "center" },
    search: {
      color: "#dcddde",
      backgroundColor: "#1e1f22",
      borderRadius: 6,
      padding: 8,
      margin: 10,
    },
    jump: { color: "#5865f2", fontSize: 12, marginTop: 6, fontWeight: "600" },
    diffAdd: { color: "#3ba55d" },
    diffDel: { color: "#f04747", textDecorationLine: "line-through" },
  } as const;

  // Render an edited entry's latest revision as a diff against the prior one.
  function EditDiff({ entry }: { entry: LogEntry }) {
    const revs = entry.revisions ?? [];
    if (revs.length < 2) {
      return <Text style={[styles.content, styles.edited]}>{entry.content || "(no text)"}</Text>;
    }
    const prev = revs[revs.length - 2].content;
    const curr = revs[revs.length - 1].content;
    const parts = diffWords(prev, curr);
    return (
      <Text style={styles.content}>
        {parts.map((p, i) => (
          <Text
            key={i}
            style={
              p.type === "add"
                ? styles.diffAdd
                : p.type === "del"
                ? styles.diffDel
                : undefined
            }
          >
            {p.text}
            {i < parts.length - 1 ? " " : ""}
          </Text>
        ))}
      </Text>
    );
  }

  // --- Entry row ---
  function EntryRow({ entry }: { entry: LogEntry }) {
    return (
      <View style={styles.row}>
        <Text style={styles.author}>
          {entry.authorName ?? entry.authorId ?? "unknown"}
        </Text>
        {entry.kind === "deleted" ? (
          <Text style={[styles.content, styles.deleted]}>
            {entry.content || "(no text content)"}
          </Text>
        ) : (
          <EditDiff entry={entry} />
        )}
        {entry.attachments.map((att) =>
          att.cached && att.localPath ? (
            <Image
              key={att.id}
              source={{ uri: cache.imageUri(att.localPath) }}
              style={styles.thumb}
              resizeMode="cover"
            />
          ) : (
            <Text key={att.id} style={styles.meta}>
              📎 {att.filename} {att.cached ? "" : "(not cached)"}
            </Text>
          )
        )}
        <Text style={styles.meta}>
          {entry.kind === "deleted" ? "deleted" : "edited"} · {fmt(entry.loggedAt)}
        </Text>
        <Pressable
          onPress={() =>
            a.nav.jumpToMessage(entry.channelId, entry.messageId, entry.guildId)
          }
        >
          <Text style={styles.jump}>Jump to message ↗</Text>
        </Pressable>
      </View>
    );
  }

  // --- Channel detail ---
  function ChannelLog({ channelId }: { channelId: string }) {
    const [tab, setTab] = useState<"deleted" | "edited">("deleted");
    const [entries, setEntries] = useState<LogEntry[]>([]);
    const [query, setQuery] = useState<string>("");

    useEffect(() => {
      let alive = true;
      store.getChannelLog(channelId).then((e) => alive && setEntries(e));
      return () => {
        alive = false;
      };
    }, [channelId]);

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      return entries.filter((e: LogEntry) => {
        if (e.kind !== tab) return false;
        if (!q) return true;
        return (
          e.content.toLowerCase().includes(q) ||
          (e.authorName ?? "").toLowerCase().includes(q)
        );
      });
    }, [entries, tab, query]);

    return (
      <View style={{ flex: 1 }}>
        <View style={styles.tabBar}>
          {(["deleted", "edited"] as const).map((t) => (
            <Pressable
              key={t}
              style={[styles.tab, tab === t && styles.tabActive]}
              onPress={() => setTab(t)}
            >
              <Text style={styles.tabText}>{t === "deleted" ? "Deleted" : "Edited"}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          style={styles.search}
          value={query}
          placeholder="Search content or author…"
          placeholderTextColor="#555"
          onChangeText={setQuery}
        />
        {filtered.length === 0 ? (
          <Text style={styles.empty}>
            {query ? "No matches." : `No ${tab} messages logged in this channel.`}
          </Text>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(e: LogEntry) => `${e.kind}:${e.messageId}`}
            renderItem={({ item }: { item: LogEntry }) => <EntryRow entry={item} />}
          />
        )}
      </View>
    );
  }

  // --- Channel index (root screen) ---
  function LogViewer() {
    const [rows, setRows] = useState<IndexRow[]>([]);

    useEffect(() => {
      setRows(store.getIndex());
    }, []);

    if (rows.length === 0) {
      return (
        <View style={{ flex: 1 }}>
          <Text style={styles.empty}>
            Nothing logged yet. Deleted and edited messages will appear here.
          </Text>
        </View>
      );
    }

    return (
      <FlatList
        data={rows}
        keyExtractor={(r: IndexRow) => r.channelId}
        renderItem={({ item }: { item: IndexRow }) => (
          <Pressable
            style={styles.row}
            onPress={() =>
              a.nav.pushScreen(
                `#${item.channelId}`,
                () => <ChannelLog channelId={item.channelId} />
              )
            }
          >
            <Text style={styles.chanTitle}>Channel {item.channelId}</Text>
            <Text style={styles.meta}>
              {item.count} entries · last {fmt(item.lastLoggedAt)}
            </Text>
          </Pressable>
        )}
      />
    );
  }

  return LogViewer;
}
