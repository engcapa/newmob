import { describe, expect, it } from "vitest";
import { javaTestRunCommand } from "./javaTestRun";
import type { JavaTestItem } from "../../../../lib/editor/lsp";

function item(fullName: string): JavaTestItem {
  return { name: fullName, fullName, kind: "method", uri: null, range: null, children: [] };
}

describe("javaTestRunCommand", () => {
  it("targets a single method with Maven -Dtest", () => {
    expect(javaTestRunCommand("maven", item("com.example.CalcTest#adds"), "mvn test"))
      .toBe("mvn test -Dtest='com.example.CalcTest#adds'");
  });

  it("targets a whole class with Maven", () => {
    expect(javaTestRunCommand("maven", item("com.example.CalcTest"), "./mvnw test"))
      .toBe("./mvnw test -Dtest='com.example.CalcTest'");
  });

  it("targets a single method with Gradle --tests (dotted)", () => {
    expect(javaTestRunCommand(
      "gradle",
      item("com.example.CalcTest#adds"),
      "./gradlew ':app:test'",
    )).toBe("./gradlew ':app:test' --tests 'com.example.CalcTest.adds'");
  });

  it("targets a whole class with Gradle", () => {
    expect(javaTestRunCommand("gradle", item("com.example.CalcTest"), "gradle test"))
      .toBe("gradle test --tests 'com.example.CalcTest'");
  });
});
