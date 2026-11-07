import type { InlineKeyboard } from "grammy";
import { at } from "./i18n.js";

/** Callback data of the button that opens the OpenCode configuration inside /settings. */
export const AAO_CONFIG_ROOT_CALLBACK = "aao:cfg:root";

/** Adds the "OpenCode" row to the upstream /settings keyboard. Kept here so the upstream patch is one line. */
export function appendAaoSettingsRow(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.row().text(at("cfg.settings_button"), AAO_CONFIG_ROOT_CALLBACK);
}
