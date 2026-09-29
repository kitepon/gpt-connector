// gpt-connectorがaiterm-steer-deliveryへ渡す製品の識別情報。保存場所・hook入口の名前・案内文は従来のまま。
import { dirname } from "node:path";
import type { ProductProfile } from "aiterm-steer-delivery";
import { relayConfigDirectory } from "./codex-steer-config.js";
import { defaultConsultStateDirectory } from "./platform/state.js";

export const GPT_CONNECTOR_PROFILE: ProductProfile = {
  id: "gpt-connector",
  display_name: "gpt-connector",
  setup_command: "gpt-connector setup",
  codex_steer_command: "gpt-connector setup --codex-steer enable",
  mcp_server: "gpt-connector",
  dispatch_tools: ["consult", "grok_consult"],
  state_root: defaultConsultStateDirectory,
  config_root: () => dirname(relayConfigDirectory()),
  hooks: { codex: "codex-parent-hook.js", claude: "gpt-connector-claude-parent-hook.js", cursor: "gpt-connector-cursor-parent-hook.js" },
  codex_client_name: "gpt_connector_parent_delivery",
  codex_hook_schema: "gpt-connector.codex-parent-hooks.v1",
  backup_suffix: ".gpt-connector-backup",
};
