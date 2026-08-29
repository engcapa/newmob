import { describe, expect, it } from "vitest";
import {
  validateJavaIdentifier,
  derivePackageName,
  renderJavaTemplate,
  planJavaTemplateCreation,
  DEFAULT_JAVA_TEMPLATES,
} from "./fileTemplateModel";

describe("ED-TEMPLATE-001: fileTemplateModel Java templates", () => {
  describe("Java identifier validation", () => {
    it("accepts valid Java class names", () => {
      expect(validateJavaIdentifier("MyService").valid).toBe(true);
      expect(validateJavaIdentifier("UserDTO_V2").valid).toBe(true);
      expect(validateJavaIdentifier("$SpecialClass").valid).toBe(true);
      expect(validateJavaIdentifier("_InternalUtil").valid).toBe(true);
    });

    it("rejects empty names, invalid characters, and reserved keywords", () => {
      expect(validateJavaIdentifier("").valid).toBe(false);
      expect(validateJavaIdentifier("   ").valid).toBe(false);
      expect(validateJavaIdentifier("123Service").valid).toBe(false);
      expect(validateJavaIdentifier("My-Class").valid).toBe(false);
      expect(validateJavaIdentifier("class").valid).toBe(false);
      expect(validateJavaIdentifier("return").valid).toBe(false);
      expect(validateJavaIdentifier("record").valid).toBe(false);
    });
  });

  describe("Package derivation from source roots", () => {
    const sourceRoots = ["/workspace/app/src/main/java", "/workspace/core/src/main/java"];

    it("derives package name from nested target directory", () => {
      const pkg = derivePackageName("/workspace/app/src/main/java/com/example/api", sourceRoots);
      expect(pkg).toBe("com.example.api");
    });

    it("derives empty package when target is the source root itself", () => {
      const pkg = derivePackageName("/workspace/app/src/main/java", sourceRoots);
      expect(pkg).toBe("");
    });

    it("derives empty package when outside known source roots", () => {
      const pkg = derivePackageName("/workspace/misc/scripts", sourceRoots);
      expect(pkg).toBe("");
    });
  });

  describe("Template rendering", () => {
    it("renders Class template with package declaration", () => {
      const content = renderJavaTemplate(DEFAULT_JAVA_TEMPLATES.class, {
        name: "UserService",
        packageName: "com.example.service",
      });

      expect(content).toContain("package com.example.service;");
      expect(content).toContain("public class UserService {");
    });

    it("renders Record template without package when package is empty", () => {
      const content = renderJavaTemplate(DEFAULT_JAVA_TEMPLATES.record, {
        name: "UserRecord",
        packageName: "",
      });

      expect(content).not.toContain("package");
      expect(content).toContain("public record UserRecord() {");
    });

    it("renders Interface and Annotation templates", () => {
      const iface = renderJavaTemplate(DEFAULT_JAVA_TEMPLATES.interface, {
        name: "Repository",
        packageName: "com.example.data",
      });
      expect(iface).toContain("public interface Repository {");

      const annot = renderJavaTemplate(DEFAULT_JAVA_TEMPLATES.annotation, {
        name: "Audited",
        packageName: "com.example.audit",
      });
      expect(annot).toContain("public @interface Audited {");
    });
  });

  describe("Complete creation planning with conflict check", () => {
    const sourceRoots = ["/workspace/src/main/java"];

    it("plans valid file creation", () => {
      const result = planJavaTemplateCreation({
        kind: "class",
        name: "OrderService",
        targetDirectory: "/workspace/src/main/java/com/example/order",
        sourceRoots,
        existingFiles: ["/workspace/src/main/java/com/example/order/Order.java"],
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.targetPath).toBe("/workspace/src/main/java/com/example/order/OrderService.java");
        expect(result.packageName).toBe("com.example.order");
        expect(result.className).toBe("OrderService");
        expect(result.content).toContain("public class OrderService {");
      }
    });

    it("rejects creation if target file already exists", () => {
      const result = planJavaTemplateCreation({
        kind: "class",
        name: "Order",
        targetDirectory: "/workspace/src/main/java/com/example/order",
        sourceRoots,
        existingFiles: ["/workspace/src/main/java/com/example/order/Order.java"],
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toContain("File already exists");
        expect(result.conflictPath).toBe("/workspace/src/main/java/com/example/order/Order.java");
      }
    });
  });
});
