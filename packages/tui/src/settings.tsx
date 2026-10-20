// The privacy settings view (0007 section 8, DIPO-136), opened from the overview with `p`: the
// three settings with their effective value and where it comes from, from the office summary the
// engine sends. Enter toggles the selected one after a confirmation that names what is stored;
// the change is the engine's `office.setPrivacy`, so the view updates with the next summary.

import type { OfficeStoreState } from "@dipsaus-orchestrator/client";
import type { PrivacySetting } from "@dipsaus-orchestrator/contract";
import { Box, Text } from "ink";

import type { Display } from "./options";
import { officeName } from "./views";

/** What each setting stores and from when a change applies (0007 section 8, DIPO-136). */
const SETTING_WORDS: Readonly<Record<string, { stores: string; applies: string; label: string }>> =
  {
    "privacy.storeCommandBodies": {
      label: "store commands",
      stores: "the commands workers run",
      applies: "from the next output dipo stores, also in a run that is going",
    },
    "privacy.storePrompts": {
      label: "store prompts",
      stores: "the prompts dipo sends to workers (system file and first message)",
      applies: "from the next session that starts",
    },
    "privacy.keepRawEvents": {
      label: "keep raw events",
      stores: "every raw event a worker sends",
      applies: "at the next retention pass",
    },
  };

/** The warning shown until the first write: the file is rewritten and loses its comments. */
export const COMMENTS_WARNING =
  "Changing a setting rewrites .dipo/office.local.yaml: its comments are not kept, every key stays.";

/** The privacy settings of the selected office, from its summary; none before the engine sent them. */
export function privacySettings(state: OfficeStoreState): readonly PrivacySetting[] {
  return state.offices.find((entry) => entry.office === state.office)?.summary?.privacy ?? [];
}

/** The setting name for the command: `privacy.storePrompts` is `storePrompts`. */
export function settingName(key: string): string {
  return key.replace(/^privacy\./, "");
}

/** The confirmation question for turning `setting` to `value`, naming what is stored. */
export function confirmPrompt(key: string, value: boolean): string {
  const words = SETTING_WORDS[key];
  const stores = words?.stores ?? settingName(key);
  const applies = words?.applies ?? "soon";
  return value
    ? `Turn on ${settingName(key)}? dipo then stores ${stores}, ${applies}.`
    : `Turn off ${settingName(key)}? dipo then stops storing ${stores}, ${applies}.`;
}

/** What a change applies to, for the done message. */
export function appliesWords(key: string): string {
  return SETTING_WORDS[key]?.applies ?? "soon";
}

export function Settings(props: {
  state: OfficeStoreState;
  display: Display;
  selected: number;
  /** A write went through in this session, so the comments warning is gone. */
  written: boolean;
}) {
  const { state, display, selected } = props;
  const settings = privacySettings(state);
  const name = officeName(state) ?? "no office";
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{` Privacy settings of ${name}`}</Text>
      {settings.length === 0 ? (
        <Text>
          {" The engine sent no privacy settings; the office has no valid configuration."}
        </Text>
      ) : null}
      {settings.map((setting, index) => {
        const words = SETTING_WORDS[setting.key];
        const line = ` ${index === selected ? ">" : " "} ${settingName(setting.key).padEnd(20)} ${
          setting.value ? "on " : "off"
        }  ${`(${setting.source})`.padEnd(26)} ${words === undefined ? "" : `stores ${words.stores}`}`;
        return index === selected && display.color ? (
          <Text key={setting.key} color="cyan" wrap="truncate-end">
            {line}
          </Text>
        ) : (
          <Text key={setting.key} wrap="truncate-end">
            {line}
          </Text>
        );
      })}
      {props.written ? null : <Text>{` ${COMMENTS_WARNING}`}</Text>}
    </Box>
  );
}
