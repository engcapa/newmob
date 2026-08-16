import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Crosshair } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import {
  decodeMemoryData,
  encodeMemoryData,
  type DebugDisassembledInstruction,
} from "../../dapDebugModel";
import { parsePositiveMemoryCount, parseSignedMemoryOffset } from "./debugPanelShared";

export interface MemoryDisassemblyViewProps {
  debug: CodeDebugSession;
}

/** DAP memory read/write and disassembly tools, shown only for advertised capabilities. */
export function MemoryDisassemblyView({ debug }: MemoryDisassemblyViewProps) {
  const [memoryReference, setMemoryReference] = useState("");
  const [memoryOffset, setMemoryOffset] = useState("");
  const [memoryCount, setMemoryCount] = useState("64");
  const [writeData, setWriteData] = useState("");
  const [disassembleOffset, setDisassembleOffset] = useState("");
  const [instructionOffset, setInstructionOffset] = useState("");
  const [instructionCount, setInstructionCount] = useState("32");
  const [resolveSymbols, setResolveSymbols] = useState(true);
  const [readResult, setReadResult] = useState<{
    address: string | null;
    unreadableBytes: number;
    hex: string;
  } | null>(null);
  const [writeStatus, setWriteStatus] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<DebugDisassembledInstruction[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"read" | "write" | "disassemble" | null>(null);
  const active = !!debug.state && debug.state.status !== "terminated";
  const canRead = active && debug.capabilities.supportsReadMemoryRequest === true;
  const canWrite = active && debug.capabilities.supportsWriteMemoryRequest === true;
  const canDisassemble = active && debug.capabilities.supportsDisassembleRequest === true;
  const anySupported = canRead || canWrite || canDisassemble;
  const field = "min-w-0 flex-1 rounded border border-[var(--taomni-input-border)] bg-[var(--taomni-input-bg)] px-1.5 py-0.5 font-mono text-[11px] outline-none disabled:opacity-40";

  useEffect(() => {
    setReadResult(null);
    setWriteStatus(null);
    setInstructions([]);
    setNotice(null);
    setBusy(null);
  }, [debug.activeSessionId]);

  const read = async () => {
    const reference = memoryReference.trim();
    const count = parsePositiveMemoryCount(memoryCount, 65536);
    const offset = parseSignedMemoryOffset(memoryOffset);
    if (!reference || count == null || offset === null) {
      setNotice("Memory reference, count, and signed offset are required");
      return;
    }
    setNotice(null);
    setBusy("read");
    const result = await debug.readMemory({ memoryReference: reference, count, ...(offset === undefined ? {} : { offset }) });
    setBusy(null);
    if (!result) {
      setReadResult(null);
      setNotice("Memory read returned no data");
      return;
    }
    setReadResult({ address: result.address, unreadableBytes: result.unreadableBytes, hex: decodeMemoryData(result.data) });
  };

  const write = async () => {
    const reference = memoryReference.trim();
    const offset = parseSignedMemoryOffset(memoryOffset);
    const data = encodeMemoryData(writeData);
    if (!reference || !data || offset === null) {
      setNotice("Write data must be hexadecimal bytes with a signed offset");
      return;
    }
    setNotice(null);
    setBusy("write");
    const result = await debug.writeMemory({ memoryReference: reference, data, allowPartial: false, ...(offset === undefined ? {} : { offset }) });
    setBusy(null);
    setWriteStatus(result ? `Wrote ${result.bytesWritten ?? 0} byte${result.bytesWritten === 1 ? "" : "s"}` : "Memory write failed");
  };

  const disassemble = async () => {
    const reference = memoryReference.trim();
    const count = parsePositiveMemoryCount(instructionCount, 4096);
    const offset = parseSignedMemoryOffset(disassembleOffset);
    const instructionDelta = parseSignedMemoryOffset(instructionOffset);
    if (!reference || count == null || offset === null || instructionDelta === null) {
      setNotice("Memory reference, instruction count, and signed offsets are required");
      return;
    }
    setNotice(null);
    setBusy("disassemble");
    const result = await debug.disassemble({
      memoryReference: reference,
      instructionCount: count,
      resolveSymbols,
      ...(offset === undefined ? {} : { offset }),
      ...(instructionDelta === undefined ? {} : { instructionOffset: instructionDelta }),
    });
    setBusy(null);
    setInstructions(result);
  };

  return (
    <div data-testid="debug-memory-disassembly" className="border-t border-[var(--taomni-code-border)]/60">
      {!anySupported && active && (
        <div data-testid="debug-memory-unsupported" className="px-3 py-1 text-[10px] text-amber-500">
          The active debug adapter does not expose memory or disassembly requests.
        </div>
      )}
      {anySupported && (
        <div className="space-y-1 px-3 py-1">
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-1">
            <label htmlFor="debug-memory-reference" className="text-[10px] text-[var(--taomni-text-muted)]">Reference</label>
            <input
              id="debug-memory-reference"
              data-testid="debug-memory-reference"
              aria-label="Memory reference"
              className={field}
              placeholder="0x1000 or adapter reference"
              maxLength={4096}
              value={memoryReference}
              onChange={(event) => setMemoryReference(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-1">
            <span className="text-[10px] text-[var(--taomni-text-muted)]">Read</span>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <input
                data-testid="debug-memory-offset"
                aria-label="Memory offset"
                className={`${field} basis-20`}
                inputMode="numeric"
                placeholder="offset"
                value={memoryOffset}
                onChange={(event) => setMemoryOffset(event.target.value)}
              />
              <input
                data-testid="debug-memory-count"
                aria-label="Memory byte count"
                className={`${field} basis-20`}
                inputMode="numeric"
                placeholder="bytes"
                value={memoryCount}
                disabled={!canRead}
                onChange={(event) => setMemoryCount(event.target.value)}
              />
              {canRead && (
                <button
                  type="button"
                  data-testid="debug-memory-read"
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[10px] hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
                  aria-label="Read memory"
                  title="Read memory"
                  disabled={busy !== null}
                  onClick={() => { void read(); }}
                >
                  <ArrowDownToLine className="h-3 w-3" />
                  Read
                </button>
              )}
            </div>
          </div>
          {readResult && (
            <div data-testid="debug-memory-result" className="rounded border border-[var(--taomni-code-border)]/60 px-2 py-1">
              <div className="text-[10px] text-[var(--taomni-text-muted)]">
                {readResult.address ?? memoryReference}{readResult.unreadableBytes > 0 ? ` · ${readResult.unreadableBytes} unreadable` : ""}
              </div>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">{readResult.hex || "(empty)"}</pre>
            </div>
          )}
          {canWrite && (
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-1">
              <label htmlFor="debug-memory-write-data" className="pt-1 text-[10px] text-[var(--taomni-text-muted)]">Write</label>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <input
                  id="debug-memory-write-data"
                  data-testid="debug-memory-write-data"
                  aria-label="Memory bytes to write"
                  className={`${field} basis-40`}
                  placeholder="hex bytes: 01 02 ff"
                  value={writeData}
                  onChange={(event) => setWriteData(event.target.value)}
                />
                <button
                  type="button"
                  data-testid="debug-memory-write"
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[10px] hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
                  aria-label="Write memory"
                  title="Write memory"
                  disabled={busy !== null || !writeData.trim()}
                  onClick={() => { void write(); }}
                >
                  <ArrowUpFromLine className="h-3 w-3" />
                  Write
                </button>
                {writeStatus && <span data-testid="debug-memory-write-status" className="text-[10px] text-[var(--taomni-text-muted)]">{writeStatus}</span>}
              </div>
            </div>
          )}
          {canDisassemble && (
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-1">
              <span className="pt-1 text-[10px] text-[var(--taomni-text-muted)]">Disassemble</span>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <input
                  data-testid="debug-disassemble-offset"
                  aria-label="Disassemble byte offset"
                  className={`${field} basis-20`}
                  inputMode="numeric"
                  placeholder="byte offset"
                  value={disassembleOffset}
                  onChange={(event) => setDisassembleOffset(event.target.value)}
                />
                <input
                  data-testid="debug-disassemble-instruction-offset"
                  aria-label="Disassemble instruction offset"
                  className={`${field} basis-20`}
                  inputMode="numeric"
                  placeholder="instruction offset"
                  value={instructionOffset}
                  onChange={(event) => setInstructionOffset(event.target.value)}
                />
                <input
                  data-testid="debug-disassemble-count"
                  aria-label="Disassemble instruction count"
                  className={`${field} basis-20`}
                  inputMode="numeric"
                  value={instructionCount}
                  onChange={(event) => setInstructionCount(event.target.value)}
                />
                <label className="flex items-center gap-1 text-[10px] text-[var(--taomni-text-muted)]">
                  <input
                    type="checkbox"
                    data-testid="debug-disassemble-resolve-symbols"
                    checked={resolveSymbols}
                    onChange={(event) => setResolveSymbols(event.target.checked)}
                  />
                  Symbols
                </label>
                <button
                  type="button"
                  data-testid="debug-disassemble"
                  className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[10px] hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30"
                  aria-label="Disassemble memory"
                  title="Disassemble memory"
                  disabled={busy !== null}
                  onClick={() => { void disassemble(); }}
                >
                  <Crosshair className="h-3 w-3" />
                  Disassemble
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {notice && (
        <div data-testid="debug-memory-notice" role="status" className="px-3 pb-1 text-[10px] text-rose-500">{notice}</div>
      )}
      {instructions.length > 0 && (
        <div data-testid="debug-disassembly-output" className="max-h-48 overflow-auto border-t border-[var(--taomni-code-border)]/40 px-3 py-1 font-mono text-[10px]">
          {instructions.map((instruction, index) => (
            <div key={`${instruction.address}:${index}`} data-testid="debug-disassembly-row" className="flex min-w-0 gap-2 leading-4">
              <span className="w-24 shrink-0 text-[var(--taomni-text-muted)]">{instruction.address}</span>
              <span className="w-28 shrink-0 truncate text-[var(--taomni-text-muted)]">{instruction.instructionBytes ?? ""}</span>
              <span className="min-w-0 flex-1 truncate" title={instruction.instruction}>{instruction.instruction || instruction.symbol || "?"}</span>
              {instruction.line && <span className="shrink-0 text-[var(--taomni-text-muted)]">:{instruction.line}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
