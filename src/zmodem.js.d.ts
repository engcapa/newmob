declare module "zmodem.js" {
  export class Sentry {
    constructor(opts: {
      to_terminal(octets: number[]): void;
      sender(octets: number[]): void;
      on_retract(): void;
      on_detect(detection: Detection): void;
    });
    consume(octets: number[]): void;
  }

  export class Detection {
    confirm(): Session;
    deny(): void;
    is_valid(): boolean;
    get_session_role(): "send" | "receive";
  }

  export class Session {
    type: "send" | "receive";
    on(event: "offer", cb: (offer: Offer) => void): void;
    on(event: "session_end", cb: () => void): void;
    on(event: "receive", cb: (payload: unknown) => void): void;
    start(): void;
    close(): Promise<void>;
    send_offer(details: { name: string; size: number; mtime: number }): Promise<Transfer | undefined>;
    abort(): void;
  }

  export class Offer {
    get_details(): { name: string; size?: number; mtime?: number };
    skip(): void;
    on(event: "input", cb: (octets: number[]) => void): void;
    accept(): Promise<void>;
  }

  export class Transfer {
    send(octets: number[]): void;
    end(octets: number[]): Promise<void>;
  }
}
