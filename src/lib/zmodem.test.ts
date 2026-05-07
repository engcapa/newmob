import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer, Session, Transfer } from "zmodem.js";
import { ZmodemSession, type ZmodemCallbacks } from "./zmodem";

const zmodemMock = vi.hoisted(() => {
  let options: {
    on_detect: (detection: { confirm: () => Session }) => void;
  } | null = null;

  const Sentry = vi.fn().mockImplementation((opts) => {
    options = opts;
    return { consume: vi.fn() };
  });

  return {
    Sentry,
    getOptions: () => options,
    reset: () => {
      options = null;
      Sentry.mockClear();
    },
  };
});

vi.mock("zmodem.js", () => ({
  Sentry: zmodemMock.Sentry,
}));

describe("ZmodemSession", () => {
  beforeEach(() => {
    zmodemMock.reset();
  });

  it("asks for local files when the remote starts rz without queued files", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "hello.txt", bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const callbacks = makeCallbacks({ onSelectSendFiles: selectFiles });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "hello.txt",
      size: 3,
      mtime: expect.any(Number),
    });
    expect(transfer.send).toHaveBeenCalledWith([1, 2, 3]);
    expect(transfer.end).toHaveBeenCalledWith([]);
    expect(callbacks.onComplete).toHaveBeenCalledWith("hello.txt");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenCalledWith("sending");
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("aborts the remote rz session when file selection is canceled", async () => {
    const session = makeSendSession(makeTransfer());
    const callbacks = makeCallbacks({ onSelectSendFiles: vi.fn(async () => []) });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.abort.mock.calls.length).toBe(1);

    expect(session.send_offer).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("uses queued files without prompting when send was initiated locally", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "unused.txt", bytes: new Uint8Array([9]) },
    ]);
    const callbacks = makeCallbacks({ onSelectSendFiles: selectFiles });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "queued.bin", bytes: new Uint8Array([7, 8]) }]);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).not.toHaveBeenCalled();
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "queued.bin",
      size: 2,
      mtime: expect.any(Number),
    });
    expect(transfer.send).toHaveBeenCalledWith([7, 8]);
  });

  it("streams received file chunks in order and closes after append", async () => {
    const session = makeReceiveSession();
    const offer = makeOffer("remote.bin", 3);
    const appended: number[][] = [];
    const callbacks = makeCallbacks({
      onSelectSaveDir: vi.fn(async () => "/downloads"),
      onOpenWriteStream: vi.fn(async () => "handle-1"),
      onAppendWriteStream: vi.fn(async (_handleId, data) => {
        appended.push(Array.from(data));
      }),
    });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.start.mock.calls.length).toBe(1);
    session.emitOffer(offer);
    await expect.poll(() => (callbacks.onOpenWriteStream as any).mock.calls.length).toBe(1);

    offer.emitInput([1, 2]);
    offer.emitInput([3]);
    offer.resolveAccept();

    await expect.poll(() => (callbacks.onComplete as any).mock.calls.length).toBe(1);

    expect(callbacks.onOpenWriteStream).toHaveBeenCalledWith("/downloads/remote.bin");
    expect(appended).toEqual([[1, 2], [3]]);
    expect(callbacks.onCloseWriteStream).toHaveBeenCalledWith("handle-1");
    expect(callbacks.onAbortWriteStream).not.toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalledWith("remote.bin");
  });

  it("waits for pending receive appends before closing", async () => {
    const session = makeReceiveSession();
    const offer = makeOffer("slow.bin", 1);
    let resolveAppend!: () => void;
    const callbacks = makeCallbacks({
      onSelectSaveDir: vi.fn(async () => "/downloads"),
      onOpenWriteStream: vi.fn(async () => "handle-2"),
      onAppendWriteStream: vi.fn(
        () => new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
      ),
    });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.start.mock.calls.length).toBe(1);
    session.emitOffer(offer);
    await expect.poll(() => (callbacks.onOpenWriteStream as any).mock.calls.length).toBe(1);

    offer.emitInput([9]);
    offer.resolveAccept();
    await Promise.resolve();

    expect(callbacks.onCloseWriteStream).not.toHaveBeenCalled();
    resolveAppend();

    await expect.poll(() => (callbacks.onCloseWriteStream as any).mock.calls.length).toBe(1);
    expect(callbacks.onComplete).toHaveBeenCalledWith("slow.bin");
  });

  it("aborts the write stream when receive append fails", async () => {
    const session = makeReceiveSession();
    const offer = makeOffer("broken.bin", 1);
    const callbacks = makeCallbacks({
      onSelectSaveDir: vi.fn(async () => "/downloads"),
      onOpenWriteStream: vi.fn(async () => "handle-3"),
      onAppendWriteStream: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.start.mock.calls.length).toBe(1);
    session.emitOffer(offer);
    await expect.poll(() => (callbacks.onOpenWriteStream as any).mock.calls.length).toBe(1);

    offer.emitInput([1]);
    offer.resolveAccept();

    await expect.poll(() => (callbacks.onAbortWriteStream as any).mock.calls.length).toBe(1);

    expect(callbacks.onCloseWriteStream).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("disk full");
  });
});

function makeCallbacks(overrides: Partial<ZmodemCallbacks> = {}): ZmodemCallbacks {
  return {
    onTerminalData: vi.fn(),
    onStateChange: vi.fn(),
    onProgress: vi.fn(),
    onSelectSaveDir: vi.fn(async () => null),
    onSelectSendFiles: vi.fn(async () => null),
    onOpenWriteStream: vi.fn(async () => "stream-handle"),
    onAppendWriteStream: vi.fn(async () => undefined),
    onCloseWriteStream: vi.fn(async () => undefined),
    onAbortWriteStream: vi.fn(async () => undefined),
    onComplete: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

function makeTransfer() {
  return {
    send: vi.fn(),
    end: vi.fn(async () => undefined),
  } as Transfer & {
    send: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

function makeSendSession(transfer: Transfer) {
  return {
    type: "send" as const,
    on: vi.fn(),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    send_offer: vi.fn(async () => transfer),
    abort: vi.fn(),
  } as unknown as Session & {
    close: ReturnType<typeof vi.fn>;
    send_offer: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
  };
}

function makeReceiveSession() {
  let offerHandler: ((offer: Offer) => void) | null = null;
  const session = {
    type: "receive" as const,
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      if (event === "offer") offerHandler = handler as (offer: Offer) => void;
    }),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    abort: vi.fn(),
    emitOffer: (offer: Offer) => {
      offerHandler?.(offer);
    },
  };
  return session as unknown as Session & {
    start: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    emitOffer: (offer: Offer) => void;
  };
}

function makeOffer(name: string, size: number) {
  let inputHandler: ((octets: number[]) => void) | null = null;
  let resolveAccept: (() => void) | null = null;
  const offer = {
    get_details: vi.fn(() => ({ name, size })),
    on: vi.fn((event: string, handler: (octets: number[]) => void) => {
      if (event === "input") inputHandler = handler;
    }),
    accept: vi.fn(() => new Promise<void>((resolve) => {
      resolveAccept = resolve;
    })),
    emitInput: (octets: number[]) => {
      inputHandler?.(octets);
    },
    resolveAccept: () => {
      resolveAccept?.();
    },
  };
  return offer as unknown as Offer & {
    emitInput: (octets: number[]) => void;
    resolveAccept: () => void;
  };
}

function detect(session: Session) {
  zmodemMock.getOptions()?.on_detect({
    confirm: () => session,
  });
}
