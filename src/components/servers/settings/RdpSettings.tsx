import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import {
  probeRdpCapture,
  type RdpCaptureProbe,
  type ServerConfig,
} from "../../../lib/servers";
import { getAppPlatform } from "../../../lib/runtime";
import {
  CheckboxField,
  FieldNote,
  FormRow,
  PasswordField,
  SelectField,
  TextField,
} from "../fields";

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
  const requireControlApproval = config.requireControlApproval !== false;
  const displayId = typeof config.displayId === "string" ? config.displayId : "";
  const platform = getAppPlatform();
  const [captureProbe, setCaptureProbe] = useState<RdpCaptureProbe | null>(null);
  const [captureProbeError, setCaptureProbeError] = useState("");
  const [requestingPermission, setRequestingPermission] = useState(false);
  const capabilityNote =
    platform === "macos"
      ? t("servers.notes.rdpCapMacos")
      : platform === "linux"
        ? t("servers.notes.rdpCapLinux")
        : platform === "windows"
          ? t("servers.notes.rdpCapWindows")
          : t("servers.notes.rdpCapUnknown");

  const refreshCaptureProbe = async (requestPermission: boolean) => {
    setRequestingPermission(true);
    setCaptureProbeError("");
    try {
      setCaptureProbe(await probeRdpCapture(requestPermission));
    } catch (error) {
      setCaptureProbeError(String(error));
    } finally {
      setRequestingPermission(false);
    }
  };

  useEffect(() => {
    if (platform === "macos") void refreshCaptureProbe(false);
    // Probe when the settings panel is mounted; permission requests remain an
    // explicit user action through the button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform]);

  const displayOptions = [
    { value: "", label: t("servers.fields.rdpDisplayPrimary") },
    ...(captureProbe?.displays ?? []).map((display) => ({
      value: display.id,
      label: `${display.name} — ${display.width}×${display.height}${
        display.primary ? ` (${t("servers.fields.rdpDisplayPrimaryBadge")})` : ""
      }`,
    })),
  ];

  return (
    <div className="flex flex-col">
      <FieldNote tone={platform === "windows" ? "warning" : "info"}>{capabilityNote}</FieldNote>
      {platform === "macos" ? (
        <>
          <SelectField
            label={t("servers.fields.rdpDisplay")}
            value={displayId}
            onChange={(value) => onChange({ displayId: value })}
            options={displayOptions}
            width={280}
          />
          <FormRow label={t("servers.fields.rdpCapturePermission")}>
            <span style={{ color: "var(--taomni-text-muted)" }}>
              {captureProbe?.permission === "granted"
                ? t("servers.notes.rdpCaptureGranted")
                : t("servers.notes.rdpCaptureRequired")}
            </span>
            <button
              type="button"
              className="taomni-btn"
              disabled={requestingPermission}
              onClick={() =>
                void refreshCaptureProbe(captureProbe?.permission !== "granted")
              }
            >
              {captureProbe?.permission === "granted"
                ? t("servers.fields.rdpRefreshDisplays")
                : t("servers.fields.rdpGrantCapture")}
            </button>
          </FormRow>
          {captureProbeError ? <FieldNote tone="warning">{captureProbeError}</FieldNote> : null}
        </>
      ) : null}
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
      {!viewOnly ? (
        <CheckboxField
          label={t("servers.fields.rdpControlApproval")}
          checkboxLabel={t("servers.fields.rdpControlApproval")}
          value={requireControlApproval}
          onChange={(value) => onChange({ requireControlApproval: value })}
        />
      ) : null}
      {!viewOnly && !requireControlApproval ? (
        <FieldNote tone="warning">{t("servers.notes.rdpUnattendedControl")}</FieldNote>
      ) : null}
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
