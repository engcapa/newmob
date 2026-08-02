/**
 * RDP-specific options panel rendered inside `SessionEditor` when the
 * selected protocol is RDP. The form reads/writes a normalized
 * [`RdpOptions`] tree that is serialized into `SessionConfig.options_json`
 * by the parent.
 */
import { useT } from "../../../lib/i18n";
import {
  DEFAULT_RDP_OPTIONS,
  type RdpDriveRedirect,
  type RdpGatewayOptions,
  type RdpOptions,
  type RdpPerformanceFlags,
} from "../../../types/rdp";

const COLOR_DEPTHS = [8, 15, 16, 24, 32];

export interface RdpOptionsFormProps {
  options: RdpOptions;
  onChange: (next: RdpOptions) => void;
}

export function RdpOptionsForm({ options, onChange }: RdpOptionsFormProps) {
  const t = useT();
  const opt = { ...DEFAULT_RDP_OPTIONS, ...options };

  const set = (patch: Partial<RdpOptions>) => onChange({ ...opt, ...patch });
  const setPerf = (patch: Partial<RdpPerformanceFlags>) =>
    onChange({ ...opt, performance: { ...opt.performance, ...patch } });
  const setDrive = (patch: Partial<RdpDriveRedirect>) =>
    onChange({ ...opt, redirectDrive: { ...opt.redirectDrive, ...patch } });
  const setGateway = (patch: Partial<RdpGatewayOptions> | null) => {
    if (patch === null) {
      const { gateway: _g, ...rest } = opt;
      onChange(rest as RdpOptions);
      return;
    }
    const base: RdpGatewayOptions = opt.gateway ?? {
      host: "",
      port: 443,
      username: "",
      password: undefined,
      auth: "ntlm",
      useSessionCreds: true,
    };
    onChange({ ...opt, gateway: { ...base, ...patch } });
  };

  return (
    <div
      className="rdp-options-form"
      style={{
        // Newspaper-style multi-column flow: pack the variable-height option
        // groups into as many ~260px columns as the editor width allows,
        // filling the wide right half instead of stacking them in one narrow
        // left strip. `break-inside: avoid` on each fieldset keeps a group from
        // splitting across a column boundary.
        columnWidth: 260,
        columnGap: 20,
      }}
    >
      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.title")}</legend>
        <label style={row()}>
          <span>{t("rdp.options.domain")}</span>
          <input
            className="taomni-input"
            type="text"
            value={opt.domain ?? ""}
            onChange={(e) => set({ domain: e.target.value || undefined })}
            placeholder="CORP"
          />
        </label>

        <label style={row()}>
          <span>{t("rdp.options.colorDepth")}</span>
          <select
            className="taomni-input"
            value={opt.colorDepth}
            onChange={(e) => set({ colorDepth: parseInt(e.target.value, 10) })}
          >
            {COLOR_DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d} bpp
              </option>
            ))}
          </select>
        </label>

        <label style={row()}>
          <span>{t("rdp.options.screen")}</span>
          <span style={{ display: "inline-flex", gap: 6 }}>
            <input
              className="taomni-input"
              type="number"
              min={320}
              max={8192}
              value={opt.screenW}
              onChange={(e) => set({ screenW: parseInt(e.target.value, 10) || 1920 })}
              style={{ width: 90 }}
            />
            ×
            <input
              className="taomni-input"
              type="number"
              min={200}
              max={8192}
              value={opt.screenH}
              onChange={(e) => set({ screenH: parseInt(e.target.value, 10) || 1080 })}
              style={{ width: 90 }}
            />
          </span>
        </label>

        <label style={row()}>
          <input
            type="checkbox"
            checked={opt.nla}
            onChange={(e) => set({ nla: e.target.checked })}
          />
          <span>{t("rdp.options.nla")}</span>
        </label>
      </fieldset>

      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.performance")}</legend>
        {(
          [
            ["wallpaper", "perfWallpaper"],
            ["themes", "perfThemes"],
            ["fontSmooth", "perfFontSmooth"],
            ["disableFullWindowDrag", "perfFullDrag"],
            ["disableMenuAnimations", "perfMenuAnim"],
            ["disableCursorShadow", "perfCursorShadow"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} style={row()}>
            <input
              type="checkbox"
              checked={opt.performance[key]}
              onChange={(e) => setPerf({ [key]: e.target.checked } as Partial<RdpPerformanceFlags>)}
            />
            <span>{t(`rdp.options.${label}`)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.audio")}</legend>
        <label style={row()}>
          <input
            type="radio"
            name="rdp-audio"
            checked={opt.redirectAudio === "play"}
            onChange={() => set({ redirectAudio: "play" })}
          />
          <span>{t("rdp.options.audioPlay")}</span>
        </label>
        <label style={row()}>
          <input
            type="radio"
            name="rdp-audio"
            checked={opt.redirectAudio === "off"}
            onChange={() => set({ redirectAudio: "off" })}
          />
          <span>{t("rdp.options.audioOff")}</span>
        </label>
      </fieldset>

      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.clipboard")}</legend>
        <label style={row()}>
          <input
            type="checkbox"
            checked={opt.redirectClipboard}
            onChange={(e) => set({ redirectClipboard: e.target.checked })}
          />
          <span>{t("rdp.options.clipboard")}</span>
        </label>
      </fieldset>

      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.drive")}</legend>
        <label style={row()}>
          <input
            type="checkbox"
            checked={opt.redirectDrive.enabled}
            onChange={(e) => setDrive({ enabled: e.target.checked })}
          />
          <span>{t("rdp.options.drive")}</span>
        </label>
        {opt.redirectDrive.enabled && (
          <>
            <label style={row()}>
              <span>{t("rdp.options.driveLabel")}</span>
              <input
                className="taomni-input"
                type="text"
                maxLength={8}
                value={opt.redirectDrive.label}
                onChange={(e) => setDrive({ label: e.target.value.toUpperCase() })}
                style={{ width: 120 }}
              />
            </label>
            <label style={row()}>
              <span>{t("rdp.options.drivePath")}</span>
              <input
                className="taomni-input"
                type="text"
                value={opt.redirectDrive.path}
                onChange={(e) => setDrive({ path: e.target.value })}
                placeholder="/home/me/shared"
                style={{ flex: 1 }}
              />
            </label>
            <label style={row()}>
              <input
                type="checkbox"
                checked={opt.redirectDrive.readOnly}
                onChange={(e) => setDrive({ readOnly: e.target.checked })}
              />
              <span>{t("rdp.options.driveReadOnly")}</span>
            </label>
          </>
        )}
      </fieldset>

      <fieldset style={FIELDSET_STYLE}>
        <legend>{t("rdp.options.gateway")}</legend>
        <label style={row()}>
          <input
            type="checkbox"
            checked={!!opt.gateway}
            onChange={(e) =>
              setGateway(
                e.target.checked
                  ? { host: "", port: 443, username: "", auth: "ntlm", useSessionCreds: true }
                  : null,
              )
            }
          />
          <span>{t("rdp.options.gateway")}</span>
        </label>
        {opt.gateway && (
          <>
            <label style={row()}>
              <span>{t("rdp.options.gatewayHost")}</span>
              <input
                className="taomni-input"
                type="text"
                value={opt.gateway.host}
                onChange={(e) => setGateway({ host: e.target.value })}
                placeholder="rdg.example.com"
                style={{ flex: 1 }}
              />
            </label>
            <label style={row()}>
              <span>{t("rdp.options.gatewayPort")}</span>
              <input
                className="taomni-input"
                type="number"
                min={1}
                max={65535}
                value={opt.gateway.port}
                onChange={(e) => setGateway({ port: parseInt(e.target.value, 10) || 443 })}
                style={{ width: 90 }}
              />
            </label>
            <label style={row()}>
              <input
                type="checkbox"
                checked={opt.gateway.useSessionCreds}
                onChange={(e) => setGateway({ useSessionCreds: e.target.checked })}
              />
              <span>{t("rdp.options.gatewayUseSession")}</span>
            </label>
            {!opt.gateway.useSessionCreds && (
              <>
                <label style={row()}>
                  <span>{t("rdp.options.gatewayUser")}</span>
                  <input
                    className="taomni-input"
                    type="text"
                    value={opt.gateway.username}
                    onChange={(e) => setGateway({ username: e.target.value })}
                    style={{ flex: 1 }}
                  />
                </label>
                <label style={row()}>
                  <span>{t("rdp.options.gatewayPassword")}</span>
                  <input
                    className="taomni-input"
                    type="password"
                    value={opt.gateway.password ?? ""}
                    onChange={(e) => setGateway({ password: e.target.value || undefined })}
                    style={{ flex: 1 }}
                  />
                </label>
              </>
            )}
            <label style={row()}>
              <span>Auth</span>
              <span style={{ display: "inline-flex", gap: 8 }}>
                <label style={{ display: "inline-flex", gap: 4 }}>
                  <input
                    type="radio"
                    name="rdp-gw-auth"
                    checked={opt.gateway.auth === "ntlm"}
                    onChange={() => setGateway({ auth: "ntlm" })}
                  />
                  {t("rdp.options.gatewayAuthNtlm")}
                </label>
                <label style={{ display: "inline-flex", gap: 4 }}>
                  <input
                    type="radio"
                    name="rdp-gw-auth"
                    checked={opt.gateway.auth === "basic"}
                    onChange={() => setGateway({ auth: "basic" })}
                  />
                  {t("rdp.options.gatewayAuthBasic")}
                </label>
              </span>
            </label>
          </>
        )}
      </fieldset>
    </div>
  );
}

function row(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
  };
}

// Each option group is a column-flow item: keep it whole (never split across
// a column boundary) and give the groups breathing room between each other.
const FIELDSET_STYLE: React.CSSProperties = {
  breakInside: "avoid",
  // `inline-block` makes the multi-column layout measure each fieldset as one
  // atomic block, which keeps `break-inside: avoid` reliable across engines.
  display: "inline-block",
  width: "100%",
  marginBottom: 14,
};
