import { useEffect } from "react";
import { MainLayout } from "./layouts/MainLayout";
import {
  SftpDetachedWindow,
  detectDetachedSftpRoute,
} from "./components/filebrowser/SftpDetachedWindow";
import { useAppTheme } from "./lib/appTheme";
import { attachSftpSync } from "./lib/sftpSync";
import { sweepExpiredHandoffs } from "./components/filebrowser/SftpDetachedWindow";

function App() {
  const { mode, resolvedTheme } = useAppTheme();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  // Mirror the transfer queue across same-origin windows so a user can see
  // the same uploads/downloads from both the main app and a detached SFTP
  // window. The cleanup tears the channel down on hot-reload too.
  useEffect(() => attachSftpSync(), []);
  // Drop any stale credential handoffs left over from a previous run
  // (e.g. window.open denied, app crashed mid-launch). Defence-in-depth
  // for the localStorage-based handoff used by detached SFTP windows.
  useEffect(() => {
    sweepExpiredHandoffs();
  }, []);

  const detachedSftpId = detectDetachedSftpRoute();
  if (detachedSftpId) {
    return <SftpDetachedWindow sessionId={detachedSftpId} />;
  }

  return <MainLayout />;
}

export default App;
