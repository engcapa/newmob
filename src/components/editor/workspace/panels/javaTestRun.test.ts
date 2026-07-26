import { describe, expect, it } from "vitest";
import { defaultRunner, javaTestRunCommand } from "./javaTestRun";
import type { JavaTestItem } from "../../../../lib/editor/lsp";

function item(fullName: string): JavaTestItem {
  return { name: fullName, fullName, kind: "method", uri: null, range: null, children: [] };
}

describe("javaTestRunCommand", () => {
  it("targets a single method with Maven -Dtest", () => {
    expect(javaTestRunCommand("maven", item("com.example.CalcTest#adds"), "mvn"))
      .toBe("mvn test -Dtest='com.example.CalcTest#adds'");
  });

  it("targets a whole class with Maven", () => {
    expect(javaTestRunCommand("maven", item("com.example.CalcTest"), "./mvnw"))
      .toBe("./mvnw test -Dtest='com.example.CalcTest'");
  });

  it("targets a single method with Gradle --tests (dotted)", () => {
    expect(javaTestRunCommand("gradle", item("com.example.CalcTest#adds"), "./gradlew"))
      .toBe("./gradlew test --tests 'com.example.CalcTest.adds'");
  });

  it("targets a whole class with Gradle", () => {
    expect(javaTestRunCommand("gradle", item("com.example.CalcTest"), "gradle"))
      .toBe("gradle test --tests 'com.example.CalcTest'");
  });

  it("exposes default runners", () => {
    expect(defaultRunner("maven")).toBe("mvn");
    expect(defaultRunner("gradle")).toBe("gradle");
  });
});
