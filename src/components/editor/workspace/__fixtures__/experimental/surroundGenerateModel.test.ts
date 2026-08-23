import { describe, expect, it } from "vitest";
import {
  SURROUND_TEMPLATES,
  applySurround,
  generateJavaCode,
  type FieldDescriptor,
} from "./surroundGenerateModel";

describe("surroundGenerateModel", () => {
  it("applies if-template to selected code", () => {
    const ifTpl = SURROUND_TEMPLATES.find((t) => t.id === "surround.if")!;
    const input = "  doSomething();\n  doOtherThing();";
    const result = applySurround(input, ifTpl, "  ");

    expect(result).toContain("if (condition) {");
    expect(result).toContain("    doSomething();");
    expect(result).toContain("}");
  });

  it("applies try-catch template for Java", () => {
    const tryCatchTpl = SURROUND_TEMPLATES.find((t) => t.id === "surround.tryCatch")!;
    const input = "  riskyOperation();";
    const result = applySurround(input, tryCatchTpl, "  ");

    expect(result).toContain("try {");
    expect(result).toContain("catch (Exception e)");
  });

  it("generates Java constructors with parameters and assignments", () => {
    const fields: FieldDescriptor[] = [
      { name: "id", type: "String" },
      { name: "age", type: "int" },
    ];
    const code = generateJavaCode("constructor", "Person", fields, "  ");

    expect(code).toContain("public Person(String id, int age)");
    expect(code).toContain("this.id = id;");
    expect(code).toContain("this.age = age;");
  });

  it("generates Java getters and setters", () => {
    const fields: FieldDescriptor[] = [
      { name: "name", type: "String" },
    ];
    const code = generateJavaCode("gettersAndSetters", "Person", fields, "  ");

    expect(code).toContain("public String getName()");
    expect(code).toContain("public void setName(String name)");
  });

  it("generates Java toString method", () => {
    const fields: FieldDescriptor[] = [
      { name: "name", type: "String" },
    ];
    const code = generateJavaCode("toString", "Person", fields, "  ");

    expect(code).toContain("@Override");
    expect(code).toContain('return "Person{" +');
  });

  it("generates Java equals and hashCode methods", () => {
    const fields: FieldDescriptor[] = [
      { name: "id", type: "String" },
    ];
    const code = generateJavaCode("equalsAndHashCode", "Person", fields, "  ");

    expect(code).toContain("public boolean equals(Object o)");
    expect(code).toContain("public int hashCode()");
    expect(code).toContain("java.util.Objects.hash(id)");
  });
});
