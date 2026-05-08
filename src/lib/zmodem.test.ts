import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer, Session, Transfer } from "zmodem.js";
import { ZmodemSession, type ZmodemCallbacks, type ZmodemSendFile } from "./zmodem";

const zmodemMock = vi.hoisted(() => {
  let options: {
    on_detect: (detection: {
      confirm: () => Session;
      deny: () => void;
      is_valid: () => boolean;
      get_session_role: () => "send" | "receive";
    }) => void;
    on_retract: () => void;
    sender: (octets: number[]) => void;
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for local files when the remote starts rz without queued files", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "hello.txt", path: "/uploads/hello.txt" },
    ]);
    const callbacks = makeCallbacks({
      onSelectSendFiles: selectFiles,
      onOpenReadStream: vi.fn(async () => ({ handleId: "read-1", size: 3, mtime: 123 })),
      onReadStream: vi.fn()
        .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
        .mockResolvedValueOnce(new Uint8Array()),
    });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "hello.txt",
      size: 3,
      mtime: 123,
    });
    expect(callbacks.onOpenReadStream).toHaveBeenCalledWith("/uploads/hello.txt");
    expect(callbacks.onReadStream).toHaveBeenCalledWith("read-1", 64 * 1024);
    expect(callbacks.onCloseReadStream).toHaveBeenCalledWith("read-1");
    expect(transfer.send).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(transfer.end).toHaveBeenCalledWith(new Uint8Array());
    expect(callbacks.onComplete).toHaveBeenCalledWith("hello.txt");
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenCalledWith("sending");
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("keeps a single file picker open while remote rz repeats its header", async () => {
    const firstSession = makeSendSession(makeTransfer());
    const secondTransfer = makeTransfer();
    const secondSession = makeSendSession(secondTransfer);
    let resolveSelection!: (files: ZmodemSendFile[]) => void;
    const selectFiles = vi.fn(
      () => new Promise<ZmodemSendFile[]>((resolve) => {
        resolveSelection = resolve;
      }),
    );
    const callbacks = makeCallbacks({
      onSelectSendFiles: selectFiles,
      onOpenReadStream: vi.fn(async () => ({ handleId: "read-late", size: 2, mtime: 456 })),
      onReadStream: vi.fn()
        .mockResolvedValueOnce(new Uint8Array([4, 5]))
        .mockResolvedValueOnce(new Uint8Array()),
    });
    const firstDetection = makeDetection(firstSession);
    const secondDetection = makeDetection(secondSession);

    new ZmodemSession(vi.fn(), callbacks);
    detect(firstDetection);
    await Promise.resolve();

    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(firstDetection.confirm).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("sending");

    zmodemMock.getOptions()?.on_retract();
    detect(secondDetection);
    await Promise.resolve();

    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("sending");

    resolveSelection([{ name: "late.bin", path: "/uploads/late.bin" }]);

    await expect.poll(() => secondSession.close.mock.calls.length).toBe(1);

    expect(firstDetection.confirm).not.toHaveBeenCalled();
    expect(secondDetection.confirm).toHaveBeenCalledTimes(1);
    expect(secondSession.send_offer).toHaveBeenCalledWith({
      name: "late.bin",
      size: 2,
      mtime: 456,
    });
    expect(secondTransfer.send).toHaveBeenCalledWith(new Uint8Array([4, 5]));
  });

  it("aborts the remote rz session when file selection is canceled", async () => {
    const session = makeSendSession(makeTransfer());
    const callbacks = makeCallbacks({ onSelectSendFiles: vi.fn(async () => []) });
    const detection = makeDetection(session);

    new ZmodemSession(vi.fn(), callbacks);
    detect(detection);

    await expect.poll(() => detection.deny.mock.calls.length).toBe(1);

    expect(session.send_offer).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("uses queued files without prompting when send was initiated locally", async () => {
    const transfer = makeTransfer();
    const session = makeSendSession(transfer);
    const selectFiles = vi.fn(async () => [
      { name: "unused.txt", path: "/uploads/unused.txt" },
    ]);
    const callbacks = makeCallbacks({
      onSelectSendFiles: selectFiles,
      onOpenReadStream: vi.fn(async () => ({ handleId: "read-queued", size: 2, mtime: 789 })),
      onReadStream: vi.fn()
        .mockResolvedValueOnce(new Uint8Array([7, 8]))
        .mockResolvedValueOnce(new Uint8Array()),
    });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "queued.bin", path: "/uploads/queued.bin" }]);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(selectFiles).not.toHaveBeenCalled();
    expect(session.send_offer).toHaveBeenCalledWith({
      name: "queued.bin",
      size: 2,
      mtime: 789,
    });
    expect(callbacks.onOpenReadStream).toHaveBeenCalledWith("/uploads/queued.bin");
    expect(transfer.send).toHaveBeenCalledWith(new Uint8Array([7, 8]));
  });

  it("closes the read stream when the remote skips an offered file", async () => {
    const session = makeSendSession(undefined);
    const callbacks = makeCallbacks({
      onOpenReadStream: vi.fn(async () => ({ handleId: "read-skip", size: 5, mtime: 111 })),
    });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "skip.bin", path: "/uploads/skip.bin" }]);
    detect(session);

    await expect.poll(() => session.close.mock.calls.length).toBe(1);

    expect(session.send_offer).toHaveBeenCalledWith({
      name: "skip.bin",
      size: 5,
      mtime: 111,
    });
    expect(callbacks.onReadStream).not.toHaveBeenCalled();
    expect(callbacks.onCloseReadStream).toHaveBeenCalledWith("read-skip");
    expect(callbacks.onError).toHaveBeenCalledWith("Remote skipped file: skip.bin");
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("aborts the send session when opening the read stream fails", async () => {
    const session = makeSendSession(makeTransfer());
    const callbacks = makeCallbacks({
      onOpenReadStream: vi.fn(async () => {
        throw new Error("missing file");
      }),
    });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "missing.bin", path: "/uploads/missing.bin" }]);
    detect(session);

    await expect.poll(() => session.abort.mock.calls.length).toBe(1);

    expect(session.send_offer).not.toHaveBeenCalled();
    expect(callbacks.onCloseReadStream).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("missing file");
  });

  it("closes the read stream and aborts when reading a send chunk fails", async () => {
    const session = makeSendSession(makeTransfer());
    const callbacks = makeCallbacks({
      onOpenReadStream: vi.fn(async () => ({ handleId: "read-broken", size: 5, mtime: 222 })),
      onReadStream: vi.fn(async () => {
        throw new Error("read failed");
      }),
    });
    const zmodem = new ZmodemSession(vi.fn(), callbacks);

    zmodem.queueSend([{ name: "broken.bin", path: "/uploads/broken.bin" }]);
    detect(session);

    await expect.poll(() => session.abort.mock.calls.length).toBe(1);

    expect(callbacks.onCloseReadStream).toHaveBeenCalledWith("read-broken");
    expect(callbacks.onError).toHaveBeenCalledWith("read failed");
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
    await expect.poll(() => offer.accept.mock.calls.length).toBe(1);

    offer.emitInput([1, 2]);
    offer.emitInput([3]);
    offer.resolveAccept();

    await expect.poll(() => (callbacks.onComplete as any).mock.calls.length).toBe(1);

    expect(callbacks.onOpenWriteStream).toHaveBeenCalledWith("/downloads/remote.bin");
    expect(offer.accept).toHaveBeenCalledWith({ on_input: expect.any(Function) });
    expect(offer.on).not.toHaveBeenCalledWith("input", expect.any(Function));
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
    await expect.poll(() => offer.accept.mock.calls.length).toBe(1);

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
    await expect.poll(() => offer.accept.mock.calls.length).toBe(1);

    offer.emitInput([1]);
    offer.resolveAccept();

    await expect.poll(() => (callbacks.onAbortWriteStream as any).mock.calls.length).toBe(1);

    expect(callbacks.onCloseWriteStream).not.toHaveBeenCalled();
    expect(callbacks.onComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith("disk full");
  });

  it("releases receive mode when the sender finishes without a final OO trailer", async () => {
    vi.useFakeTimers();
    const session = makeReceiveSession();
    const callbacks = makeCallbacks({
      onSelectSaveDir: vi.fn(async () => "/downloads"),
    });

    new ZmodemSession(vi.fn(), callbacks);
    detect(session);

    await Promise.resolve();
    await Promise.resolve();

    expect(session.start).toHaveBeenCalledTimes(1);
    expect(callbacks.onStateChange).toHaveBeenCalledWith("receiving");

    session.emitReceive({ NAME: "ZFIN" });
    await vi.advanceTimersByTimeAsync(750);

    expect(callbacks.onStateChange).toHaveBeenLastCalledWith("idle");
  });

  it("serializes ZMODEM writes to the terminal backend", async () => {
    const callbacks = makeCallbacks();
    const releases: Array<() => void> = [];
    const sent: number[][] = [];
    const sender = vi.fn((data: Uint8Array) => new Promise<void>((resolve) => {
      sent.push(Array.from(data));
      releases.push(resolve);
    }));

    new ZmodemSession(sender, callbacks);
    zmodemMock.getOptions()?.sender([1]);
    zmodemMock.getOptions()?.sender([2]);

    await Promise.resolve();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([[1]]);

    releases[0]();

    await expect.poll(() => sender.mock.calls.length).toBe(2);
    expect(sent).toEqual([[1], [2]]);
    releases[1]();
  });
});

function makeCallbacks(overrides: Partial<ZmodemCallbacks> = {}): ZmodemCallbacks {
  return {
    onTerminalData: vi.fn(),
    onStateChange: vi.fn(),
    onProgress: vi.fn(),
    onSelectSaveDir: vi.fn(async () => null),
    onSelectSendFiles: vi.fn(async () => null),
    onOpenReadStream: vi.fn(async () => ({ handleId: "read-handle", size: 0, mtime: 0 })),
    onReadStream: vi.fn(async () => new Uint8Array()),
    onCloseReadStream: vi.fn(async () => undefined),
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

function makeSendSession(transfer: Transfer | undefined) {
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
  let receiveHandler: ((payload: unknown) => void) | null = null;
  let sessionEndHandler: (() => void) | null = null;
  const session = {
    type: "receive" as const,
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      if (event === "offer") offerHandler = handler as (offer: Offer) => void;
      if (event === "receive") receiveHandler = handler as (payload: unknown) => void;
      if (event === "session_end") sessionEndHandler = handler as () => void;
    }),
    start: vi.fn(),
    close: vi.fn(async () => undefined),
    abort: vi.fn(),
    emitOffer: (offer: Offer) => {
      offerHandler?.(offer);
    },
    emitReceive: (payload: unknown) => {
      receiveHandler?.(payload);
    },
    emitSessionEnd: () => {
      sessionEndHandler?.();
    },
  };
  return session as unknown as Session & {
    start: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    emitOffer: (offer: Offer) => void;
    emitReceive: (payload: unknown) => void;
    emitSessionEnd: () => void;
  };
}

function makeOffer(name: string, size: number) {
  let inputHandler: ((octets: number[]) => void) | null = null;
  let resolveAccept: (() => void) | null = null;
  let acceptOptions: { on_input?: (octets: number[]) => void } | null = null;
  const offer = {
    get_details: vi.fn(() => ({ name, size })),
    on: vi.fn((event: string, handler: (octets: number[]) => void) => {
      if (event === "input") inputHandler = handler;
    }),
    accept: vi.fn((opts?: { on_input?: (octets: number[]) => void }) => new Promise<void>((resolve) => {
      acceptOptions = opts ?? null;
      resolveAccept = resolve;
    })),
    emitInput: (octets: number[]) => {
      acceptOptions?.on_input?.(octets);
      inputHandler?.(octets);
    },
    resolveAccept: () => {
      resolveAccept?.();
    },
  };
  return offer as unknown as Offer & {
    accept: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emitInput: (octets: number[]) => void;
    resolveAccept: () => void;
  };
}

function detect(sessionOrDetection: Session | ReturnType<typeof makeDetection>) {
  const detection = "confirm" in sessionOrDetection ? sessionOrDetection : makeDetection(sessionOrDetection);
  zmodemMock.getOptions()?.on_detect(detection);
}

function makeDetection(session: Session) {
  return {
    confirm: vi.fn(() => session),
    deny: vi.fn(() => {
      session.abort();
    }),
    is_valid: vi.fn(() => true),
    get_session_role: vi.fn(() => session.type),
  };
}
