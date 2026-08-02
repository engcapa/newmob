import { useT } from "../../../lib/i18n";
import type { ServerConfig } from "../../../lib/servers";
import { getAppPlatform } from "../../../lib/runtime";
import { CheckboxField, FieldNote, PasswordField, TextField } from "../fields";

interface Props {
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

/**
 * RDP server form: NLA credentials, security mode, and view-only toggle. The
 * server shares this machine's desktop with RDP clients (mstsc / FreeRDP).
 * Platform capability note reflects capture backend status (R0 honesty).
 */
export function RdpSettings({ config, onChange }: Props) {
  const t = useT();
  const username = typeof config.username === "string" ? config.username : "";
  const password = typeof config.password === "string" ? config.password : "";
  const domain = typeof config.domain === "string" ? config.domain : "";
  const passwordStored =
    typeof config.passwordRef === "string" && config.passwordRef.startsWith("vault:");
  const viewOnly = config.viewOnly === true;
  const allowPublicBind = config.allowPublicBind === true;
  const platform = getAppPlatform();
  const capabilityNote =
    platform === "macos"
      ? t("servers.notes.rdpCapMacos")
      : platform === "linux"
        ? t("servers.notes.rdpCapLinux")
        : platform === "windows"
          ? t("servers.notes.rdpCapWindows")
          : t("servers.notes.rdpCapUnknown");

  return (
    <div className="flex flex-col">
      <FieldNote tone={platform === "windows" ? "warning" : "info"}>{capabilityNote}</FieldNote>
      <TextField
        label={t("servers.fields.rdpUsername")}
        value={username}
        onChange={(v) => onChange({ username: v })}
      />
      <PasswordField
        label={t("servers.fields.password")}
        value={password}
        onChange={(v) => onChange({ password: v })}
        placeholder={passwordStored ? t("servers.fields.rdpPasswordStored") : undefined}
      />
      <TextField
        label={t("servers.fields.rdpDomain")}
        value={domain}
        onChange={(v) => onChange({ domain: v })}
        placeholder={t("servers.fields.optional")}
      />
      <FieldNote>{t("servers.notes.rdpHybridOnly")}</FieldNote>
      <CheckboxField
        label={t("servers.fields.viewOnly")}
        checkboxLabel={t("servers.fields.viewOnly")}
        value={viewOnly}
        onChange={(v) => onChange({ viewOnly: v })}
      />
      <CheckboxField
        label={t("servers.fields.rdpPublicBind")}
        checkboxLabel={t("servers.fields.rdpPublicBind")}
        value={allowPublicBind}
        onChange={(v) => onChange({ allowPublicBind: v })}
      />
      {allowPublicBind ? (
        <FieldNote tone="warning">{t("servers.notes.rdpPublicBind")}</FieldNote>
      ) : null}
    </div>
  );
}
