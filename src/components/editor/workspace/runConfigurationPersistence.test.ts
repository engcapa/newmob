import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionDebugConfiguration, ExecutionRunConfiguration } from "../../../lib/editor/workspace";
import {
  applyRunOverrideToJavaLaunch,
  applyRunConfigurationOverride,
  applyRunOverrideToDebugConfiguration,
  createNamedRunConfiguration,
  materializeRunConfigurations,
  mergeDebugEnvironment,
  parseDotEnv,
  parseEnvironmentLines,
  readActiveRunConfigurationSelection,
  readActiveRunConfigurationSelections,
  readRunConfigurationOverrides,
  splitCompatibilityCommand,
  writeRunConfigurationOverride,
  writeActiveRunConfigurationSelection,
  javaRunTargetToExecutionRunConfiguration,
} from "./runConfigurationPersistence";

const run: ExecutionRunConfiguration = {
  id: "run:demo",
  projectId: "project:demo",
  label: "Run demo",
  kind: "bin",
  command: {
    executable: "cargo",
    args: ["run", "--bin", "demo", "--"],
    cwd: "/repo",
    env: {},
    display: "cargo run --bin demo --",
    source: "path",
  },
  preLaunchTargets: [],
};

afterEach(() => window.localStorage.clear());

describe("run configuration persistence", () => {
  it("materializes Java fallback targets as configurable run configurations", () => {
    const configuration = javaRunTargetToExecutionRunConfiguration({
      id: "java-main:src/Main.java",
      label: "demo.Main",
      mainClass: "demo.Main",
      filePath: "/repo/src/Main.java",
      command: "./gradlew :app:taomniRun",
      cwd: "/repo",
      buildSystem: "gradle",
      modulePath: "app",
      execution: {
        executable: "./gradlew",
        args: [":app:taomniRun"],
        source: "wrapper",
      },
      environment: { MAVEN_OPTS: { value: "-Xmx1g", mode: "append" } },
    });
    expect(configuration).toMatchObject({
      id: "java-main:src/Main.java",
      kind: "java-main",
      sourceFile: "/repo/src/Main.java",
      command: {
        executable: "./gradlew",
        args: [":app:taomniRun"],
        cwd: "/repo",
        env: { MAVEN_OPTS: "-Xmx1g" },
      },
      argumentStrategy: "gradle-javaexec",
      environmentModes: { MAVEN_OPTS: "append" },
    });
  });

  it("recovers executable and quoted argv from legacy Java target commands", () => {
    expect(splitCompatibilityCommand("./mvnw -q -Dexec.mainClass='com.acme.App' compile exec:java"))
      .toEqual(["./mvnw", "-q", "-Dexec.mainClass=com.acme.App", "compile", "exec:java"]);
    expect(splitCompatibilityCommand("java \"/repo/My App.java\" ''"))
      .toEqual(["java", "/repo/My App.java", ""]);
    expect(splitCompatibilityCommand("\"C:\\Program Files\\Java\\bin\\java.exe\" \"C:\\repo\\My App.java\""))
      .toEqual(["C:\\Program Files\\Java\\bin\\java.exe", "C:\\repo\\My App.java"]);
    expect(splitCompatibilityCommand("\\\\server\\share\\java.exe Main"))
      .toEqual(["\\\\server\\share\\java.exe", "Main"]);

    const configuration = javaRunTargetToExecutionRunConfiguration({
      id: "java-main:src/Main.java",
      label: "Main",
      mainClass: "Main",
      filePath: "/repo/src/Main.java",
      command: "java '/repo/src/Main.java'",
      cwd: "/repo",
      buildSystem: "source-file",
      modulePath: ".",
    });
    expect(configuration.command).toMatchObject({
      executable: "java",
      args: ["/repo/src/Main.java"],
    });
  });

  it("places Java program arguments in Maven and Gradle runner options", () => {
    const base = javaRunTargetToExecutionRunConfiguration({
      id: "java-main:src/Main.java", label: "Main", mainClass: "Main",
      filePath: "/repo/src/Main.java", cwd: "/repo", modulePath: ".",
      command: "mvn compile exec:java", buildSystem: "maven",
      execution: {
        executable: "mvn",
        args: ["-Dexec.mainClass=Main", "compile", "exec:java"],
        source: "path",
      },
    });
    expect(applyRunConfigurationOverride(base, {
      args: ["hello world", "--verbose"], cwd: "", env: {},
    }).command.args).toContain("-Dexec.args='hello world' --verbose");

    const gradle = {
      ...base,
      argumentStrategy: "gradle-javaexec" as const,
      command: { ...base.command, executable: "gradle", args: ["taomniRun"] },
    };
    expect(applyRunConfigurationOverride(gradle, {
      args: ["hello world"], cwd: "", env: {},
    }).command.args).toEqual(["taomniRun", "--args", "'hello world'"]);
  });

  it("clears provider program-argument slots without removing required argv", () => {
    const maven: ExecutionRunConfiguration = {
      ...run,
      argumentStrategy: "maven-exec",
      command: {
        ...run.command,
        executable: "mvn",
        args: ["compile", "exec:java", "-Dexec.mainClass=Main", "-Dexec.args=stale"],
      },
    };
    expect(applyRunConfigurationOverride(maven, { args: [], cwd: "", env: {} }).command.args)
      .toEqual(["compile", "exec:java", "-Dexec.mainClass=Main"]);

    const gradle: ExecutionRunConfiguration = {
      ...run,
      argumentStrategy: "gradle-javaexec",
      command: {
        ...run.command,
        executable: "gradle",
        args: ["taomniRun", "--console=plain", "--args", "stale"],
      },
    };
    expect(applyRunConfigurationOverride(gradle, { args: [], cwd: "", env: {} }).command.args)
      .toEqual(["taomniRun", "--console=plain"]);

    // Generic providers keep their structural argv because the frontend cannot
    // infer where a provider-specific program-argument delimiter begins.
    expect(applyRunConfigurationOverride(run, { args: [], cwd: "", env: {} }).command.args)
      .toEqual(run.command.args);
  });

  it("preserves inherited append environment semantics unless explicitly overridden", () => {
    const base = javaRunTargetToExecutionRunConfiguration({
      id: "java-main:src/Main.java", label: "Main", mainClass: "Main",
      filePath: "/repo/src/Main.java", cwd: "/repo", modulePath: ".",
      command: "mvn exec:java", buildSystem: "maven",
      execution: { executable: "mvn", args: ["exec:java"], source: "path" },
      environment: { MAVEN_OPTS: { value: "--add-opens=a/b=c", mode: "append" } },
    });
    expect(base.environmentModes).toEqual({ MAVEN_OPTS: "append" });
    expect(applyRunConfigurationOverride(base, {
      args: [], cwd: "", env: { MAVEN_OPTS: "-Xmx2g" },
    }).environmentModes).toEqual({ MAVEN_OPTS: "replace" });
  });

  it("isolates overrides by workspace and appends program arguments", () => {
    writeRunConfigurationOverride("workspace-a", run.id, {
      args: ["hello world", "--verbose"],
      cwd: "/repo/tools",
      env: { LOG_LEVEL: "debug" },
    });
    const override = readRunConfigurationOverrides("workspace-a")[run.id];
    const applied = applyRunConfigurationOverride(run, override);
    expect(applied.command.args).toEqual(["run", "--bin", "demo", "--", "hello world", "--verbose"]);
    expect(applied.command.cwd).toBe("/repo/tools");
    expect(applied.command.env).toEqual({ LOG_LEVEL: "debug" });
    expect(readRunConfigurationOverrides("workspace-b")).toEqual({});
  });

  it("isolates duplicate configuration ids by workspace root with legacy fallback", () => {
    writeRunConfigurationOverride("workspace-a", run.id, {
      name: "Legacy", args: [], cwd: "", env: {},
    });
    expect(readRunConfigurationOverrides("workspace-a", "root-one")[run.id].name).toBe("Legacy");
    expect(readRunConfigurationOverrides("workspace-a", "root-two")[run.id].name).toBe("Legacy");

    writeRunConfigurationOverride("workspace-a", run.id, {
      name: "One", args: [], cwd: "", env: {},
    }, "root-one");
    writeRunConfigurationOverride("workspace-a", run.id, {
      name: "Two", args: [], cwd: "", env: {},
    }, "root-two");

    expect(readRunConfigurationOverrides("workspace-a", "root-one")[run.id].name).toBe("One");
    expect(readRunConfigurationOverrides("workspace-a", "root-two")[run.id].name).toBe("Two");
    expect(readRunConfigurationOverrides("workspace-a")[run.id].name).toBe("Legacy");
  });

  it("inherits configured runtime options for legacy overrides and preserves explicit clearing", () => {
    const configured: ExecutionRunConfiguration = {
      ...run,
      command: {
        ...run.command,
        executable: "node",
        args: ["app.js"],
        display: "node app.js",
      },
      runtimeOptions: ["--inspect", "--trace-warnings"],
      envFile: ".env.shared",
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.runConfigurations.v1.workspace-a",
      JSON.stringify({
        [configured.id]: { args: [], cwd: "", env: {} },
      }),
    );

    const legacyOverride = readRunConfigurationOverrides("workspace-a")[configured.id];
    expect(legacyOverride.vmOptions).toBeUndefined();
    expect(applyRunConfigurationOverride(configured, legacyOverride)).toMatchObject({
      runtimeOptions: ["--inspect", "--trace-warnings"],
      envFile: ".env.shared",
      command: { args: ["--inspect", "--trace-warnings", "app.js"] },
    });

    const cleared = applyRunConfigurationOverride(configured, {
      args: [], vmOptions: [], cwd: "", env: {}, envFile: "",
    });
    expect(cleared.runtimeOptions).toBeUndefined();
    expect(cleared.envFile).toBeUndefined();
    expect(cleared.command.args).toEqual(["app.js"]);
  });

  it("applies args, cwd, and env to the matching DAP payload", () => {
    const debug: ExecutionDebugConfiguration = {
      id: "debug:demo",
      projectId: "project:demo",
      label: "Debug demo",
      adapterId: "lldb",
      request: "launch",
      available: true,
      preLaunchTargets: [],
      launchConfig: { adapterCwd: "/repo", arguments: { program: "/repo/demo", args: [] } },
    };
    const applied = applyRunOverrideToDebugConfiguration(debug, {
      args: ["one"], cwd: "/repo/tools", env: { MODE: "test" },
    });
    expect(applied.launchConfig).toMatchObject({
      adapterCwd: "/repo/tools",
      arguments: { args: ["one"], cwd: "/repo/tools", env: { MODE: "test" } },
    });
  });

  it("maps VM options and dotenv values into DAP and Java launch payloads", () => {
    const debug: ExecutionDebugConfiguration = {
      id: "debug:demo",
      projectId: "project:demo",
      label: "Debug demo",
      adapterId: "lldb",
      request: "launch",
      available: true,
      preLaunchTargets: [],
      launchConfig: { arguments: { args: ["provider"], env: { EXPLICIT: "yes" } } },
    };
    const override = {
      args: ["user"], vmOptions: ["-Xmx1g"], cwd: "/repo/tools", env: { MODE: "test" }, envFile: ".env",
    };
    const applied = applyRunOverrideToDebugConfiguration(debug, override);
    expect(applied).toMatchObject({ envFile: ".env" });
    expect(applied.launchConfig).toMatchObject({
      arguments: {
        args: ["provider", "user"],
        vmArgs: ["-Xmx1g"],
        env: { EXPLICIT: "yes", MODE: "test" },
      },
    });
    const dotenv = mergeDebugEnvironment(applied, { MODE: "file", FILE_ONLY: "1" });
    expect(dotenv.launchConfig).toMatchObject({
      arguments: { env: { MODE: "test", FILE_ONLY: "1", EXPLICIT: "yes" } },
    });
    expect(applyRunOverrideToJavaLaunch({ env: { PROVIDER: "1" } }, override, { MODE: "file" }))
      .toMatchObject({
        args: ["user"], vmArgs: ["-Xmx1g"], cwd: "/repo/tools",
        env: { PROVIDER: "1", MODE: "test" },
      });
  });

  it("inherits shared runtime options into DAP and Java debug unless locally cleared", () => {
    const debug: ExecutionDebugConfiguration = {
      id: "debug:demo",
      projectId: "project:demo",
      label: "Debug demo",
      adapterId: "java",
      request: "launch",
      available: true,
      preLaunchTargets: [],
      launchConfig: { arguments: { vmArgs: ["-Dprovider=true"] } },
    };

    expect(applyRunOverrideToDebugConfiguration(debug, undefined, ["-Xmx1g"]).launchConfig)
      .toMatchObject({ arguments: { vmArgs: ["-Dprovider=true", "-Xmx1g"] } });
    expect(applyRunOverrideToDebugConfiguration(debug, undefined, [], ".env.shared").envFile)
      .toBe(".env.shared");
    expect(applyRunOverrideToDebugConfiguration(
      { ...debug, envFile: ".env.debug" },
      undefined,
      [],
      ".env.shared",
    ).envFile).toBe(".env.debug");
    expect(applyRunOverrideToDebugConfiguration(
      debug,
      { args: [], vmOptions: [], cwd: "", env: {}, envFile: "" },
      ["-Xmx1g"],
      ".env.shared",
    ).launchConfig).toMatchObject({ arguments: { vmArgs: ["-Dprovider=true"] } });
    expect(applyRunOverrideToDebugConfiguration(
      debug,
      { args: [], vmOptions: [], cwd: "", env: {}, envFile: "" },
      ["-Xmx1g"],
      ".env.shared",
    ).envFile).toBeUndefined();
    expect(applyRunOverrideToJavaLaunch({ vmArgs: ["-Dprovider=true"] }, undefined, {}, ["-Xmx1g"]))
      .toMatchObject({ vmArgs: ["-Dprovider=true", "-Xmx1g"] });
    expect(applyRunOverrideToJavaLaunch({ vmArgs: "-Dprovider=true" }, undefined, {}, ["-Xmx1g"]))
      .toMatchObject({ vmArgs: "-Dprovider=true -Xmx1g" });
    expect(applyRunOverrideToJavaLaunch({}, undefined, {}, ["-Xmx1g"]))
      .toMatchObject({ vmArgs: ["-Xmx1g"] });
    expect(applyRunOverrideToJavaLaunch(
      {},
      { args: [], vmOptions: [], cwd: "", env: {} },
      {},
      ["-Xmx1g"],
    )).not.toHaveProperty("vmArgs");
  });

  it("creates named copies anchored to the detected configuration", () => {
    writeRunConfigurationOverride("workspace-a", run.id, {
      name: "Tuned", args: ["--verbose"], vmOptions: ["-Xmx1g"], cwd: "/repo/tools",
      env: { MODE: "test" }, envFile: ".env", preLaunchTargets: ["build:demo"],
    });
    const tuned = applyRunConfigurationOverride(run, readRunConfigurationOverrides("workspace-a")[run.id]);
    const firstId = createNamedRunConfiguration("workspace-a", tuned, "Local");
    const first = materializeRunConfigurations([run], readRunConfigurationOverrides("workspace-a"))
      .find((configuration) => configuration.id === firstId)!;
    const secondId = createNamedRunConfiguration("workspace-a", first, "Second");
    const overrides = readRunConfigurationOverrides("workspace-a");
    expect(overrides[firstId]).toMatchObject({
      baseConfigurationId: run.id,
      args: ["--verbose"],
      vmOptions: ["-Xmx1g"],
      envFile: ".env",
    });
    expect(overrides[secondId].baseConfigurationId).toBe(run.id);
  });

  it("parses only valid environment assignments", () => {
    expect(parseEnvironmentLines("A=1\nINVALID\nNOT-VALID=x\nEMPTY=\nB=two=parts")).toEqual({
      A: "1", EMPTY: "", B: "two=parts",
    });
    expect(parseDotEnv("# comment\nexport A=1\nB='two words'\nBAD NAME=x\nC=three=parts"))
      .toEqual({ A: "1", B: "two words", C: "three=parts" });
  });

  it("persists the active Run/Debug configuration by normalized source path", () => {
    writeActiveRunConfigurationSelection("workspace-a", "C:\\repo\\src\\Main.java", "run:local");
    expect(readActiveRunConfigurationSelection("workspace-a", "C:/repo/src/Main.java"))
      .toBe("run:local");
    expect(readActiveRunConfigurationSelections("workspace-b")).toEqual({});

    writeActiveRunConfigurationSelection("workspace-a", "C:/repo/src/Main.java", null);
    expect(readActiveRunConfigurationSelection("workspace-a", "C:/repo/src/Main.java"))
      .toBeNull();
  });
});
