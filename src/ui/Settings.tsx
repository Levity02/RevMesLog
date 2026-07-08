/**
 * Settings screen. Toggles for delete/edit logging, keep-in-chat, attachment
 * caching, a watched-guild list editor, and a button into the log viewer.
 */

import type { Adapter } from "../adapter/types";
import { LoggerSettings } from "../core/logger";

export function makeSettings(
  a: Adapter,
  getSettings: () => LoggerSettings,
  setSettings: (s: LoggerSettings) => void,
  openViewer: () => void
) {
  const { React, ReactNative } = a.ui;
  const RN = ReactNative ?? {};
  const { View, Text, Switch, Pressable, TextInput, ScrollView } = RN;
  const useState = React.useState as <S>(
    init: S | (() => S)
  ) => [S, (v: S | ((p: S) => S)) => void];

  const styles = {
    section: { padding: 14 },
    header: { fontSize: 12, color: "#8a8a8a", textTransform: "uppercase", marginBottom: 6 },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 10,
    },
    label: { color: "#dcddde", fontSize: 15 },
    input: {
      color: "#dcddde",
      backgroundColor: "#1e1f22",
      borderRadius: 6,
      padding: 8,
      marginTop: 4,
    },
    button: {
      backgroundColor: "#5865f2",
      borderRadius: 6,
      padding: 12,
      alignItems: "center",
      marginTop: 8,
    },
    buttonText: { color: "#fff", fontWeight: "600" },
    hint: { color: "#8a8a8a", fontSize: 12, marginTop: 4 },
  } as const;

  function Toggle({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (v: boolean) => void;
  }) {
    return (
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Switch value={value} onValueChange={onChange} />
      </View>
    );
  }

  function Settings() {
    const [s, setS] = useState<LoggerSettings>(getSettings());
    const [guildText, setGuildText] = useState(s.watchedGuilds.join(", "));

    const commit = (next: LoggerSettings) => {
      setS(next);
      setSettings(next);
    };

    return (
      <ScrollView>
        <View style={styles.section}>
          <Text style={styles.header}>Logging</Text>
          <Toggle
            label="Log deleted messages"
            value={s.logDeletes}
            onChange={(v) => commit({ ...s, logDeletes: v })}
          />
          <Toggle
            label="Log edited messages"
            value={s.logEdits}
            onChange={(v) => commit({ ...s, logEdits: v })}
          />
          <Toggle
            label="Keep deleted messages in chat"
            value={s.keepInChat}
            onChange={(v) => commit({ ...s, keepInChat: v })}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.header}>Attachments</Text>
          <Toggle
            label="Cache attachments locally"
            value={s.cacheAttachments}
            onChange={(v) => commit({ ...s, cacheAttachments: v })}
          />
          <Text style={styles.label}>Proactively cache these server IDs</Text>
          <TextInput
            style={styles.input}
            value={guildText}
            placeholder="comma-separated guild IDs"
            placeholderTextColor="#555"
            onChangeText={setGuildText}
            onBlur={() =>
              commit({
                ...s,
                watchedGuilds: guildText
                  .split(",")
                  .map((x: string) => x.trim())
                  .filter(Boolean),
              })
            }
          />
          <Text style={styles.hint}>
            Media in these servers is cached on arrival, so a later delete already
            has the bytes on disk. Leave empty to only capture at delete time.
          </Text>
        </View>

        <View style={styles.section}>
          <Pressable style={styles.button} onPress={openViewer}>
            <Text style={styles.buttonText}>Open message log</Text>
          </Pressable>
        </View>

        <Diagnostics />
      </ScrollView>
    );
  }

  // Runs the adapter self-check and prints the real runtime surface, so the
  // native FileModule shape can be verified on-device without a debugger.
  function Diagnostics() {
    const [report, setReport] = useState<string | null>(null);
    const [running, setRunning] = useState<boolean>(false);

    // NOTE: async *arrow* functions are unsupported by Revenge's Hermes engine
    // and cause a parse-time "async functions are unsupported" error that bricks
    // the whole plugin. Use an async function expression instead (which Hermes
    // does support). Applies everywhere in this codebase — never `async () =>`.
    const run = async function () {
      setRunning(true);
      try {
        const d = await a.diagnose();
        const lines = [
          `platform: ${d.platform}`,
          `nav resolved: ${d.navResolved}`,
          `stores: message=${d.storesResolved.message} channel=${d.storesResolved.channel}`,
          `documents dir: ${d.documentsDir ?? "(unknown)"}`,
          `file round-trip: ${d.fileRoundTripOK}`,
          `FileModule methods:`,
          "  " + (d.fileModuleMethods.join(", ") || "(none found)"),
        ];
        setReport(lines.join("\n"));
      } catch (e) {
        setReport(`diagnose() threw: ${String(e)}`);
      } finally {
        setRunning(false);
      }
    };

    return (
      <View style={styles.section}>
        <Text style={styles.header}>Diagnostics</Text>
        <Pressable
          style={[styles.button, { backgroundColor: "#4e5058" }]}
          onPress={run}
        >
          <Text style={styles.buttonText}>
            {running ? "Running…" : "Run self-check"}
          </Text>
        </Pressable>
        {report ? (
          <Text style={[styles.hint, { fontFamily: "monospace", marginTop: 8 }]}>
            {report}
          </Text>
        ) : (
          <Text style={styles.hint}>
            Verifies navigation, stores, and the native file path names. Run this
            first if logging or the viewer misbehaves.
          </Text>
        )}
      </View>
    );
  }

  return Settings;
}
