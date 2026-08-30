/**
 * Identity attached to a diagnostic report. A report is only usable while all
 * of these values still describe the active buffer and provider session.
 */
export interface DiagnosticScope {
  fileKey: string;
  revision: number;
  providerId: string | null;
  providerGeneration: number;
  uri: string | null;
}

export function isDiagnosticScopeCurrent(
  scope: DiagnosticScope | null | undefined,
  expected: DiagnosticScope,
): boolean {
  return !!scope
    && scope.fileKey === expected.fileKey
    && scope.revision === expected.revision
    && scope.providerId === expected.providerId
    && scope.providerGeneration === expected.providerGeneration
    && scope.uri === expected.uri;
}
