/**
 * MessageLoggerRevenge — MINIMAL build.
 *
 * Deliberately modeled almost verbatim on redstonekasi's "Message Logger",
 * which is confirmed to load and run with working settings on this Revenge
 * build. Goal for this version: prove the plugin loads, keeps deleted messages
 * visible, and shows a working settings screen. Persistence, the log viewer,
 * attachment caching, and edit logging come AFTER this loads cleanly.
 *
 * Key structural choices copied from the working reference:
 *  - runtime reached via @vendetta/* imports (build maps them to vendetta.*).
 *  - settings built from Discord's Forms components (NOT raw ReactNative).
 *  - instance exported directly on module.exports (settings/onUnload as direct
 *    properties), which is the shape the loader consumes.
 *  - deletion kept visible by converting MESSAGE_DELETE -> MESSAGE_UPDATE with a
 *    flag, propagating the flag through MessageRecord creation, and restyling
 *    the row via a RowManager.generate patch.
 */

import { findByProps, findByName } from "@vendetta/metro";
import { React, ReactNative, FluxDispatcher } from "@vendetta/metro/common";
import { before, after, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";

const { FormSwitchRow, FormIcon } = Forms;

// Default settings.
storage.keepDeleted ??= true;

// ---- settings screen (Forms components, like the reference) ----------------

function Settings() {
  useProxy(storage);
  return React.createElement(
    ReactNative.ScrollView,
    null,
    React.createElement(FormSwitchRow, {
      label: "Keep deleted messages visible",
      subLabel: "Show deleted messages in red instead of removing them",
      leading: React.createElement(FormIcon, {
        source: getAssetIDByName("ic_message_delete"),
      }),
      onValueChange: (v: boolean) => {
        storage.keepDeleted = v;
      },
      value: storage.keepDeleted,
    })
  );
}

// ---- deletion-keeping mechanism (mirrors the reference) --------------------

const patches: Array<() => void> = [];

function onLoad() {
  const messages = findByProps("_channelMessages");
  const recordFuncs = findByProps("updateMessageRecord", "createMessageRecord");
  const MessageRecord = findByName("MessageRecord", false);
  const RowManager = findByName("RowManager");

  // 1) Intercept deletes: turn into an update flagged as deleted, so the row
  //    stays instead of being removed.
  patches.push(
    before("dispatch", FluxDispatcher, ([event]: any[]) => {
      if (event.type !== "MESSAGE_DELETE") return;
      if (!storage.keepDeleted) return;
      if (event.__mlr_cleanup) return event; // our own real delete on unload
      const msg = messages?.get(event.channelId)?.get(event.id);
      if (!msg || msg.author?.id == "1" || msg.state == "SEND_FAILED") return event;
      return [
        {
          message: { ...msg.toJS(), __mlr_deleted: true },
          type: "MESSAGE_UPDATE",
        },
      ];
    })
  );

  // 2) Propagate the flag through Discord's message-record creation so it
  //    survives re-renders.
  if (recordFuncs) {
    patches.push(
      instead("updateMessageRecord", recordFuncs, function (
        this: any,
        [oldRecord, newRecord]: any[],
        orig: (...a: any[]) => any
      ) {
        return newRecord.__mlr_deleted
          ? recordFuncs.createMessageRecord(newRecord, oldRecord.reactions)
          : orig.apply(this, [oldRecord, newRecord]);
      })
    );
    patches.push(
      after("createMessageRecord", recordFuncs, ([input]: any[], output: any) => {
        output.__mlr_deleted = input.__mlr_deleted;
      })
    );
  }
  if (MessageRecord) {
    patches.push(
      after("default", MessageRecord, ([input]: any[], output: any) => {
        output.__mlr_deleted = !!input.__mlr_deleted;
      })
    );
  }

  // 3) Restyle deleted rows red.
  if (RowManager?.prototype) {
    patches.push(
      after("generate", RowManager.prototype, ([data]: any[], row: any) => {
        if (data.rowType === 1 && data.message?.__mlr_deleted) {
          row.message.edited = "deleted";
          row.backgroundHighlight ??= {};
          row.backgroundHighlight.backgroundColor =
            ReactNative.processColor("#da373c22");
          row.backgroundHighlight.gutterColor =
            ReactNative.processColor("#da373cff");
        }
      })
    );
  }
}

function onUnload() {
  patches.forEach((u) => u());
  patches.length = 0;
  // Clean up: actually delete anything we were keeping visible.
  const messages = findByProps("_channelMessages");
  if (messages?._channelMessages) {
    for (const ch in messages._channelMessages) {
      for (const e of messages._channelMessages[ch]._array ?? []) {
        if (e.__mlr_deleted) {
          FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            id: e.id,
            channelId: e.channel_id,
            __mlr_cleanup: true,
          });
        }
      }
    }
  }
}

// Export the instance directly (matches the reference's returned-instance shape).
module.exports = { onLoad, onUnload, settings: Settings };
