/**
 * Dependency Completion Provider (N8 - IDEA 2026.2 Parity).
 *
 * Provides intelligent build file dependency completion for Maven (pom.xml)
 * and Gradle (build.gradle Groovy / build.gradle.kts Kotlin DSL).
 */

export type DependencyCompletionKind = "groupId" | "artifactId" | "version" | "coordinate";

export interface DependencyCompletionItem {
  label: string;
  groupId?: string;
  artifactId?: string;
  version?: string;
  insertText: string;
  detail?: string;
  documentation?: string;
  kind: DependencyCompletionKind;
}

export interface DependencyCompletionContext {
  filePath: string;
  fileContent: string;
  position: { line: number; character: number };
  triggerCharacter?: string;
}

export type DependencyProviderCapability = "available" | "unavailable" | "error";

export type DependencyCompletionResult =
  | {
      kind: "available";
      items: DependencyCompletionItem[];
      replacementRange?: { from: number; to: number };
      requestId?: string;
    }
  | {
      kind: "unavailable" | "error" | "cancelled" | "timeout";
      reason: string;
      retryable?: boolean;
      requestId?: string;
    };

export interface DependencyCompletionProvider {
  readonly id: string;
  readonly name: string;
  supports(filePath: string): boolean;
  getCapabilityState(): DependencyProviderCapability;
  complete(
    context: DependencyCompletionContext,
    signal?: AbortSignal,
  ): Promise<DependencyCompletionResult>;
}

export interface MavenDependencyIndexEntry {
  groupId: string;
  artifactId: string;
  versions: string[];
  description?: string;
}

// Builtin popular Java dependencies index for reliable offline and fast local completion
export const POPULAR_JAVA_DEPENDENCIES: MavenDependencyIndexEntry[] = [
  {
    groupId: "org.springframework.boot",
    artifactId: "spring-boot-starter-web",
    versions: ["3.3.2", "3.3.1", "3.2.8", "3.1.12"],
    description: "Starter for building web, including RESTful, applications using Spring MVC.",
  },
  {
    groupId: "org.springframework.boot",
    artifactId: "spring-boot-starter-test",
    versions: ["3.3.2", "3.3.1", "3.2.8"],
    description: "Starter for testing Spring Boot applications with libraries including JUnit Jupiter, Hamcrest and Mockito.",
  },
  {
    groupId: "org.springframework.boot",
    artifactId: "spring-boot-starter-data-jpa",
    versions: ["3.3.2", "3.3.1", "3.2.8"],
    description: "Starter for using Spring Data JPA with Hibernate.",
  },
  {
    groupId: "org.junit.jupiter",
    artifactId: "junit-jupiter-api",
    versions: ["5.10.3", "5.10.2", "5.9.3"],
    description: "JUnit Jupiter API for writing tests.",
  },
  {
    groupId: "org.junit.jupiter",
    artifactId: "junit-jupiter-engine",
    versions: ["5.10.3", "5.10.2", "5.9.3"],
    description: "JUnit Jupiter test engine implementation.",
  },
  {
    groupId: "org.mockito",
    artifactId: "mockito-core",
    versions: ["5.12.0", "5.11.0", "4.11.0"],
    description: "Mock library for Java.",
  },
  {
    groupId: "org.mockito",
    artifactId: "mockito-junit-jupiter",
    versions: ["5.12.0", "5.11.0"],
    description: "Mockito JUnit Jupiter extension.",
  },
  {
    groupId: "com.fasterxml.jackson.core",
    artifactId: "jackson-databind",
    versions: ["2.17.2", "2.17.1", "2.16.2"],
    description: "General data-binding functionality for Jackson JSON processor.",
  },
  {
    groupId: "org.slf4j",
    artifactId: "slf4j-api",
    versions: ["2.0.13", "2.0.12", "1.7.36"],
    description: "The slf4j API.",
  },
  {
    groupId: "ch.qos.logback",
    artifactId: "logback-classic",
    versions: ["1.5.6", "1.4.14", "1.2.13"],
    description: "Logback classic module for logging.",
  },
  {
    groupId: "com.google.guava",
    artifactId: "guava",
    versions: ["33.2.1-jre", "33.1.0-jre", "32.1.3-jre"],
    description: "Guava is a suite of core and expanded libraries for Java.",
  },
  {
    groupId: "org.projectlombok",
    artifactId: "lombok",
    versions: ["1.18.34", "1.18.32", "1.18.30"],
    description: "Spice up your java: Automatic Resource Management, automatic generation of getters, setters, equals, hashCode and toString!",
  },
  {
    groupId: "org.apache.commons",
    artifactId: "commons-lang3",
    versions: ["3.15.0", "3.14.0", "3.12.0"],
    description: "Apache Commons Lang, a package of Java utility classes.",
  },
];

/**
 * Detect context kind in pom.xml at cursor position.
 */
export function detectMavenContext(
  content: string,
  line: number,
  character: number,
): { kind: "groupId" | "artifactId" | "version" | "none"; prefix: string; currentGroupId?: string; currentArtifactId?: string } {
  const lines = content.split("\n");
  const lineText = lines[line] ?? "";
  const beforeCursor = lineText.slice(0, character);

  // Match <groupId>...</groupId> or partial <groupId>...
  const groupMatch = beforeCursor.match(/<groupId>([^<]*)$/i);
  if (groupMatch) {
    return { kind: "groupId", prefix: groupMatch[1] ?? "" };
  }

  // Match <artifactId>...</artifactId>
  const artifactMatch = beforeCursor.match(/<artifactId>([^<]*)$/i);
  if (artifactMatch) {
    let currentGroupId: string | undefined;
    for (let i = line; i >= Math.max(0, line - 10); i--) {
      const gMatch = (lines[i] ?? "").match(/<groupId>([^<]+)<\/groupId>/i);
      if (gMatch && gMatch[1]) {
        currentGroupId = gMatch[1].trim();
        break;
      }
    }
    return { kind: "artifactId", prefix: artifactMatch[1] ?? "", currentGroupId };
  }

  // Match <version>...</version>
  const versionMatch = beforeCursor.match(/<version>([^<]*)$/i);
  if (versionMatch) {
    let currentGroupId: string | undefined;
    let currentArtifactId: string | undefined;
    for (let i = line; i >= Math.max(0, line - 12); i--) {
      const l = lines[i] ?? "";
      const gMatch = l.match(/<groupId>([^<]+)<\/groupId>/i);
      if (gMatch && gMatch[1] && !currentGroupId) {
        currentGroupId = gMatch[1].trim();
      }
      const aMatch = l.match(/<artifactId>([^<]+)<\/artifactId>/i);
      if (aMatch && aMatch[1] && !currentArtifactId) {
        currentArtifactId = aMatch[1].trim();
      }
    }
    return { kind: "version", prefix: versionMatch[1] ?? "", currentGroupId, currentArtifactId };
  }

  return { kind: "none", prefix: "" };
}

/**
 * Detect context in build.gradle / build.gradle.kts at cursor position.
 */
export function detectGradleContext(
  content: string,
  line: number,
  character: number,
): { kind: "coordinate" | "version" | "none"; prefix: string; groupId?: string; artifactId?: string } {
  const lines = content.split("\n");
  const lineText = lines[line] ?? "";
  const beforeCursor = lineText.slice(0, character);

  // Gradle dependency configurations: implementation, api, testImplementation, etc.
  const configMatch = beforeCursor.match(/(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)\s*(?:\(\s*)?["']([^"']*)$/);
  if (configMatch) {
    const raw = configMatch[1] ?? "";
    const parts = raw.split(":");
    if (parts.length === 1) {
      return { kind: "coordinate", prefix: parts[0] ?? "" };
    }
    if (parts.length === 2) {
      return { kind: "coordinate", prefix: parts[1] ?? "", groupId: parts[0] };
    }
    if (parts.length === 3) {
      return { kind: "version", prefix: parts[2] ?? "", groupId: parts[0], artifactId: parts[1] };
    }
  }

  return { kind: "none", prefix: "" };
}

export interface DependencyIndexClient {
  search(
    query: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MavenDependencyIndexEntry[]>;
  isAvailable(): Promise<boolean>;
}

export class MavenCentralDependencyIndexClient implements DependencyIndexClient {
  private cache = new Map<string, { entries: MavenDependencyIndexEntry[]; timestamp: number }>();
  private readonly maxCacheSize: number;
  private readonly ttlMs: number;
  private readonly baseUrl: string;

  constructor(options?: { maxCacheSize?: number; ttlMs?: number; baseUrl?: string }) {
    this.maxCacheSize = options?.maxCacheSize ?? 100;
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
    this.baseUrl = options?.baseUrl ?? "https://search.maven.org/solrsearch/select";
  }

  async isAvailable(): Promise<boolean> {
    return typeof fetch === "function";
  }

  async search(
    query: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MavenDependencyIndexEntry[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const cached = this.cache.get(trimmed);
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.entries;
    }

    const timeoutMs = options?.timeoutMs ?? 3000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const onAbort = () => controller.abort();
    options?.signal?.addEventListener("abort", onAbort);

    try {
      const url = `${this.baseUrl}?q=${encodeURIComponent(trimmed)}&rows=20&wt=json`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Maven Central returned HTTP ${response.status}`);
      }
      const data = await response.json();
      const docs = data?.response?.docs ?? [];
      const entries: MavenDependencyIndexEntry[] = docs.map((doc: Record<string, unknown>) => ({
        groupId: String(doc.g ?? ""),
        artifactId: String(doc.a ?? ""),
        versions: Array.isArray(doc.tags)
          ? (doc.tags as string[])
          : doc.v
            ? [String(doc.v)]
            : [],
        description: doc.text ? String(doc.text) : `${doc.g}:${doc.a}`,
      }));

      // Bounded LRU cache eviction
      if (this.cache.size >= this.maxCacheSize) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey) this.cache.delete(oldestKey);
      }
      this.cache.set(trimmed, { entries, timestamp: Date.now() });
      return entries;
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class InMemoryDependencyIndexClient implements DependencyIndexClient {
  constructor(private entries: MavenDependencyIndexEntry[] = POPULAR_JAVA_DEPENDENCIES) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(
    query: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MavenDependencyIndexEntry[]> {
    if (options?.signal?.aborted) {
      throw new Error("Operation cancelled.");
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.entries;
    return this.entries.filter((e) => {
      const g = e.groupId.toLowerCase();
      const a = e.artifactId.toLowerCase();
      const d = (e.description || "").toLowerCase();
      return words.every(
        (w) =>
          g.includes(w) ||
          a.includes(w) ||
          d.includes(w) ||
          e.versions.some((v) => v.toLowerCase().includes(w)),
      );
    });
  }
}

export class MavenDependencyCompletionProvider implements DependencyCompletionProvider {
  readonly id = "maven-dependency-completion";
  readonly name = "Maven POM Dependency Completion";

  private client: DependencyIndexClient;
  private capabilityState: DependencyProviderCapability = "available";

  constructor(client?: DependencyIndexClient) {
    this.client = client ?? new MavenCentralDependencyIndexClient();
  }

  supports(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return normalized.endsWith("pom.xml") || normalized.endsWith(".pom");
  }

  getCapabilityState(): DependencyProviderCapability {
    return this.capabilityState;
  }

  async complete(
    context: DependencyCompletionContext,
    signal?: AbortSignal,
  ): Promise<DependencyCompletionResult> {
    if (!this.supports(context.filePath)) {
      return { kind: "unavailable", reason: "File not supported for Maven dependency completion." };
    }

    if (signal?.aborted) {
      return { kind: "cancelled", reason: "Completion cancelled." };
    }

    const ctx = detectMavenContext(context.fileContent, context.position.line, context.position.character);
    if (ctx.kind === "none") {
      return { kind: "available", items: [] };
    }

    const requestId = `req-mvn-${Date.now().toString(36)}`;
    const searchQuery = ctx.currentArtifactId
      ? `${ctx.currentGroupId ?? ""} ${ctx.currentArtifactId}`
      : ctx.currentGroupId
        ? ctx.currentGroupId
        : ctx.prefix || "org";

    try {
      const entries = await this.client.search(searchQuery, { signal, timeoutMs: 3000 });
      this.capabilityState = "available";
      const items: DependencyCompletionItem[] = [];

      if (ctx.kind === "groupId") {
        const seen = new Set<string>();
        for (const entry of entries) {
          if (!seen.has(entry.groupId) && entry.groupId.toLowerCase().includes(ctx.prefix.toLowerCase())) {
            seen.add(entry.groupId);
            items.push({
              label: entry.groupId,
              groupId: entry.groupId,
              insertText: entry.groupId,
              detail: entry.description,
              kind: "groupId",
            });
          }
        }
      } else if (ctx.kind === "artifactId") {
        for (const entry of entries) {
          if (ctx.currentGroupId && entry.groupId !== ctx.currentGroupId) continue;
          if (entry.artifactId.toLowerCase().includes(ctx.prefix.toLowerCase())) {
            items.push({
              label: entry.artifactId,
              groupId: entry.groupId,
              artifactId: entry.artifactId,
              insertText: entry.artifactId,
              detail: `${entry.groupId}:${entry.artifactId}`,
              documentation: entry.description,
              kind: "artifactId",
            });
          }
        }
      } else if (ctx.kind === "version") {
        for (const entry of entries) {
          if (ctx.currentGroupId && entry.groupId !== ctx.currentGroupId) continue;
          if (ctx.currentArtifactId && entry.artifactId !== ctx.currentArtifactId) continue;
          for (const ver of entry.versions) {
            if (ver.toLowerCase().includes(ctx.prefix.toLowerCase())) {
              items.push({
                label: ver,
                groupId: entry.groupId,
                artifactId: entry.artifactId,
                version: ver,
                insertText: ver,
                detail: `${entry.groupId}:${entry.artifactId}:${ver}`,
                kind: "version",
              });
            }
          }
        }
      }

      return { kind: "available", items, requestId };
    } catch (err) {
      if (signal?.aborted) {
        return { kind: "cancelled", reason: "Completion cancelled.", requestId };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timed out")) {
        return { kind: "timeout", reason: "Maven Central request timed out (3s limit).", retryable: true, requestId };
      }
      this.capabilityState = "error";
      return { kind: "error", reason: `Dependency index error: ${msg}`, retryable: true, requestId };
    }
  }
}

export class GradleDependencyCompletionProvider implements DependencyCompletionProvider {
  readonly id = "gradle-dependency-completion";
  readonly name = "Gradle Build Script Dependency Completion";

  private client: DependencyIndexClient;
  private capabilityState: DependencyProviderCapability = "available";

  constructor(client?: DependencyIndexClient) {
    this.client = client ?? new MavenCentralDependencyIndexClient();
  }

  supports(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    return (
      normalized.endsWith("build.gradle") ||
      normalized.endsWith("build.gradle.kts") ||
      normalized.endsWith("settings.gradle") ||
      normalized.endsWith("settings.gradle.kts")
    );
  }

  getCapabilityState(): DependencyProviderCapability {
    return this.capabilityState;
  }

  async complete(
    context: DependencyCompletionContext,
    signal?: AbortSignal,
  ): Promise<DependencyCompletionResult> {
    if (!this.supports(context.filePath)) {
      return { kind: "unavailable", reason: "File not supported for Gradle dependency completion." };
    }

    if (signal?.aborted) {
      return { kind: "cancelled", reason: "Completion cancelled." };
    }

    const ctx = detectGradleContext(context.fileContent, context.position.line, context.position.character);
    if (ctx.kind === "none") {
      return { kind: "available", items: [] };
    }

    const requestId = `req-grd-${Date.now().toString(36)}`;
    const searchQuery = ctx.kind === "version"
      ? `${ctx.groupId ?? ""} ${ctx.artifactId ?? ""}`.trim() || ctx.prefix || "org"
      : ctx.groupId
        ? `${ctx.groupId} ${ctx.prefix}`
        : ctx.prefix || "org";

    try {
      const entries = await this.client.search(searchQuery, { signal, timeoutMs: 3000 });
      this.capabilityState = "available";
      const items: DependencyCompletionItem[] = [];

      if (ctx.kind === "coordinate") {
        for (const entry of entries) {
          const latestVer = entry.versions[0] ?? "";
          const fullCoord = `${entry.groupId}:${entry.artifactId}:${latestVer}`;
          if (
            !ctx.groupId &&
            (entry.groupId.toLowerCase().includes(ctx.prefix.toLowerCase()) ||
              entry.artifactId.toLowerCase().includes(ctx.prefix.toLowerCase()))
          ) {
            items.push({
              label: `${entry.groupId}:${entry.artifactId}`,
              groupId: entry.groupId,
              artifactId: entry.artifactId,
              version: latestVer,
              insertText: fullCoord,
              detail: entry.description,
              kind: "coordinate",
            });
          } else if (ctx.groupId && entry.groupId === ctx.groupId) {
            if (entry.artifactId.toLowerCase().includes(ctx.prefix.toLowerCase())) {
              items.push({
                label: `${entry.artifactId}:${latestVer}`,
                groupId: entry.groupId,
                artifactId: entry.artifactId,
                version: latestVer,
                insertText: `${entry.artifactId}:${latestVer}`,
                detail: entry.description,
                kind: "coordinate",
              });
            }
          }
        }
      } else if (ctx.kind === "version") {
        for (const entry of entries) {
          if (ctx.groupId && entry.groupId !== ctx.groupId) continue;
          if (ctx.artifactId && entry.artifactId !== ctx.artifactId) continue;
          for (const ver of entry.versions) {
            if (ver.toLowerCase().includes(ctx.prefix.toLowerCase())) {
              items.push({
                label: ver,
                groupId: entry.groupId,
                artifactId: entry.artifactId,
                version: ver,
                insertText: ver,
                detail: `${entry.groupId}:${entry.artifactId}:${ver}`,
                kind: "version",
              });
            }
          }
        }
      }

      return { kind: "available", items, requestId };
    } catch (err) {
      if (signal?.aborted) {
        return { kind: "cancelled", reason: "Completion cancelled.", requestId };
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timed out")) {
        return { kind: "timeout", reason: "Maven Central request timed out (3s limit).", retryable: true, requestId };
      }
      this.capabilityState = "error";
      return { kind: "error", reason: `Dependency index error: ${msg}`, retryable: true, requestId };
    }
  }
}
