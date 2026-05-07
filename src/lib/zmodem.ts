import { Sentry, type Session, type Offer, type Transfer } from "zmodem.js";

export type ZmodemState = "idle" | "receiving" | "sending";

export interface ZmodemProgress {
  fileName: string;
  fileSize: number;
  bytesTransferred: number;
}

export interface ZmodemSendFile {
  name: string;
  bytes: Uint8Array;
}

export interface ZmodemCallbacks {
  onTerminalData: (data: Uint8Array) => void;
  onStateChange: (state: ZmodemState, progress?: ZmodemProgress) => void;
  onProgress: (progress: ZmodemProgress) => void;
  /** Called once before the first file arrives. Return the directory to save into, or null to cancel. */
  onSelectSaveDir: () => Promise<string | null>;
  /** Called when the remote starts rz without a queued file. Return files to send, or null/empty to cancel. */
  onSelectSendFiles?: () => Promise<ZmodemSendFile[] | null>;
  onOpenWriteStream: (fullPath: string) => Promise<string>;
  onAppendWriteStream: (handleId: string, data: Uint8Array) => Promise<void>;
  onCloseWriteStream: (handleId: string) => Promise<void>;
  onAbortWriteStream: (handleId: string) => Promise<void>;
  onComplete: (fileName: string) => void;
  onError: (message: string) => void;
}

const SEND_CHUNK = 8192;

/**
 * Wraps a zmodem.js Sentry to detect and handle ZMODEM transfers over the
 * existing SSH byte stream. Feed all terminal output through consume();
 * the sentry routes non-ZMODEM bytes to onTerminalData and takes over the
 * channel when a handshake is detected.
 */
export class ZmodemSession {
  private readonly sentry: Sentry;
  private active = false;
  private pendingSend: ZmodemSendFile[] = [];

  constructor(
    sender: (data: Uint8Array) => void,
    private readonly callbacks: ZmodemCallbacks,
  ) {
    this.sentry = new Sentry({
      to_terminal: (octets: number[]) => {
        callbacks.onTerminalData(new Uint8Array(octets));
      },
      sender: (octets: number[]) => {
        sender(new Uint8Array(octets));
      },
      on_retract: () => {
        if (this.active) {
          this.active = false;
          this.pendingSend = [];
          callbacks.onStateChange("idle");
        }
      },
      on_detect: (detection) => {
        const zsession = detection.confirm();
        if (zsession.type === "receive") {
          this.doReceive(zsession);
        } else {
          if (this.pendingSend.length > 0) {
            const files = this.pendingSend;
            this.pendingSend = [];
            this.doSendAll(zsession, files);
          } else {
            this.doSelectAndSend(zsession);
          }
        }
      },
    });
  }

  consume(data: Uint8Array): void {
    try {
      this.sentry.consume(Array.from(data));
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      this.active = false;
      this.pendingSend = [];
      this.callbacks.onStateChange("idle");
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  queueSend(files: ZmodemSendFile[]): void {
    this.pendingSend = files;
  }

  private doReceive(zsession: Session): void {
    this.active = true;
    this.callbacks.onStateChange("receiving");

    void (async () => {
      const saveDir = await this.callbacks.onSelectSaveDir();
      if (!saveDir) {
        zsession.abort();
        this.active = false;
        this.callbacks.onStateChange("idle");
        return;
      }

      const sep = saveDir.includes("\\") ? "\\" : "/";
      const dirBase = saveDir.replace(/[/\\]+$/, "");

      zsession.on("offer", (offer: Offer) => {
        const details = offer.get_details();
        const fullPath = dirBase + sep + details.name;
        const progress: ZmodemProgress = {
          fileName: details.name,
          fileSize: details.size ?? 0,
          bytesTransferred: 0,
        };
        this.callbacks.onStateChange("receiving", progress);

        void (async () => {
          let handleId: string | null = null;
          let appendChain = Promise.resolve();
          let appendError: unknown = null;

          try {
            handleId = await this.callbacks.onOpenWriteStream(fullPath);

            offer.on("input", (octets: number[]) => {
              const chunk = new Uint8Array(octets);
              progress.bytesTransferred += chunk.length;
              this.callbacks.onProgress({ ...progress });

              appendChain = appendChain
                .then(() => {
                  if (appendError || handleId == null) return undefined;
                  return this.callbacks.onAppendWriteStream(handleId, chunk);
                })
                .catch((err: unknown) => {
                  appendError = err;
                });
            });

            await offer.accept();
            await appendChain;
            if (appendError) throw appendError;
            await this.callbacks.onCloseWriteStream(handleId);
            handleId = null;
            this.callbacks.onComplete(details.name);
          } catch (err: unknown) {
            if (handleId) {
              await this.callbacks.onAbortWriteStream(handleId).catch(() => undefined);
            }
            this.callbacks.onError(err instanceof Error ? err.message : String(err));
          }
        })();
      });

      zsession.on("session_end", () => {
        this.active = false;
        this.callbacks.onStateChange("idle");
      });

      zsession.start();
    })();
  }

  private doSelectAndSend(zsession: Session): void {
    const selectFiles = this.callbacks.onSelectSendFiles;
    if (!selectFiles) {
      zsession.abort();
      this.callbacks.onError("Unexpected ZMODEM send session (no file queued)");
      return;
    }

    this.active = true;
    this.callbacks.onStateChange("sending");

    void (async () => {
      let delegatedToSender = false;
      try {
        const files = await selectFiles();
        if (!files || files.length === 0) {
          zsession.abort();
          return;
        }
        delegatedToSender = true;
        this.doSendAll(zsession, files);
      } catch (err) {
        try {
          zsession.abort();
        } catch {
          /* session may already be closed */
        }
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!delegatedToSender) {
          this.active = false;
          this.callbacks.onStateChange("idle");
        }
      }
    })();
  }

  private doSendAll(zsession: Session, files: ZmodemSendFile[]): void {
    if (files.length === 0) {
      zsession.abort();
      this.active = false;
      this.callbacks.onStateChange("idle");
      return;
    }

    this.active = true;
    const first = files[0];
    const progress: ZmodemProgress = {
      fileName: first.name,
      fileSize: first.bytes.length,
      bytesTransferred: 0,
    };
    this.callbacks.onStateChange("sending", progress);

    void (async () => {
      try {
        for (const { name, bytes } of files) {
          progress.fileName = name;
          progress.fileSize = bytes.length;
          progress.bytesTransferred = 0;
          this.callbacks.onStateChange("sending", { ...progress });

          const xfer: Transfer | undefined = await zsession.send_offer({
            name,
            size: bytes.length,
            mtime: Math.floor(Date.now() / 1000),
          });

          if (!xfer) {
            this.callbacks.onError(`Remote skipped file: ${name}`);
          } else {
            for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK) {
              xfer.send(Array.from(bytes.slice(offset, offset + SEND_CHUNK)));
              progress.bytesTransferred = Math.min(offset + SEND_CHUNK, bytes.length);
              this.callbacks.onProgress({ ...progress });
            }
            await xfer.end([]);
            this.callbacks.onComplete(name);
          }
        }

        await zsession.close();
      } catch (err) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      } finally {
        this.active = false;
        this.callbacks.onStateChange("idle");
      }
    })();
  }
}
