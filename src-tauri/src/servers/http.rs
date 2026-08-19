//! Static-file HTTP/1.1 server built on raw `tokio` sockets (no axum/hyper).
//!
//! Serves files from `config.extra["rootDir"]` (falling back to the user's home
//! directory). Supports `GET` and `HEAD`, a curated set of content-types by
//! extension, `404 Not Found`, and an HTML directory index when the
//! `directoryListing` flag is set. When `cors` is set, every response carries
//! `Access-Control-Allow-Origin: *`.
//!
//! Path-traversal safe: the requested path is percent-decoded, joined to the
//! root, canonicalized, and rejected unless it still resolves inside the root.

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};

use tokio::io::AsyncBufReadExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

use super::ServerConfig;
use super::engine::{LogEmitter, ServerCtx, ServerStarted};

const DEFAULT_PORT: u16 = 8080;

/// Resolved per-server settings shared with every connection task.
#[derive(Clone)]
struct HttpOpts {
    root: PathBuf,
    directory_listing: bool,
    cors: bool,
}

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 {
        DEFAULT_PORT
    } else {
        config.port
    };
    let bind = config.bind_address.clone();

    // Resolve the document root, falling back to the home directory.
    let root = resolve_root(&config);
    if !root.is_dir() {
        return Err(format!(
            "root directory does not exist or is not a directory: {}",
            root.display()
        ));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("failed to resolve root {}: {}", root.display(), e))?;

    let opts = HttpOpts {
        root: root.clone(),
        directory_listing: config.bool_field("directoryListing", true),
        cors: config.bool_field("cors", false),
    };

    // Bind before spawning so a bind failure surfaces as a startup error.
    let addr = format!("{}:{}", bind, port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind {}: {}", addr, e))?;

    ctx.log.line(format!(
        "HTTP server listening on {} — serving {}{}",
        addr,
        root.display(),
        if opts.cors { " (CORS enabled)" } else { "" }
    ));

    let cancel = ctx.cancel.clone();
    let log = ctx.log.clone();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log.line("HTTP server stopping");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            let opts = opts.clone();
                            let log = log.clone();
                            tokio::spawn(async move {
                                if let Err(e) = handle_conn(stream, peer, &opts, &log).await {
                                    log.line(format!("{}: connection error: {}", peer, e));
                                }
                            });
                        }
                        Err(e) => log.line(format!("accept error: {}", e)),
                    }
                }
            }
        }
    });

    Ok(ServerStarted { pid: None, task })
}

fn resolve_root(config: &ServerConfig) -> PathBuf {
    let raw = config.str_field("rootDir", "");
    if !raw.is_empty() {
        PathBuf::from(raw)
    } else {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
    }
}

/// Read and serve a single HTTP request. We keep connections one-shot
/// (`Connection: close`) for simplicity and predictable teardown.
async fn handle_conn(
    stream: TcpStream,
    _peer: SocketAddr,
    opts: &HttpOpts,
    log: &LogEmitter,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream);

    // Read the request line.
    let mut request_line = String::new();
    let n = reader.read_line(&mut request_line).await?;
    if n == 0 {
        return Ok(()); // client closed without sending anything
    }

    // Drain (and ignore) the remaining headers up to the blank line.
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header).await?;
        if read == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let raw_target = parts.next().unwrap_or("/").to_string();

    let mut stream = reader.into_inner();

    // Only GET/HEAD are supported; everything else gets 405.
    let head_only = match method.as_str() {
        "GET" => false,
        "HEAD" => true,
        _ => {
            log.line(format!("{} {} -> 405", method, raw_target));
            write_simple(&mut stream, 405, "Method Not Allowed", opts.cors, true).await?;
            return Ok(());
        }
    };

    // Strip any query string and percent-decode the path.
    let path_part = raw_target.split(['?', '#']).next().unwrap_or("/");
    let decoded = percent_decode(path_part);

    let resolved = match safe_join(&opts.root, &decoded) {
        Some(p) => p,
        None => {
            log.line(format!("{} {} -> 403", method, raw_target));
            write_simple(&mut stream, 403, "Forbidden", opts.cors, !head_only).await?;
            return Ok(());
        }
    };

    if resolved.is_dir() {
        // Try an index.html first, then optionally a directory listing.
        let index = resolved.join("index.html");
        if index.is_file() {
            serve_file(
                &mut stream,
                &index,
                head_only,
                opts,
                log,
                &method,
                &raw_target,
            )
            .await?;
        } else if opts.directory_listing {
            let body = render_listing(&opts.root, &resolved, &decoded);
            log.line(format!("{} {} -> 200 (listing)", method, raw_target));
            write_response(
                &mut stream,
                200,
                "OK",
                "text/html; charset=utf-8",
                body.as_bytes(),
                opts.cors,
                head_only,
            )
            .await?;
        } else {
            log.line(format!("{} {} -> 403", method, raw_target));
            write_simple(&mut stream, 403, "Forbidden", opts.cors, !head_only).await?;
        }
    } else if resolved.is_file() {
        serve_file(
            &mut stream,
            &resolved,
            head_only,
            opts,
            log,
            &method,
            &raw_target,
        )
        .await?;
    } else {
        log.line(format!("{} {} -> 404", method, raw_target));
        write_simple(&mut stream, 404, "Not Found", opts.cors, !head_only).await?;
    }

    Ok(())
}

async fn serve_file(
    stream: &mut TcpStream,
    path: &Path,
    head_only: bool,
    opts: &HttpOpts,
    log: &LogEmitter,
    method: &str,
    raw_target: &str,
) -> std::io::Result<()> {
    match tokio::fs::File::open(path).await {
        Ok(mut file) => {
            if head_only {
                // For HEAD we report the real length from metadata, no body.
                if let Ok(meta) = file.metadata().await {
                    log.line(format!("{} {} -> 200", method, raw_target));
                    return write_head_with_len(
                        stream,
                        content_type(path),
                        meta.len() as usize,
                        opts.cors,
                    )
                    .await;
                }
            }
            let mut body = Vec::new();
            file.read_to_end(&mut body).await?;
            log.line(format!("{} {} -> 200", method, raw_target));
            write_response(
                stream,
                200,
                "OK",
                content_type(path),
                &body,
                opts.cors,
                head_only,
            )
            .await
        }
        Err(_) => {
            log.line(format!("{} {} -> 404", method, raw_target));
            write_simple(stream, 404, "Not Found", opts.cors, !head_only).await
        }
    }
}

/// Percent-decode a URL path segment string (`%20` -> space, etc.).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Join a decoded request path onto `root`, rejecting any `..` traversal or
/// absolute/rooted components, then verify the canonical result stays inside
/// `root`. Returns `None` if the path escapes the root.
fn safe_join(root: &Path, decoded: &str) -> Option<PathBuf> {
    let rel = decoded.trim_start_matches('/');
    let mut candidate = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => candidate.push(seg),
            Component::CurDir => {}
            // Reject parent refs, root dirs and Windows prefixes outright.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    // If the target exists, canonicalize and re-check containment (defends
    // against symlinks pointing outside the root). If it doesn't exist yet,
    // the component filtering above already guarantees no `..` escape.
    match candidate.canonicalize() {
        Ok(canon) => {
            if canon.starts_with(root) {
                Some(canon)
            } else {
                None
            }
        }
        Err(_) => Some(candidate),
    }
}

/// Map a file extension to a sensible content-type.
fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "log" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

/// Build an HTML directory index for `dir`. `url_path` is the decoded request
/// path (used to build child links and a parent link).
fn render_listing(root: &Path, dir: &Path, url_path: &str) -> String {
    let mut entries: Vec<(String, bool)> = Vec::new();
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push((name, is_dir));
        }
    }
    // Directories first, then files, each alphabetically.
    entries.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });

    let display_path = if url_path.is_empty() { "/" } else { url_path };
    let base = if display_path.ends_with('/') {
        display_path.to_string()
    } else {
        format!("{}/", display_path)
    };

    let mut html = String::new();
    html.push_str("<!DOCTYPE html><html><head><meta charset=\"utf-8\">");
    html.push_str(&format!(
        "<title>Index of {}</title>",
        html_escape(display_path)
    ));
    html.push_str("<style>body{font-family:system-ui,monospace;margin:2rem;}a{text-decoration:none;}li{margin:2px 0;}</style>");
    html.push_str("</head><body>");
    html.push_str(&format!(
        "<h2>Index of {}</h2><ul>",
        html_escape(display_path)
    ));

    // Parent link (unless we're at the served root).
    if dir != root {
        html.push_str("<li><a href=\"../\">../</a></li>");
    }
    for (name, is_dir) in entries {
        let suffix = if is_dir { "/" } else { "" };
        let href = format!("{}{}{}", base, encode_path_segment(&name), suffix);
        html.push_str(&format!(
            "<li><a href=\"{}\">{}{}</a></li>",
            html_escape(&href),
            html_escape(&name),
            suffix
        ));
    }
    html.push_str("</ul></body></html>");
    html
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Minimal percent-encoding for path segments in generated links (space and a
/// few reserved chars). Keeps unreserved ASCII as-is.
fn encode_path_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn cors_header(cors: bool) -> &'static str {
    if cors {
        "Access-Control-Allow-Origin: *\r\n"
    } else {
        ""
    }
}

/// Write a full response with a body (body omitted when `head_only`).
async fn write_response(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
    cors: bool,
    head_only: bool,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
        code,
        reason,
        content_type,
        body.len(),
        cors_header(cors),
    );
    stream.write_all(header.as_bytes()).await?;
    if !head_only {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

/// Write a `HEAD` response carrying the real content length without a body.
async fn write_head_with_len(
    stream: &mut TcpStream,
    content_type: &str,
    len: usize,
    cors: bool,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n",
        content_type,
        len,
        cors_header(cors),
    );
    stream.write_all(header.as_bytes()).await?;
    stream.flush().await
}

/// Write a tiny text/plain status response (used for 403/404/405).
async fn write_simple(
    stream: &mut TcpStream,
    code: u16,
    reason: &str,
    cors: bool,
    with_body: bool,
) -> std::io::Result<()> {
    let body = format!("{} {}", code, reason);
    write_response(
        stream,
        code,
        reason,
        "text/plain; charset=utf-8",
        body.as_bytes(),
        cors,
        !with_body,
    )
    .await
}
