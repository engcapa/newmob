import { invoke } from "@tauri-apps/api/core";

export interface MavenToolingRequest {
  workspaceRoot: string;
  trusted: boolean;
  javaHome?: string | null;
  mavenExecutable?: string | null;
  offline?: boolean;
}

export interface MavenToolingProvenance {
  toolKind: string;
  toolVersion: string | null;
  javaHome: string | null;
  javaVersion: string | null;
  argv: string[];
  cwd: string;
  pomHash: string;
  resolvedAt: string;
}

export interface MavenModuleStructure {
  id: string;
  name: string;
  root: string;
  pomPath: string;
  sourceRoots: string[];
  testRoots: string[];
  resourceRoots: string[];
  outputDir: string | null;
  dependencies: string[];
  classpath: string[];
}

export interface MavenToolingResult {
  status: "ready" | "untrusted" | "degraded" | "failed";
  modules: MavenModuleStructure[];
  provenance: MavenToolingProvenance | null;
  errorMessage: string | null;
}

/**
 * Ingests a Maven project structure with provenance and trust enforcement (ED-PROJECT-002).
 */
export function workspaceIngestMavenProject(request: MavenToolingRequest): Promise<MavenToolingResult> {
  return invoke<MavenToolingResult>("workspace_ingest_maven_project", { request });
}

export interface GradleToolingRequest {
  workspaceRoot: string;
  trusted: boolean;
  javaHome?: string | null;
  gradleExecutable?: string | null;
  offline?: boolean;
}

export interface GradleToolingProvenance {
  toolKind: string;
  toolVersion: string | null;
  javaHome: string | null;
  javaVersion: string | null;
  argv: string[];
  cwd: string;
  settingsHash: string;
  resolvedAt: string;
}

export interface GradleModuleStructure {
  id: string;
  name: string;
  root: string;
  buildFile: string;
  sourceRoots: string[];
  testRoots: string[];
  resourceRoots: string[];
  outputDir: string | null;
  dependencies: string[];
  classpath: string[];
}

export interface GradleToolingResult {
  status: "ready" | "untrusted" | "degraded" | "failed";
  modules: GradleModuleStructure[];
  provenance: GradleToolingProvenance | null;
  errorMessage: string | null;
}

/**
 * Ingests a Gradle project structure with provenance and trust enforcement (ED-PROJECT-003).
 */
export function workspaceIngestGradleProject(request: GradleToolingRequest): Promise<GradleToolingResult> {
  return invoke<GradleToolingResult>("workspace_ingest_gradle_project", { request });
}
