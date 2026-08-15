import {
  breakpointModesFor,
  parseBreakpointModes,
  type DebugBreakpointModeApplicability,
} from "./dapDebugModel";

/** Languages covered by the first real-adapter contract matrix. */
export type DapAdapterContractLanguage =
  | "java"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "cpp";

export type DapAdapterRuntime = "managed-vm" | "managed-js" | "managed-python" | "native";

/** Protocol behavior that is fixed by DAP, not by a language adapter. */
export interface DapAdapterProtocolContract {
  /** DAP memoryReference values are opaque adapter-owned strings. */
  memoryReference: "opaque";
  /** readMemory/writeMemory offsets are signed byte offsets. */
  memoryOffset: "signed-byte";
  /** The client always states whether partial writes are allowed. */
  writePartialPolicy: "explicit";
  /** disassemble instructionOffset remains adapter-defined but is signed. */
  instructionOffset: "signed-adapter-defined";
  /** Source mapping is optional and must preserve path/name/sourceReference. */
  sourceMapping: "optional-source-location";
  /** Mode ids are accepted only when the adapter advertises applicability. */
  breakpointModes: "adapter-advertised";
}

export interface DapAdapterContractVector {
  memoryReference: string;
  offset: number;
  readCount: number;
  writeHex: string;
  instructionOffset: number;
  instructionCount: number;
  sourcePath: string;
  sourceName: string;
}

interface DapAdapterCapabilityProfile extends Record<string, unknown> {
  supportsReadMemoryRequest: boolean;
  supportsWriteMemoryRequest: boolean;
  supportsDisassembleRequest: boolean;
  breakpointModes: Array<{
    mode: string;
    label: string;
    appliesTo: string[];
  }>;
}

/** A language fixture exercises protocol shape without claiming live adapter support. */
export interface DapAdapterContractFixture {
  /** Stable fixture id; Rust/C++ can intentionally share the lldb adapter id. */
  id: string;
  language: DapAdapterContractLanguage;
  label: string;
  adapterId: string;
  runtime: DapAdapterRuntime;
  protocol: DapAdapterProtocolContract;
  vector: DapAdapterContractVector;
  /** Synthetic profiles used to test capability gating. Live initialize wins. */
  capabilityProfiles: {
    baseline: DapAdapterCapabilityProfile;
    advertised: DapAdapterCapabilityProfile;
  };
  modeApplicability: DebugBreakpointModeApplicability;
}

const protocol: DapAdapterProtocolContract = {
  memoryReference: "opaque",
  memoryOffset: "signed-byte",
  writePartialPolicy: "explicit",
  instructionOffset: "signed-adapter-defined",
  sourceMapping: "optional-source-location",
  breakpointModes: "adapter-advertised",
};

function profiles(mode: string): DapAdapterContractFixture["capabilityProfiles"] {
  return {
    baseline: {
      supportsReadMemoryRequest: false,
      supportsWriteMemoryRequest: false,
      supportsDisassembleRequest: false,
      breakpointModes: [],
    },
    advertised: {
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsDisassembleRequest: true,
      breakpointModes: [{
        mode,
        label: mode === "hardware" ? "Hardware" : "Native",
        appliesTo: ["source", "data", "instruction"],
      }],
    },
  };
}

/**
 * Contract fixtures for the adapter families currently registered by the
 * workspace execution model. The advertised profile is deliberately synthetic:
 * it proves the client honors initialize capability bits, while native smoke
 * later replaces it with captured responses from each real adapter version.
 */
export const DAP_ADAPTER_CONTRACT_FIXTURES: readonly DapAdapterContractFixture[] = [
  {
    id: "java-java-debug",
    language: "java",
    label: "Java / java-debug",
    adapterId: "java",
    runtime: "managed-vm",
    protocol,
    vector: {
      memoryReference: "java-frame:0x7fa0",
      offset: -4,
      readCount: 16,
      writeHex: "01 02 ff",
      instructionOffset: -1,
      instructionCount: 4,
      sourcePath: "/workspace/src/App.java",
      sourceName: "App.java",
    },
    capabilityProfiles: profiles("software"),
    modeApplicability: "source",
  },
  {
    id: "javascript-js-debug",
    language: "javascript",
    label: "JavaScript / vscode-js-debug",
    adapterId: "node",
    runtime: "managed-js",
    protocol,
    vector: {
      memoryReference: "node-object:0x1000",
      offset: -8,
      readCount: 24,
      writeHex: "00 7f",
      instructionOffset: 0,
      instructionCount: 6,
      sourcePath: "/workspace/src/index.ts",
      sourceName: "index.ts",
    },
    capabilityProfiles: profiles("software"),
    modeApplicability: "source",
  },
  {
    id: "python-debugpy",
    language: "python",
    label: "Python / debugpy",
    adapterId: "python",
    runtime: "managed-python",
    protocol,
    vector: {
      memoryReference: "py-frame:0x10",
      offset: -2,
      readCount: 8,
      writeHex: "de ad be ef",
      instructionOffset: 1,
      instructionCount: 3,
      sourcePath: "/workspace/main.py",
      sourceName: "main.py",
    },
    capabilityProfiles: profiles("software"),
    modeApplicability: "data",
  },
  {
    id: "go-delve",
    language: "go",
    label: "Go / Delve",
    adapterId: "delve",
    runtime: "native",
    protocol,
    vector: {
      memoryReference: "0x401000",
      offset: -16,
      readCount: 32,
      writeHex: "90 90 c3",
      instructionOffset: -2,
      instructionCount: 8,
      sourcePath: "/workspace/cmd/app/main.go",
      sourceName: "main.go",
    },
    capabilityProfiles: profiles("hardware"),
    modeApplicability: "instruction",
  },
  {
    id: "rust-lldb",
    language: "rust",
    label: "Rust / CodeLLDB or lldb-dap",
    adapterId: "lldb",
    runtime: "native",
    protocol,
    vector: {
      memoryReference: "0x7ff000001000",
      offset: -32,
      readCount: 64,
      writeHex: "48 89 e5",
      instructionOffset: -4,
      instructionCount: 12,
      sourcePath: "/workspace/src/main.rs",
      sourceName: "main.rs",
    },
    capabilityProfiles: profiles("hardware"),
    modeApplicability: "instruction",
  },
  {
    id: "cpp-lldb",
    language: "cpp",
    label: "C++ / CodeLLDB or lldb-dap",
    adapterId: "lldb",
    runtime: "native",
    protocol,
    vector: {
      memoryReference: "0x401000",
      offset: -64,
      readCount: 128,
      writeHex: "55 48 89 e5",
      instructionOffset: 2,
      instructionCount: 16,
      sourcePath: "/workspace/src/main.cpp",
      sourceName: "main.cpp",
    },
    capabilityProfiles: profiles("hardware"),
    modeApplicability: "instruction",
  },
];

/** Find a fixture by language and adapter id; lldb has Rust/C++ variants. */
export function dapAdapterContractFor(
  language: DapAdapterContractLanguage,
  adapterId: string,
): DapAdapterContractFixture | null {
  return DAP_ADAPTER_CONTRACT_FIXTURES.find(
    (fixture) => fixture.language === language && fixture.adapterId === adapterId,
  ) ?? null;
}

export interface DapAdapterCapabilityAssessment {
  adapterId: string;
  readMemory: boolean;
  writeMemory: boolean;
  disassemble: boolean;
  modeIds: string[];
  applicableModeIds: string[];
}

/**
 * Normalize the optional initialize capability fields used by the memory and
 * mode surfaces. This intentionally reports advertisements, never guessed
 * language support, so a real adapter response remains authoritative.
 */
export function assessDapAdapterCapabilities(
  adapterId: string,
  capabilities: Record<string, unknown>,
  applicability: DebugBreakpointModeApplicability,
): DapAdapterCapabilityAssessment {
  const modes = parseBreakpointModes(capabilities);
  return {
    adapterId,
    readMemory: capabilities.supportsReadMemoryRequest === true,
    writeMemory: capabilities.supportsWriteMemoryRequest === true,
    disassemble: capabilities.supportsDisassembleRequest === true,
    modeIds: modes.map((mode) => mode.mode),
    applicableModeIds: breakpointModesFor(modes, applicability).map((mode) => mode.mode),
  };
}

/** Validate fixture invariants before a fixture is admitted to the matrix. */
export function validateDapAdapterContract(fixture: DapAdapterContractFixture): string[] {
  const issues: string[] = [];
  if (!fixture.id.trim()) issues.push("fixture id is empty");
  if (!fixture.adapterId.trim()) issues.push("adapter id is empty");
  if (fixture.vector.readCount <= 0) issues.push("read count must be positive");
  if (fixture.vector.instructionCount <= 0) issues.push("instruction count must be positive");
  if (fixture.protocol.memoryReference !== "opaque") issues.push("memory reference is not opaque");
  if (fixture.protocol.memoryOffset !== "signed-byte") issues.push("memory offset is not a signed byte offset");
  if (fixture.protocol.writePartialPolicy !== "explicit") issues.push("partial-write policy is implicit");
  if (fixture.protocol.instructionOffset !== "signed-adapter-defined") issues.push("instruction offset contract drifted");
  if (fixture.protocol.sourceMapping !== "optional-source-location") issues.push("source mapping contract drifted");
  if (fixture.protocol.breakpointModes !== "adapter-advertised") issues.push("breakpoint mode contract drifted");
  return issues;
}
