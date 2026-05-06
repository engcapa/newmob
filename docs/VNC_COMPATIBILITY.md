# VNC Compatibility Matrix

NewMob implements a subset of the RFB (Remote Framebuffer) 3.3/3.7/3.8 protocol. This document describes what is supported and what is not.

## Authentication

| Method        | Status | Notes                                              |
|---------------|--------|----------------------------------------------------|
| None          | ✅     | No password required                               |
| VNC Password  | ✅     | DES challenge-response (type 2)                    |
| RA2 / RA2ne   | ✅     | RealVNC RSA-AES (128-bit and 256-bit variants)     |
| Apple Remote  | ❌     | Not implemented                                    |
| VeNCrypt      | ❌     | Not implemented                                    |
| TLS           | ❌     | Not implemented                                    |

## Encodings

| Encoding       | Status | Notes                                                                 |
|----------------|--------|-----------------------------------------------------------------------|
| Raw (0)        | ✅     | Fully stable, exact length known ahead of time                        |
| CopyRect (1)   | ✅     | Fully stable, exact 4-byte length                                     |
| RRE (2)        | ❌     | Not implemented                                                       |
| Hextile (5)    | 🟡     | Stream-accurate parser implemented; disabled by default               |
| Tight (7)      | 🟡     | Stream-accurate parser implemented; disabled by default               |
| ZRLE (16)      | 🟡     | Accurate 4-byte length prefix; disabled by default                    |
| DesktopSize (-223)      | ✅     | Pseudo-encoding, resizes framebuffer                     |
| ExtendedDesktopSize (-308) | ❌  | Not implemented (SetDesktopSize 251 is used instead)       |
| Cursor (-239)  | ❌     | Not implemented                                                       |
| CursorWithAlpha (-260) | ❌ | Not implemented                                                       |

### Enabling experimental encodings

By default only Raw + CopyRect + DesktopSize are requested. To enable Hextile, Tight and ZRLE, set the environment variable before launching NewMob:

```bash
VNC_EXPERIMENTAL_ENCODINGS=1 pnpm tauri dev
```

## Pseudo-encodings

| Pseudo-encoding | Status | Notes                                      |
|-----------------|--------|--------------------------------------------|
| DesktopSize     | ✅     | Server-initiated resize                    |
| SetDesktopSize  | ✅     | Client-initiated resize (message type 251) |
| ExtendedDesktopSize | ❌ | Message type 252 (optional enhancement)    |

## Known limitations

- **Cursor pseudo-encoding** is not supported; the remote cursor is not rendered locally.
- **Tight JPEG sub-encoding** does not decode JPEG data; it will show a gray placeholder if the server sends JPEG tiles.
- **Clipboard** (ServerCutText / ClientCutText) is passed through but limited to plain text.
- **Stream-accurate parsing** for Hextile/Tight is conservative; if a server sends malformed or unexpected subrects, the connection will drop with a `protocol-error` reason so the user can fall back to Raw.
- **Large framebuffer updates** can briefly block the control loop because `read_message` runs synchronously on the RFB stream.
