import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../sidebar/ConfirmDialog";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import {
  listenRdpConnectionRequests,
  resolveRdpConnectionRequest,
  type RdpConnectionRequest,
} from "../../lib/servers";

/**
 * Main-window human-in-the-loop gate for RDP control. Backend approval expires
 * after a bounded interval; this bridge mirrors that deadline so stale prompts
 * disappear and are explicitly denied.
 */
export function RdpServerApprovalBridge() {
  const t = useT();
  const [requests, setRequests] = useState<RdpConnectionRequest[]>([]);
  const requestsRef = useRef(requests);
  const respondingRef = useRef(new Set<string>());
  requestsRef.current = requests;

  const respond = useCallback((request: RdpConnectionRequest, approved: boolean) => {
    if (respondingRef.current.has(request.requestId)) return;
    respondingRef.current.add(request.requestId);
    setRequests((current) => current.filter((item) => item.requestId !== request.requestId));
    void resolveRdpConnectionRequest(request.requestId, approved)
      .catch(() => false)
      .finally(() => respondingRef.current.delete(request.requestId));
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenRdpConnectionRequests((request) => {
      if (disposed) {
        void resolveRdpConnectionRequest(request.requestId, false).catch(() => false);
        return;
      }
      setRequests((current) => {
        if (current.some((item) => item.requestId === request.requestId)) return current;
        return current.concat(request);
      });
    })
      .then((next) => {
        if (disposed) next();
        else unlisten = next;
      })
      .catch(() => {
        /* Native event bridge unavailable while the app is shutting down. */
      });

    return () => {
      disposed = true;
      unlisten?.();
      for (const request of requestsRef.current) {
        void resolveRdpConnectionRequest(request.requestId, false).catch(() => false);
      }
    };
  }, []);

  const active = requests[0] ?? null;
  useEffect(() => {
    if (!active) return undefined;
    const remaining = Math.max(0, active.expiresAt - Date.now());
    const timer = window.setTimeout(() => respond(active, false), remaining);
    return () => window.clearTimeout(timer);
  }, [active, respond]);

  if (!active) return null;
  return (
    <ConfirmDialog
      title={t("servers.rdpApprovalTitle")}
      message={t("servers.rdpApprovalMessage", {
        peer: active.peer,
        seconds: active.timeoutSeconds,
      })}
      confirmLabel={t("servers.rdpApprovalAllow")}
      cancelLabel={t("servers.rdpApprovalDeny")}
      onCancel={() => respond(active, false)}
      onConfirm={() => respond(active, true)}
    />
  );
}
