import React from "react";
import type { ProjectFactsStatus } from "../../../stores/projectFactsStore";
import type {
  ProjectDescriptorDiscoveryState,
} from "../../../hooks/useProjectDescriptorDiscovery";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from "lucide-react";

export interface ProjectFactsStatusBadgeProps {
  status: ProjectFactsStatus;
  discoveryStatus?: ProjectDescriptorDiscoveryState["status"];
  discovery?: ProjectDescriptorDiscoveryState["discovery"];
  discoveryReason?: string | null;
  reason?: string | null;
  generation?: number;
  isStale?: boolean;
  onRefresh?: () => void;
  className?: string;
}

export const ProjectFactsStatusBadge: React.FC<ProjectFactsStatusBadgeProps> = ({
  status,
  discoveryStatus,
  discovery,
  discoveryReason,
  reason,
  generation,
  isStale,
  onRefresh,
  className = "",
}) => {
  const discoveredSystems = Array.from(new Set(
    (discovery?.descriptors ?? [])
      .map((descriptor) => descriptor.buildSystem)
      .filter((buildSystem) => buildSystem === "maven" || buildSystem === "gradle"),
  ));
  const discoveryLabel = discoveryStatus === "loading"
    ? "Discovering Project"
    : discoveryStatus === "descriptor-only"
    ? discoveredSystems.length > 0
      ? `${discoveredSystems.map((system) => system[0]!.toUpperCase() + system.slice(1)).join(" / ")} Discovered`
      : "Project Discovered"
    : discoveryStatus === "failed"
    ? "Discovery Failed"
    : null;

  if (status === "idle" && !discoveryLabel) {
    return null;
  }

  return (
    <div
      data-testid="project-facts-status-badge"
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ${
        discoveryLabel && status === "idle"
          ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20"
          : status === "ready" && !isStale
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
          : status === "loading"
          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
          : status === "untrusted"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
          : status === "degraded" || isStale
          ? "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20"
          : "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
      } ${className}`}
      title={reason || discoveryReason || (isStale ? "Project structure is stale" : `Project facts (${status})`)}
    >
      {discoveryLabel && (
        <span data-testid="project-facts-discovery-status" className="font-medium">
          {discoveryLabel}
        </span>
      )}
      {status === "loading" && <Loader2 className="w-3.5 h-3.5 animate-spin" data-testid="project-facts-loading-icon" />}
      {status === "ready" && !isStale && <CheckCircle2 className="w-3.5 h-3.5" data-testid="project-facts-ready-icon" />}
      {status === "untrusted" && <ShieldAlert className="w-3.5 h-3.5" data-testid="project-facts-untrusted-icon" />}
      {(status === "degraded" || isStale) && status !== "loading" && (
        <AlertTriangle className="w-3.5 h-3.5" data-testid="project-facts-stale-icon" />
      )}
      {status === "failed" && <AlertCircle className="w-3.5 h-3.5" data-testid="project-facts-failed-icon" />}

      <span className="font-medium">
        {status === "loading" && "Loading Facts"}
        {status === "ready" && !isStale && `Ready (G${generation})`}
        {status === "ready" && isStale && `Stale (G${generation})`}
        {status === "untrusted" && "Untrusted"}
        {status === "degraded" && "Degraded"}
        {status === "failed" && "Facts Failed"}
      </span>

      {onRefresh && (
        <button
          type="button"
          data-testid="project-facts-refresh-btn"
          aria-label="Refresh project facts and descriptors"
          title="Refresh project facts and descriptors"
          onClick={onRefresh}
          className="ml-1 opacity-70 hover:opacity-100"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};
