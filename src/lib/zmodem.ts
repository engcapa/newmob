import { Sentry, type Detection, type Session, type Offer, type Transfer } from "zmodem.js";

export type ZmodemState = "idle" | "receiving" | "sending";

export interface ZmodemProgress {
  fileName: string;
  fileSize: number;
  bytesTransferred: number;
}

export interface ZmodemSendFile {
  name: string;
  path: string;
}

export interface ZmodemReadStream {
  handleId: string;
  size: number;
  mtime: number;
}

export type ConflictActionType = "overwrite" | "skip" | "rename";

export interface ConflictAction {
  type: ConflictActionType;
  applyToAll: boolean;
}

export interface SendConflictAction {
  type: "skip" | "rename";
  applyToAll: boolean;
}

export interface ZmodemCallbacks {
  onTerminalData: (data: Uint8Array) => void;
  onStateChange: (state: ZmodemState, progress?: ZmodemProgress) => void;
  onProgress: (progress: ZmodemProgress) => void;
  /** Called once before the first file arrives. Return the directory to save into, or null to cancel. */
  onSelectSaveDir: () => Promise<string | null>;
  /** Called when the remote starts rz without a queued file. Return files to send, or null/empty to cancel. */
  onSelectSendFiles?: () => Promise<ZmodemSendFile[] | null>;
  /** Check whether a local path already exists. */
  onCheckFileExists: (path: string) => Promise<boolean>;
  /** Called when a receive target file already exists. hasMore=true when more files are pending. */
  onFileConflict: (fileName: string, hasMore: boolean) => Promise<ConflictAction>;
  /** Called when the remote rz skipped a file (remote file already exists).
   *  Return "skip" to skip, or "rename" to retry with a numbered name. */
  onSendConflict?: (fileName: string, hasMore: boolean) => Promise<SendConflictAction>;
  onOpenReadStream: (path: string) => Promise<ZmodemReadStream>;
  onReadStream: (handleId: string, maxBytes: number) => Promise<Uint8Array>;
  onCloseReadStream: (handleId: string) => Promise<void>;
  onOpenWriteStream: (fullPath: string) => Promise<string>;
  onAppendWriteStream: (handleId: string, data: Uint8Array) => Promise<void>;
  onCloseWriteStream: (handleId: string) => Promise<void>;
  onAbortWriteStream: (handleId: string) => Promise<void>;
  onComplete: (fileName: string) => void;
  onError: (message: string) => void;
}

const SEND_CHUNK = 64 * 1024;
const RECEIVE_FINALIZE_GRACE_MS = 750;

type ZmodemSender = (data: Uint8Array) => void | Promise<void>;

/**
 * Wraps a zmodem.js Sentry to detect and handle ZMODEM transfers over the
 * existing SSH byte stream. Feed all terminal output through consume();
 * the sentry routes non-ZMODEM bytes to onTerminalData and takes over the
 * channel when a handshake is detected.
 */
export class ZmodemSession {
  private sentry: Sentry;
  private active = false;
  private pendingSend: ZmodemSendFile[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private sendErrorReported = false;
  private currentSession: Session | null = null;
  private receiveFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSendDetection: Detection | null = null;
  private selectingSendFiles = false;
  private sendSelectionId = 0;

  constructor(
    private readonly sender: ZmodemSender,
    private readonly callbacks: ZmodemCallbacks,
  ) {
    this.sentry = this.createSentry();
  }

  private createSentry(): Sentry {
    return new Sentry({
      to_terminal: (octets: number[]) => {
        this.callbacks.onTerminalData(new Uint8Array(octets));
      },
      sender: (octets: number[]) => {
        this.queueSendToPeer(octets);
      },
      on_retract: () => {
        if (this.selectingSendFiles && !this.currentSession) {
          this.pendingSendDetection = null;
          return;
        }
        if (this.active) {
          this.active = false;
          this.pendingSend = [];
          this.currentSession = null;
          this.pendingSendDetection = null;
          this.clearReceiveFinalizeTimer();
          this.callbacks.onStateChange("idle");
        }
      },
      on_detect: (detection) => {
        this.resetSendQueue();
        const role = detection.get_session_role();
        if (role === "send" && this.pendingSend.length === 0) {
          this.doSelectThenConfirmSend(detection);
          return;
        }

        const zsession = detection.confirm();
        this.currentSession = zsession;
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
      this.resetProtocolState();
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  queueSend(files: ZmodemSendFile[]): void {
    this.pendingSend = files;
  }

  private resetSendQueue(): void {
    this.sendChain = Promise.resolve();
    this.sendErrorReported = false;
  }

  private resetProtocolState(): void {
    this.clearReceiveFinalizeTimer();
    this.resetSendQueue();
    this.currentSession = null;
    this.pendingSendDetection = null;
    this.selectingSendFiles = false;
    this.sendSelectionId++;
    this.active = false;
    this.pendingSend = [];
    this.sentry = this.createSentry();
    this.callbacks.onStateChange("idle");
  }

  private clearReceiveFinalizeTimer(): void {
    if (this.receiveFinalizeTimer) {
      clearTimeout(this.receiveFinalizeTimer);
      this.receiveFinalizeTimer = null;
    }
  }

  private finishSession(zsession: Session): void {
    if (this.currentSession !== zsession) return;
    this.clearReceiveFinalizeTimer();
    this.currentSession = null;
    this.active = false;
    this.callbacks.onStateChange("idle");
  }

  private scheduleReceiveFinalize(zsession: Session): void {
    this.clearReceiveFinalizeTimer();
    this.receiveFinalizeTimer = setTimeout(() => {
      if (this.currentSession !== zsession || !this.active) return;
      this.resetProtocolState();
    }, RECEIVE_FINALIZE_GRACE_MS);
  }

  private queueSendToPeer(octets: number[]): void {
    const bytes = new Uint8Array(octets);
    this.sendChain = this.sendChain
      .then(() => this.sender(bytes))
      .catch((err: unknown) => {
        if (!this.sendErrorReported) {
          this.sendErrorReported = true;
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
          this.resetProtocolState();
        }
        throw err;
      });
    void this.sendChain.catch(() => undefined);
  }

  private doReceive(zsession: Session): void {
    this.active = true;
    this.callbacks.onStateChange("receiving");

    void (async () => {
      const saveDir = await this.callbacks.onSelectSaveDir();
      if (!saveDir) {
        zsession.abort();
        this.resetProtocolState();
        return;
      }

      const sep = saveDir.includes("\\") ? "\\" : "/";
      const dirBase = saveDir.replace(/[/\\]+$/, "");

      // Tracks a "apply to all" policy chosen by the user for conflict resolution.
      let conflictPolicy: ConflictActionType | null = null;
      // Counts pending offers so we can pass hasMore correctly.
      let pendingOffers = 0;

      zsession.on("offer", (offer: Offer) => {
        pendingOffers++;
        const details = offer.get_details();
        const baseName = details.name;
        const progress: ZmodemProgress = {
          fileName: baseName,
          fileSize: details.size ?? 0,
          bytesTransferred: 0,
        };
        this.callbacks.onStateChange("receiving", progress);

        void (async () => {
          pendingOffers--;
          let handleId: string | null = null;
          let appendChain = Promise.resolve();
          let appendError: unknown = null;

          try {
            const initialPath = dirBase + sep + baseName;
            const exists = await this.callbacks.onCheckFileExists(initialPath);

            let resolvedPath = initialPath;
            let shouldSkip = false;

            if (exists) {
              let actionType = conflictPolicy;
              if (actionType === null) {
                const action = await this.callbacks.onFileConflict(baseName, pendingOffers > 0);
                if (action.applyToAll) {
                  conflictPolicy = action.type;
                }
                actionType = action.type;
              }

              if (actionType === "skip") {
                shouldSkip = true;
              } else if (actionType === "rename") {
                resolvedPath = await this.resolveRenamedPath(dirBase, sep, baseName);
              }
              // "overwrite" keeps resolvedPath = initialPath
            }

            if (shouldSkip) {
              offer.skip();
              return;
            }

            handleId = await this.callbacks.onOpenWriteStream(resolvedPath);

            const onInput = (octets: number[]) => {
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
            };

            await offer.accept({ on_input: onInput });
            await appendChain;
            if (appendError) throw appendError;
            await this.callbacks.onCloseWriteStream(handleId);
            handleId = null;
            this.callbacks.onComplete(resolvedPath.replace(/.*[/\\]/, "") || baseName);
          } catch (err: unknown) {
            if (handleId) {
              await this.callbacks.onAbortWriteStream(handleId).catch(() => undefined);
            }
            this.callbacks.onError(err instanceof Error ? err.message : String(err));
          }
        })();
      });

      zsession.on("session_end", () => {
        this.finishSession(zsession);
      });

      zsession.on("receive", (payload: unknown) => {
        if (isZfinHeader(payload)) {
          this.scheduleReceiveFinalize(zsession);
        }
      });

      zsession.start();
    })();
  }

  private async resolveRenamedPath(dirBase: string, sep: string, name: string): Promise<string> {
    const lastDot = name.lastIndexOf(".");
    const stem = lastDot > 0 ? name.slice(0, lastDot) : name;
    const ext = lastDot > 0 ? name.slice(lastDot) : "";

    for (let i = 1; i <= 9999; i++) {
      const candidate = dirBase + sep + stem + `(${i})` + ext;
      const taken = await this.callbacks.onCheckFileExists(candidate);
      if (!taken) return candidate;
    }
    // Fallback: append timestamp to guarantee uniqueness.
    return dirBase + sep + stem + `(${Date.now()})` + ext;
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

  private doSelectThenConfirmSend(detection: Detection): void {
    this.pendingSendDetection = detection;
    if (this.selectingSendFiles) return;

    const selectFiles = this.callbacks.onSelectSendFiles;
    if (!selectFiles) {
      this.abortPendingSendDetection();
      this.callbacks.onError("Unexpected ZMODEM send session (no file queued)");
      return;
    }

    this.selectingSendFiles = true;
    const selectionId = ++this.sendSelectionId;
    this.active = true;
    this.callbacks.onStateChange("sending");

    void (async () => {
      let delegatedToSender = false;
      try {
        const files = await selectFiles();
        if (selectionId !== this.sendSelectionId) return;

        if (!files || files.length === 0) {
          this.abortPendingSendDetection();
          return;
        }

        const zsession = this.confirmPendingSendDetection();
        if (!zsession) {
          this.callbacks.onError("Remote rz is no longer waiting for files");
          return;
        }

        delegatedToSender = true;
        this.doSendAll(zsession, files);
      } catch (err) {
        this.abortPendingSendDetection();
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      } finally {
        if (selectionId === this.sendSelectionId) {
          this.selectingSendFiles = false;
          if (!delegatedToSender) {
            this.active = false;
            this.currentSession = null;
            this.callbacks.onStateChange("idle");
          }
        }
      }
    })();
  }

  private confirmPendingSendDetection(): Session | null {
    const detection = this.pendingSendDetection;
    this.pendingSendDetection = null;
    if (!detection?.is_valid()) return null;

    const zsession = detection.confirm();
    this.currentSession = zsession;
    return zsession;
  }

  private abortPendingSendDetection(): void {
    const detection = this.pendingSendDetection;
    this.pendingSendDetection = null;
    if (!detection?.is_valid()) return;
    try {
      detection.deny();
    } catch {
      /* detection may have become stale between the validity check and abort */
    }
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
      fileSize: 0,
      bytesTransferred: 0,
    };
    this.callbacks.onStateChange("sending", progress);

    void (async () => {
      let sendConflictPolicy: SendConflictAction["type"] | null = null;

      try {
        for (let index = 0; index < files.length; index++) {
          const { name, path } = files[index];
          const hasMore = index < files.length - 1;
          let handleId: string | null = null;

          try {
            const stream = await this.callbacks.onOpenReadStream(path);
            handleId = stream.handleId;

            progress.fileName = name;
            progress.fileSize = stream.size;
            progress.bytesTransferred = 0;
            this.callbacks.onStateChange("sending", { ...progress });

            let xfer: Transfer | undefined = await zsession.send_offer({
              name,
              size: stream.size,
              mtime: stream.mtime,
            });

            if (!xfer) {
              const onSendConflict = this.callbacks.onSendConflict;
              if (!onSendConflict) {
                this.callbacks.onError(`Remote skipped file: ${name}`);
                await this.callbacks.onCloseReadStream(handleId);
                handleId = null;
                continue;
              }

              let actionType = sendConflictPolicy;
              if (actionType === null) {
                const action = await onSendConflict(name, hasMore);
                if (action.applyToAll) sendConflictPolicy = action.type;
                actionType = action.type;
              }

              if (actionType === "skip") {
                await this.callbacks.onCloseReadStream(handleId);
                handleId = null;
                continue;
              }

              // rename: try name(1), name(2), ... until remote accepts
              let accepted = false;
              for (let n = 1; n <= 9999; n++) {
                const newName = numberedName(name, n);
                xfer = await zsession.send_offer({
                  name: newName,
                  size: stream.size,
                  mtime: stream.mtime,
                });
                if (xfer) {
                  progress.fileName = newName;
                  this.callbacks.onStateChange("sending", { ...progress });
                  accepted = true;
                  break;
                }
              }

              if (!accepted) {
                this.callbacks.onError(`Could not send ${name}: remote rejected all rename attempts`);
                await this.callbacks.onCloseReadStream(handleId);
                handleId = null;
                continue;
              }
            }

            for (;;) {
              const chunk = await this.callbacks.onReadStream(handleId, SEND_CHUNK);
              if (chunk.length === 0) break;
              xfer!.send(chunk);
              progress.bytesTransferred += chunk.length;
              this.callbacks.onProgress({ ...progress });
            }

            await this.callbacks.onCloseReadStream(handleId);
            handleId = null;
            await xfer!.end(new Uint8Array());
            this.callbacks.onComplete(progress.fileName);
          } catch (err) {
            if (handleId) {
              await this.callbacks.onCloseReadStream(handleId).catch(() => undefined);
            }
            throw err;
          }
        }

        await zsession.close();
      } catch (err) {
        try {
          zsession.abort();
        } catch {
          /* session may already be closed */
        }
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      } finally {
        this.active = false;
        if (this.currentSession === zsession) this.currentSession = null;
        this.callbacks.onStateChange("idle");
      }
    })();
  }
}

function isZfinHeader(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { NAME?: unknown }).NAME === "ZFIN"
  );
}

function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem}(${n})${ext}`;
}
