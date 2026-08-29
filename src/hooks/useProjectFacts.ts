import { useCallback, useEffect } from "react";
import { useProjectFactsStore, type FetchProjectFactsOptions, type WorkspaceProjectFactsEntry } from "../stores/projectFactsStore";

export interface UseProjectFactsOptions extends Partial<FetchProjectFactsOptions> {
  autoFetch?: boolean;
}

export function useProjectFacts(workspaceRoot: string, options?: UseProjectFactsOptions) {
  const entry = useProjectFactsStore((state) => state.getWorkspaceFacts(workspaceRoot));
  const fetchProjectFacts = useProjectFactsStore((state) => state.fetchProjectFacts);
  const invalidateStore = useProjectFactsStore((state) => state.invalidate);

  const refresh = useCallback(
    (customOptions?: Partial<FetchProjectFactsOptions>): Promise<WorkspaceProjectFactsEntry> => {
      if (!workspaceRoot) return Promise.resolve(entry);
      return fetchProjectFacts(workspaceRoot, {
        trusted: options?.trusted ?? true,
        javaHome: options?.javaHome,
        mavenExecutable: options?.mavenExecutable,
        gradleExecutable: options?.gradleExecutable,
        offline: options?.offline,
        toolKind: options?.toolKind,
        ...customOptions,
      });
    },
    [workspaceRoot, options, fetchProjectFacts, entry],
  );

  useEffect(() => {
    if (options?.autoFetch && workspaceRoot && entry.status === "idle") {
      void refresh();
    }
  }, [options?.autoFetch, workspaceRoot, entry.status, refresh]);

  const invalidate = useCallback(
    (reason?: string) => invalidateStore(workspaceRoot, reason),
    [invalidateStore, workspaceRoot],
  );

  return {
    ...entry,
    refresh,
    invalidate,
  };
}
