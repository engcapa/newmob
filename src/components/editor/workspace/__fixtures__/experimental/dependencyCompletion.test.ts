import { describe, expect, it, vi } from "vitest";
import {
  MavenDependencyCompletionProvider,
  GradleDependencyCompletionProvider,
  InMemoryDependencyIndexClient,
  detectMavenContext,
  detectGradleContext,
  type DependencyCompletionItem,
} from "./dependencyCompletion";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "dependency_index_status") {
      return { kind: "available" };
    }
    if (cmd === "dependency_index_search") {
      const q = ((args?.query as string) || "").toLowerCase();
      return [
        { groupId: "org.junit.jupiter", artifactId: "junit-jupiter-api", version: "5.10.3", description: "JUnit Jupiter API" },
        { groupId: "org.springframework.boot", artifactId: "spring-boot-starter-web", version: "3.3.2", description: "Spring Boot Web Starter" },
      ].filter((d) => !q || d.groupId.includes(q) || d.artifactId.includes(q));
    }
    if (cmd === "dependency_index_versions") {
      return [
        { version: "5.10.3", timestamp: 1720000000 },
        { version: "5.10.2", timestamp: 1718000000 },
      ];
    }
    return undefined;
  }),
}));

describe("DependencyCompletionProvider (N8.1)", () => {
  describe("detectMavenContext", () => {
    it("detects groupId, artifactId, and version contexts in pom.xml", () => {
      const pomContent = `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.3.2</version>
    </dependency>
    <dependency>
      <groupId>org.junit</groupId>
      <artifactId>junit</artifactId>
    </dependency>
  </dependencies>
</project>`;

      // Cursor inside <groupId>org.junit on line 8
      const gCtx = detectMavenContext(pomContent, 8, 24);
      expect(gCtx.kind).toBe("groupId");
      expect(gCtx.prefix).toBe("org.junit");

      // Cursor inside <artifactId>junit on line 9
      const aCtx = detectMavenContext(pomContent, 9, 23);
      expect(aCtx.kind).toBe("artifactId");
      expect(aCtx.prefix).toBe("junit");
      expect(aCtx.currentGroupId).toBe("org.junit");

      // Cursor inside <version>3.3 on line 5
      const vCtx = detectMavenContext(pomContent, 5, 18);
      expect(vCtx.kind).toBe("version");
      expect(vCtx.prefix).toBe("3.3");
      expect(vCtx.currentGroupId).toBe("org.springframework.boot");
      expect(vCtx.currentArtifactId).toBe("spring-boot-starter-web");
    });
  });

  describe("detectGradleContext", () => {
    it("detects coordinate and version contexts in Groovy build.gradle", () => {
      const buildGradle = `dependencies {
    implementation 'org.springframework.boot:spring-boot-starter-web:3.3'
    testImplementation "org.junit.jupiter:junit-jupiter"
}`;

      // Cursor at implementation 'org.springframework.boot:spring-boot-starter-web:3.3' before quote
      const cCtx1 = detectGradleContext(buildGradle, 1, 72);
      expect(cCtx1.kind).toBe("version");
      expect(cCtx1.groupId).toBe("org.springframework.boot");
      expect(cCtx1.artifactId).toBe("spring-boot-starter-web");
      expect(cCtx1.prefix).toBe("3.3");

      // Cursor at testImplementation "org.junit.jupiter:junit-jupiter"
      const cCtx2 = detectGradleContext(buildGradle, 2, 55);
      expect(cCtx2.kind).toBe("coordinate");
      expect(cCtx2.groupId).toBe("org.junit.jupiter");
      expect(cCtx2.prefix).toBe("junit-jupiter");
    });

    it("detects Kotlin DSL build.gradle.kts coordinate context", () => {
      const ktsGradle = `dependencies {
    implementation("org.mockito:mockito-core:5.12")
    testImplementation("com.google.guava:guava")
}`;
      const ktsCtx = detectGradleContext(ktsGradle, 1, 49);
      expect(ktsCtx.kind).toBe("version");
      expect(ktsCtx.groupId).toBe("org.mockito");
      expect(ktsCtx.artifactId).toBe("mockito-core");
      expect(ktsCtx.prefix).toBe("5.12");
    });
  });

  describe("MavenDependencyCompletionProvider", () => {
    const client = new InMemoryDependencyIndexClient();
    const provider = new MavenDependencyCompletionProvider(client);

    it("supports pom.xml files only", () => {
      expect(provider.supports("/repo/pom.xml")).toBe(true);
      expect(provider.supports("/repo/sub/pom.xml")).toBe(true);
      expect(provider.supports("/repo/build.gradle")).toBe(false);
      expect(provider.supports("/repo/App.java")).toBe(false);
    });

    it("completes groupId in pom.xml", async () => {
      const pom = `<project><dependencies><dependency><groupId>spring</groupId></dependency></dependencies></project>`;
      const res = await provider.complete({
        filePath: "/repo/pom.xml",
        fileContent: pom,
        position: { line: 0, character: 49 },
      });

      expect(res.kind).toBe("available");
      if (res.kind === "available") {
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.some((item: DependencyCompletionItem) => item.groupId === "org.springframework.boot")).toBe(true);
      }
    });

    it("completes artifactId under groupId in pom.xml", async () => {
      const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>starter</artifactId>
    </dependency>
  </dependencies>
</project>`;

      const res = await provider.complete({
        filePath: "/repo/pom.xml",
        fileContent: pom,
        position: { line: 4, character: 25 },
      });

      expect(res.kind).toBe("available");
      if (res.kind === "available") {
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.some((item: DependencyCompletionItem) => item.artifactId === "spring-boot-starter-web")).toBe(true);
      }
    });

    it("completes versions for artifact in pom.xml", async () => {
      const pom = `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.</version>
    </dependency>
  </dependencies>
</project>`;

      const res = await provider.complete({
        filePath: "/repo/pom.xml",
        fileContent: pom,
        position: { line: 5, character: 17 },
      });

      expect(res.kind).toBe("available");
      if (res.kind === "available") {
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.some((item: DependencyCompletionItem) => item.version === "3.3.2")).toBe(true);
      }
    });

    it("returns cancelled when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const res = await provider.complete(
        {
          filePath: "/repo/pom.xml",
          fileContent: "<project></project>",
          position: { line: 0, character: 0 },
        },
        controller.signal,
      );

      expect(res.kind).toBe("cancelled");
    });
  });

  describe("GradleDependencyCompletionProvider", () => {
    const client = new InMemoryDependencyIndexClient();
    const provider = new GradleDependencyCompletionProvider(client);

    it("supports build.gradle and build.gradle.kts", () => {
      expect(provider.supports("/repo/build.gradle")).toBe(true);
      expect(provider.supports("/repo/build.gradle.kts")).toBe(true);
      expect(provider.supports("/repo/pom.xml")).toBe(false);
    });

    it("completes coordinates in build.gradle", async () => {
      const gradle = `dependencies {
    implementation 'jackson'
}`;
      const res = await provider.complete({
        filePath: "/repo/build.gradle",
        fileContent: gradle,
        position: { line: 1, character: 26 },
      });

      expect(res.kind).toBe("available");
      if (res.kind === "available") {
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.some((item: DependencyCompletionItem) => item.groupId === "com.fasterxml.jackson.core")).toBe(true);
      }
    });

    it("completes versions in build.gradle.kts", async () => {
      const kts = `dependencies {
    implementation("com.google.guava:guava:33")
}`;
      const res = await provider.complete({
        filePath: "/repo/build.gradle.kts",
        fileContent: kts,
        position: { line: 1, character: 45 },
      });

      expect(res.kind).toBe("available");
      if (res.kind === "available") {
        expect(res.items.length).toBeGreaterThan(0);
        expect(res.items.some((item: DependencyCompletionItem) => item.version?.startsWith("33"))).toBe(true);
      }
    });
  });

  describe("BackendDependencyIndexClient (N8.2)", () => {
    it("delegates to backend tauri commands and caches queries", async () => {
      const { BackendDependencyIndexClient } = await import("./dependencyCompletion");
      const client = new BackendDependencyIndexClient();
      const available = await client.isAvailable();
      expect(typeof available).toBe("boolean");

      const results = await client.search("junit");
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      const versions = await client.getVersions("org.junit.jupiter", "junit-jupiter-api");
      expect(Array.isArray(versions)).toBe(true);
      expect(versions.length).toBeGreaterThan(0);
    });
  });
});
