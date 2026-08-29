/**
 * ED-STYLE-002 / C8-D: Rearrange Code & Code Cleanup independent workflows.
 *
 * Dedicated planner and execution gates for Rearrange Code and Code Cleanup.
 * These actions FAIL CLOSED with honest, typed explanations when the language
 * server/provider does not advertise dedicated rearrange/cleanup capabilities.
 * They never disguise format or organize imports as rearrange/cleanup.
 */

export interface RearrangeCapabilities {
  rearrangeSupported: boolean;
}

export interface RearrangeInput {
  scope: "selection" | "file";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  hasSelection: boolean;
  capabilities: RearrangeCapabilities;
}

export type RearrangeDecision =
  | {
      kind: "execute";
      scope: "selection" | "file";
      stage: "rearrange";
    }
  | {
      kind: "unavailable";
      scope: "selection" | "file";
      reason: string;
    };

export function planRearrange(input: RearrangeInput): RearrangeDecision {
  const requestedScope: "selection" | "file" =
    input.scope === "selection" && input.hasSelection ? "selection" : "file";

  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: "No file is open to rearrange",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `${input.targetPath} is read-only and cannot be rearranged`,
    };
  }

  if (!input.capabilities.rearrangeSupported) {
    return {
      kind: "unavailable",
      scope: requestedScope,
      reason: `No member-rearrangement provider is available for ${input.languageId ?? "this file type"}. Rearrange Code requires a dedicated arrangement provider.`,
    };
  }

  return {
    kind: "execute",
    scope: requestedScope,
    stage: "rearrange",
  };
}

export interface CleanupCapabilities {
  cleanupSupported: boolean;
  supportedProfiles?: readonly string[];
}

export interface CleanupInput {
  scope: "file" | "directory" | "module" | "project";
  targetPath: string | null;
  languageId: string | null;
  readOnly: boolean;
  profileId?: string;
  capabilities: CleanupCapabilities;
}

export type CleanupDecision =
  | {
      kind: "execute";
      scope: "file" | "directory" | "module" | "project";
      stage: "cleanup";
      profileId: string;
    }
  | {
      kind: "unavailable";
      scope: "file" | "directory" | "module" | "project";
      reason: string;
    };

export function planCleanup(input: CleanupInput): CleanupDecision {
  if (!input.targetPath) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: "No target is selected for code cleanup",
    };
  }

  if (input.readOnly) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `${input.targetPath} is read-only and cannot be cleaned up`,
    };
  }

  if (!input.capabilities.cleanupSupported) {
    return {
      kind: "unavailable",
      scope: input.scope,
      reason: `No code cleanup provider is available for ${input.languageId ?? "this scope"}. Code Cleanup requires a dedicated batch cleanup provider.`,
    };
  }

  return {
    kind: "execute",
    scope: input.scope,
    stage: "cleanup",
    profileId: input.profileId ?? "default",
  };
}
