import { FileBrowser } from "./FileBrowser";

interface SftpSidebarProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  cwdHint?: string | null;
  cwdHintVersion?: number;
  onRequestTerminalCwd?: () => boolean;
  onClose?: () => void;
  onDetach?: () => void;
  onOpenTerminalHere?: (path: string) => void;
  title?: string;
}

/**
 * Thin wrapper around <FileBrowser/> that renders the dual-pane SFTP UI in
 * a narrow sidebar. Defaults to a stacked (vertical) layout because the
 * sidebar is only ~380px wide; the user can flip to side-by-side via the
 * orientation toggle in the header.
 *
 * Cwd sync is delegated to <FileBrowser/> and is strictly user-triggered:
 * the panel only asks the terminal for cwd when the explicit Sync button is clicked.
 */
export function SftpSidebar(props: SftpSidebarProps) {
  return (
    <FileBrowser
      sessionId={props.sessionId}
      host={props.host}
      port={props.port}
      username={props.username}
      authMethod={props.authMethod}
      authData={props.authData}
      cwdHint={props.cwdHint}
      cwdHintVersion={props.cwdHintVersion}
      onRequestTerminalCwd={props.onRequestTerminalCwd}
      onDetach={props.onDetach}
      onClose={props.onClose}
      onOpenTerminalHere={props.onOpenTerminalHere}
      showHeader
      title={props.title ?? "SFTP"}
      defaultOrientation="vertical"
      orientationScope={`sidebar-${props.sessionId}`}
    />
  );
}
