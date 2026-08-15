import { describe, expect, it } from "vitest";
import {
  DAP_ADAPTER_CONTRACT_FIXTURES,
  assessDapAdapterCapabilities,
  dapAdapterContractFor,
  validateDapAdapterContract,
} from "./dapAdapterContracts";
import {
  buildDisassembleArgs,
  buildReadMemoryArgs,
  buildWriteMemoryArgs,
  decodeMemoryData,
  encodeMemoryData,
  parseDisassembleResponse,
  parseReadMemoryResponse,
  parseWriteMemoryResponse,
} from "./dapDebugModel";

describe("dapAdapterContracts", () => {
  it("keeps one contract fixture for Java, JavaScript, Python, Go, Rust, and C++", () => {
    expect(DAP_ADAPTER_CONTRACT_FIXTURES.map((fixture) => fixture.language)).toEqual([
      "java",
      "javascript",
      "python",
      "go",
      "rust",
      "cpp",
    ]);
    expect(DAP_ADAPTER_CONTRACT_FIXTURES.every((fixture) => validateDapAdapterContract(fixture).length === 0)).toBe(true);
    expect(dapAdapterContractFor("rust", "lldb")?.id).toBe("rust-lldb");
    expect(dapAdapterContractFor("cpp", "lldb")?.id).toBe("cpp-lldb");
    expect(dapAdapterContractFor("java", "lldb")).toBeNull();
  });

  it("treats the synthetic baseline profile as unsupported", () => {
    for (const fixture of DAP_ADAPTER_CONTRACT_FIXTURES) {
      const assessment = assessDapAdapterCapabilities(
        fixture.adapterId,
        fixture.capabilityProfiles.baseline,
        fixture.modeApplicability,
      );
      expect(assessment).toMatchObject({
        readMemory: false,
        writeMemory: false,
        disassemble: false,
        modeIds: [],
        applicableModeIds: [],
      });
    }
  });

  it("honors every advertised memory capability and only applicable modes", () => {
    for (const fixture of DAP_ADAPTER_CONTRACT_FIXTURES) {
      const assessment = assessDapAdapterCapabilities(
        fixture.adapterId,
        fixture.capabilityProfiles.advertised,
        fixture.modeApplicability,
      );
      expect(assessment.readMemory).toBe(true);
      expect(assessment.writeMemory).toBe(true);
      expect(assessment.disassemble).toBe(true);
      expect(assessment.modeIds).toContain(fixture.capabilityProfiles.advertised.breakpointModes[0].mode);
      expect(assessment.applicableModeIds).toEqual(assessment.modeIds);
    }
  });

  it("keeps address, range, partial-write, symbol, and source mapping semantics stable", () => {
    for (const fixture of DAP_ADAPTER_CONTRACT_FIXTURES) {
      const { vector } = fixture;
      const encoded = encodeMemoryData(vector.writeHex);
      expect(encoded).not.toBeNull();
      expect(decodeMemoryData(encoded ?? "")).toBe(vector.writeHex.toLowerCase());

      expect(buildReadMemoryArgs({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        count: vector.readCount,
      })).toEqual({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        count: vector.readCount,
      });
      expect(parseReadMemoryResponse({
        address: vector.memoryReference,
        unreadableBytes: 1,
        data: "AAEC/w==",
      })).toEqual({
        address: vector.memoryReference,
        unreadableBytes: 1,
        data: "AAEC/w==",
      });

      expect(buildWriteMemoryArgs({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        data: encoded ?? "",
        allowPartial: false,
      })).toEqual({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        data: encoded,
        allowPartial: false,
      });
      expect(parseWriteMemoryResponse({ bytesWritten: vector.writeHex.split(/\s+/).length })).toEqual({
        bytesWritten: vector.writeHex.split(/\s+/).length,
      });

      expect(buildDisassembleArgs({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        instructionOffset: vector.instructionOffset,
        instructionCount: vector.instructionCount,
        resolveSymbols: true,
      })).toEqual({
        memoryReference: vector.memoryReference,
        offset: vector.offset,
        instructionOffset: vector.instructionOffset,
        instructionCount: vector.instructionCount,
        resolveSymbols: true,
      });
      expect(parseDisassembleResponse({
        instructions: [{
          address: vector.memoryReference,
          instructionBytes: "55",
          instruction: "entry",
          symbol: `${fixture.language}::main`,
          location: {
            path: vector.sourcePath,
            name: vector.sourceName,
            sourceReference: 17,
          },
          line: 11,
          column: 3,
        }],
      })).toEqual([{
        address: vector.memoryReference,
        instructionBytes: "55",
        instruction: "entry",
        symbol: `${fixture.language}::main`,
        location: {
          path: vector.sourcePath,
          name: vector.sourceName,
          sourceReference: 17,
        },
        line: 11,
        column: 3,
        endLine: null,
        endColumn: null,
      }]);
    }
  });

  it("does not infer runtime support from the adapter id", () => {
    const fixture = DAP_ADAPTER_CONTRACT_FIXTURES.find((entry) => entry.language === "java")!;
    const assessment = assessDapAdapterCapabilities(fixture.adapterId, {
      supportsReadMemoryRequest: true,
    }, fixture.modeApplicability);
    expect(assessment.readMemory).toBe(true);
    expect(assessment.writeMemory).toBe(false);
    expect(assessment.disassemble).toBe(false);
  });
});
