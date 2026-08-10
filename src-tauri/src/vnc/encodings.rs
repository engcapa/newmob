use flate2::{Decompress, FlushDecompress};
use std::io::Read;

use crate::vnc::limits::DecodeLimits;

/// A decoded framebuffer rectangle, in destination RGBA32.
///
/// `Copy` rectangles are resolved against the framebuffer inside the decoder,
/// so what we emit upstream is always pixel data.
#[derive(Debug)]
pub enum DecodedRect {
    Pixels {
        x: u16,
        y: u16,
        w: u16,
        h: u16,
        rgba: Vec<u8>,
    },
}

// ── Helpers to read big-endian integers from an `impl Read`. ──

fn read_u8<R: Read>(r: &mut R) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

fn read_u16_be<R: Read>(r: &mut R) -> std::io::Result<u16> {
    let mut b = [0u8; 2];
    r.read_exact(&mut b)?;
    Ok(u16::from_be_bytes(b))
}

fn read_u32_be<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}

// ── Raw encoding (type 0) ──────────────────────────────────────────

/// Read a Raw-encoded rectangle from the stream: `w*h` PIXEL units of 4 bytes
/// each (per the RGBA32 pixel format we negotiate). Alpha byte is forced to
/// 0xFF because many servers leave it at 0.
pub fn read_raw<R: Read>(r: &mut R, x: u16, y: u16, w: u16, h: u16) -> Result<DecodedRect, String> {
    let pixel_count = usize::from(w)
        .checked_mul(usize::from(h))
        .ok_or_else(|| "raw: pixel count overflow".to_string())?;
    let byte_count = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "raw: byte count overflow".to_string())?;
    let mut rgba = vec![0u8; byte_count];
    r.read_exact(&mut rgba)
        .map_err(|e| format!("raw: read pixels: {}", e))?;
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    Ok(DecodedRect::Pixels { x, y, w, h, rgba })
}

// ── CopyRect encoding (type 1) ─────────────────────────────────────

/// Read the 4-byte CopyRect payload (src_x, src_y) and resolve it against the
/// framebuffer, returning a Pixels rectangle that contains the copied region
/// so downstream consumers do not need to understand the framebuffer.
pub fn read_copyrect<R: Read>(
    r: &mut R,
    dst_x: u16,
    dst_y: u16,
    w: u16,
    h: u16,
    fb: &[u8],
    fb_w: u16,
    fb_h: u16,
) -> Result<DecodedRect, String> {
    let src_x = read_u16_be(r).map_err(|e| format!("copyrect: src_x: {}", e))?;
    let src_y = read_u16_be(r).map_err(|e| format!("copyrect: src_y: {}", e))?;

    let source_right = src_x
        .checked_add(w)
        .ok_or_else(|| "copyrect: source x coordinate overflow".to_string())?;
    let source_bottom = src_y
        .checked_add(h)
        .ok_or_else(|| "copyrect: source y coordinate overflow".to_string())?;
    if source_right > fb_w || source_bottom > fb_h {
        return Err(format!(
            "copyrect: source ({src_x},{src_y}) {w}x{h} exceeds framebuffer {fb_w}x{fb_h}"
        ));
    }

    let fb_w = usize::from(fb_w);
    let fb_h = usize::from(fb_h);
    let w_us = w as usize;
    let h_us = h as usize;
    let framebuffer_bytes = fb_w
        .checked_mul(fb_h)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "copyrect: framebuffer byte size overflow".to_string())?;
    if fb.len() < framebuffer_bytes {
        return Err(format!(
            "copyrect: framebuffer has {} bytes, expected {framebuffer_bytes}",
            fb.len()
        ));
    }
    let rectangle_bytes = w_us
        .checked_mul(h_us)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "copyrect: rectangle byte size overflow".to_string())?;
    let mut rgba = vec![0u8; rectangle_bytes];
    for row in 0..h_us {
        let sy = src_y as usize + row;
        let src_start = (sy * fb_w + src_x as usize) * 4;
        let src_end = src_start + w_us * 4;
        let dst_start = row * w_us * 4;
        let dst_end = dst_start + w_us * 4;
        rgba[dst_start..dst_end].copy_from_slice(&fb[src_start..src_end]);
    }
    Ok(DecodedRect::Pixels {
        x: dst_x,
        y: dst_y,
        w,
        h,
        rgba,
    })
}

// ── Hextile encoding (type 5) ──────────────────────────────────────

const HEXTILE_RAW: u8 = 0x01;
const HEXTILE_BG_SPECIFIED: u8 = 0x02;
const HEXTILE_FG_SPECIFIED: u8 = 0x04;
const HEXTILE_ANY_SUBRECTS: u8 = 0x08;
const HEXTILE_SUBRECTS_COLOURED: u8 = 0x10;

/// State carried across Hextile tiles: RFB requires bg/fg to persist when the
/// server omits them from a tile.
#[derive(Default)]
pub struct HextileState {
    bg: [u8; 4],
    fg: [u8; 4],
    bg_valid: bool,
    fg_valid: bool,
}

impl HextileState {
    pub fn new() -> Self {
        Self::default()
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Read a Hextile-encoded rectangle from the stream, tile-by-tile.
///
/// Unlike the previous decoder, this implementation:
///   - reads exactly as many bytes as the server sent (no heuristics),
///   - carries bg/fg across tiles per the RFB spec,
///   - applies the five subencoding flags correctly.
pub fn read_hextile<R: Read>(
    r: &mut R,
    rect_x: u16,
    rect_y: u16,
    rect_w: u16,
    rect_h: u16,
    state: &mut HextileState,
) -> Result<Vec<DecodedRect>, String> {
    if rect_w == 0 || rect_h == 0 {
        return Err("hextile: rectangle dimensions must be non-zero".to_string());
    }
    let rect_right = rect_x
        .checked_add(rect_w)
        .ok_or_else(|| "hextile: rectangle x coordinate overflow".to_string())?;
    let rect_bottom = rect_y
        .checked_add(rect_h)
        .ok_or_else(|| "hextile: rectangle y coordinate overflow".to_string())?;
    state.reset();
    let mut results: Vec<DecodedRect> = Vec::new();

    let mut tile_y = rect_y;
    while tile_y < rect_bottom {
        let tile_h = 16u16.min(rect_bottom - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_right {
            let tile_w = 16u16.min(rect_right - tile_x);
            let subenc = read_u8(r).map_err(|e| format!("hextile: subenc: {}", e))?;
            if subenc & !0x1f != 0 {
                return Err(format!(
                    "hextile: unsupported subencoding flags {subenc:#04x}"
                ));
            }
            let pixel_count = usize::from(tile_w)
                .checked_mul(usize::from(tile_h))
                .ok_or_else(|| "hextile: tile pixel count overflow".to_string())?;
            let byte_count = pixel_count
                .checked_mul(4)
                .ok_or_else(|| "hextile: tile byte count overflow".to_string())?;

            if subenc & HEXTILE_RAW != 0 {
                if subenc != HEXTILE_RAW {
                    return Err("hextile: raw tile contains incompatible flags".to_string());
                }
                let mut rgba = vec![0u8; byte_count];
                r.read_exact(&mut rgba)
                    .map_err(|e| format!("hextile: raw tile pixels: {}", e))?;
                for pixel in rgba.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba,
                });
                state.bg_valid = false;
                state.fg_valid = false;
                tile_x += tile_w;
                continue;
            }

            if subenc & HEXTILE_SUBRECTS_COLOURED != 0 && subenc & HEXTILE_ANY_SUBRECTS == 0 {
                return Err("hextile: coloured-subrect flag requires subrects flag".to_string());
            }

            if subenc & HEXTILE_BG_SPECIFIED != 0 {
                r.read_exact(&mut state.bg)
                    .map_err(|e| format!("hextile: bg: {}", e))?;
                state.bg[3] = 255;
                state.bg_valid = true;
            } else if !state.bg_valid {
                return Err("hextile: first non-raw tile must specify a background".to_string());
            }
            if subenc & HEXTILE_FG_SPECIFIED != 0 {
                r.read_exact(&mut state.fg)
                    .map_err(|e| format!("hextile: fg: {}", e))?;
                state.fg[3] = 255;
                state.fg_valid = true;
            }

            // Fill the tile with the background colour.
            let mut tile_pixels = vec![0u8; byte_count];
            for i in 0..pixel_count {
                tile_pixels[i * 4..(i + 1) * 4].copy_from_slice(&state.bg);
            }

            if subenc & HEXTILE_ANY_SUBRECTS != 0 {
                let n_subrects =
                    read_u8(r).map_err(|e| format!("hextile: n_subrects: {}", e))? as usize;
                let coloured = subenc & HEXTILE_SUBRECTS_COLOURED != 0;
                if n_subrects > 0 && !coloured && !state.fg_valid {
                    return Err("hextile: non-coloured subrects require a foreground".to_string());
                }
                for _ in 0..n_subrects {
                    let colour = if coloured {
                        let mut c = [0u8; 4];
                        r.read_exact(&mut c)
                            .map_err(|e| format!("hextile: sr colour: {}", e))?;
                        c[3] = 255;
                        c
                    } else {
                        state.fg
                    };
                    let xy = read_u8(r).map_err(|e| format!("hextile: sr xy: {}", e))?;
                    let wh = read_u8(r).map_err(|e| format!("hextile: sr wh: {}", e))?;
                    let sx = (xy >> 4) as usize;
                    let sy = (xy & 0x0F) as usize;
                    let sw = ((wh >> 4) as usize) + 1;
                    let sh = ((wh & 0x0F) as usize) + 1;
                    if sx + sw > usize::from(tile_w) || sy + sh > usize::from(tile_h) {
                        return Err(format!(
                            "hextile: subrectangle {sx},{sy} {sw}x{sh} exceeds tile {tile_w}x{tile_h}"
                        ));
                    }
                    for r2 in sy..sy + sh {
                        for c in sx..sx + sw {
                            let idx = (r2 * tile_w as usize + c) * 4;
                            tile_pixels[idx..idx + 4].copy_from_slice(&colour);
                        }
                    }
                }
            }

            results.push(DecodedRect::Pixels {
                x: tile_x,
                y: tile_y,
                w: tile_w,
                h: tile_h,
                rgba: tile_pixels,
            });
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }

    Ok(results)
}

// ── ZRLE encoding (type 16) ────────────────────────────────────────

/// Persistent ZRLE zlib stream. RFB keeps a single zlib stream that spans
/// every ZRLE rectangle in the session, so the decoder state cannot be
/// discarded between rectangles.
pub struct ZrleDecoder {
    inflater: Decompress,
    /// Decompressed bytes already produced but not yet consumed by a tile.
    buf: Vec<u8>,
    /// Read cursor into `buf`.
    pos: usize,
}

impl ZrleDecoder {
    pub fn new() -> Self {
        Self {
            inflater: Decompress::new(/* zlib */ true),
            buf: Vec::new(),
            pos: 0,
        }
    }
}

impl Default for ZrleDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Read a ZRLE rectangle from the stream. Uses `dec` to preserve zlib state
/// across calls, per RFB 7.7.6.
pub fn read_zrle<R: Read>(
    r: &mut R,
    rect_x: u16,
    rect_y: u16,
    rect_w: u16,
    rect_h: u16,
    dec: &mut ZrleDecoder,
    limits: &DecodeLimits,
) -> Result<Vec<DecodedRect>, String> {
    if rect_w == 0 || rect_h == 0 {
        return Err("zrle: rectangle dimensions must be non-zero".to_string());
    }
    let rect_right = rect_x
        .checked_add(rect_w)
        .ok_or_else(|| "zrle: rectangle x coordinate overflow".to_string())?;
    let rect_bottom = rect_y
        .checked_add(rect_h)
        .ok_or_else(|| "zrle: rectangle y coordinate overflow".to_string())?;
    limits.rectangle_bytes(rect_w, rect_h)?;
    let zlib_len = read_u32_be(r).map_err(|e| format!("zrle: len: {}", e))? as usize;
    if zlib_len > limits.max_compressed_rect_bytes {
        return Err(format!(
            "zrle: compressed rectangle {} bytes exceeds limit {}",
            zlib_len, limits.max_compressed_rect_bytes
        ));
    }
    let mut compressed = vec![0u8; zlib_len];
    r.read_exact(&mut compressed)
        .map_err(|e| format!("zrle: body: {}", e))?;

    // Feed the newly-arrived bytes into the persistent inflater, growing the
    // buffer as we go. The inflater's internal state is preserved across
    // rectangles — RFB keeps a single zlib stream per session.
    //
    // Subtle point: it is NOT enough to stop as soon as the input slice has
    // been fully consumed. miniz_oxide buffers input internally, so
    // `consumed_in == compressed.len()` can mean "bytes copied into the
    // inflater's internal ring" rather than "all output bytes emitted". If
    // the output buffer also happened to fill on that same call, queued
    // bytes are left behind and the tile decoder below then runs off the end
    // with `eof cpixel`. Drain the inflater with an extra empty-input call
    // before returning.
    let mut src_consumed = 0usize;
    let output_start = dec.buf.len();
    loop {
        let current_len = dec.buf.len();
        let next_len = current_len
            .checked_add(64 * 1024)
            .ok_or_else(|| "zrle: decompressed size overflow".to_string())?;
        if next_len.saturating_sub(output_start) > limits.max_decompressed_rect_bytes {
            return Err(format!(
                "zrle: decompressed rectangle exceeds limit {}",
                limits.max_decompressed_rect_bytes
            ));
        }
        dec.buf.resize(next_len, 0);

        let input_slice: &[u8] = if src_consumed < compressed.len() {
            &compressed[src_consumed..]
        } else {
            &[]
        };

        let tin_before = dec.inflater.total_in();
        let tout_before = dec.inflater.total_out();

        let status = dec
            .inflater
            .decompress(
                input_slice,
                &mut dec.buf[current_len..],
                FlushDecompress::None,
            )
            .map_err(|e| format!("zrle: inflate: {}", e))?;

        let consumed_in = (dec.inflater.total_in() - tin_before) as usize;
        let produced_out = (dec.inflater.total_out() - tout_before) as usize;

        dec.buf.truncate(current_len + produced_out);
        src_consumed += consumed_in;

        // All input fed in AND the inflater has nothing more to emit.
        if src_consumed >= compressed.len() && produced_out == 0 {
            break;
        }
        // Safety net against a livelock on malformed input.
        if consumed_in == 0 && produced_out == 0 {
            return Err("zrle: inflater made no progress".to_string());
        }
        if matches!(status, flate2::Status::StreamEnd) {
            break;
        }
    }

    // Now decode tiles from `dec.buf`, advancing `dec.pos`.
    let mut results: Vec<DecodedRect> = Vec::new();
    let mut tile_y = rect_y;
    while tile_y < rect_bottom {
        let tile_h = 64u16.min(rect_bottom - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_right {
            let tile_w = 64u16.min(rect_right - tile_x);
            limits.rectangle_bytes(tile_w, tile_h)?;
            let pixels = zrle_read_tile(&dec.buf, &mut dec.pos, tile_w, tile_h)?;
            results.push(DecodedRect::Pixels {
                x: tile_x,
                y: tile_y,
                w: tile_w,
                h: tile_h,
                rgba: pixels,
            });
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }

    // Compact the buffer once we've cleared enough of it to avoid unbounded growth.
    if dec.pos >= dec.buf.len() {
        dec.buf.clear();
        dec.pos = 0;
    } else if dec.pos > 1 << 20 {
        dec.buf.drain(..dec.pos);
        dec.pos = 0;
    }

    Ok(results)
}

/// Read one ZRLE tile from the already-inflated byte slice.
///
/// ZRLE uses **CPIXEL** — the compact form of the negotiated pixel format.
/// With our RGBA32 format (R@0, G@8, B@16, A@24, little-endian, true-colour,
/// max=255/255/255) the spec says the CPIXEL is 3 bytes (the colour bytes,
/// dropping the zero-padding byte). We send R@0 G@8 B@16 so CPIXEL is `[R, G, B]`.
fn zrle_read_tile(buf: &[u8], pos: &mut usize, w: u16, h: u16) -> Result<Vec<u8>, String> {
    let pixel_count = usize::from(w)
        .checked_mul(usize::from(h))
        .ok_or_else(|| "zrle: tile pixel count overflow".to_string())?;
    let byte_count = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "zrle: tile byte count overflow".to_string())?;
    let mut rgba = vec![0u8; byte_count];

    let subenc = *buf
        .get(*pos)
        .ok_or_else(|| "zrle: eof subenc".to_string())?;
    *pos += 1;

    if subenc == 0 {
        // Raw CPIXEL stream.
        for i in 0..pixel_count {
            let c = read_cpixel(buf, pos)?;
            rgba[i * 4..i * 4 + 4].copy_from_slice(&c);
        }
        return Ok(rgba);
    }

    if subenc == 1 {
        let c = read_cpixel(buf, pos)?;
        for i in 0..pixel_count {
            rgba[i * 4..i * 4 + 4].copy_from_slice(&c);
        }
        return Ok(rgba);
    }

    if (2..=16).contains(&subenc) {
        // Packed palette, 1/2/4 bits-per-pixel.
        let palette_size = subenc as usize;
        let mut palette = [[0u8; 4]; 16];
        for slot in palette.iter_mut().take(palette_size) {
            *slot = read_cpixel(buf, pos)?;
        }
        let bpp: usize = if palette_size == 2 {
            1
        } else if palette_size <= 4 {
            2
        } else {
            4
        };
        // Each row is packed independently: the partial trailing byte of a row
        // is padded, and the next row starts on a fresh byte.
        for row in 0..h as usize {
            let mut col = 0usize;
            while col < w as usize {
                let byte = *buf
                    .get(*pos)
                    .ok_or_else(|| "zrle: eof packed".to_string())?;
                *pos += 1;
                let pixels_in_byte = 8 / bpp;
                for slot in 0..pixels_in_byte {
                    if col >= w as usize {
                        break;
                    }
                    let shift = 8 - (slot + 1) * bpp;
                    let mask = (1u8 << bpp) - 1;
                    let idx = ((byte >> shift) & mask) as usize;
                    let colour =
                        *palette
                            .get(idx)
                            .filter(|_| idx < palette_size)
                            .ok_or_else(|| {
                                format!("zrle: packed palette index {idx} exceeds {palette_size}")
                            })?;
                    let px = (row * w as usize + col) * 4;
                    rgba[px..px + 4].copy_from_slice(&colour);
                    col += 1;
                }
            }
        }
        return Ok(rgba);
    }

    if subenc == 128 {
        // Plain RLE over CPIXEL.
        let mut filled = 0usize;
        while filled < pixel_count {
            let colour = read_cpixel(buf, pos)?;
            let run_len = read_zrle_run_length(buf, pos)?;
            let remaining = pixel_count - filled;
            if run_len > remaining {
                return Err(format!(
                    "zrle: plain RLE run {run_len} exceeds remaining pixels {remaining}"
                ));
            }
            for _ in 0..run_len {
                rgba[filled * 4..filled * 4 + 4].copy_from_slice(&colour);
                filled += 1;
            }
        }
        return Ok(rgba);
    }

    if (130..=255).contains(&subenc) {
        // Palette RLE. 2..=127 colours; indices of 127 means single pixel,
        // indices with the high bit set have a run length trailer.
        let palette_size = (subenc - 128) as usize;
        let mut palette = vec![[0u8; 4]; palette_size];
        for slot in palette.iter_mut() {
            *slot = read_cpixel(buf, pos)?;
        }
        let mut filled = 0usize;
        while filled < pixel_count {
            let idx_byte = *buf
                .get(*pos)
                .ok_or_else(|| "zrle: eof paletteRLE idx".to_string())?;
            *pos += 1;
            let pal_idx = (idx_byte & 0x7F) as usize;
            let colour = *palette.get(pal_idx).ok_or_else(|| {
                format!("zrle: palette RLE index {pal_idx} exceeds {palette_size}")
            })?;
            let run_len = if idx_byte & 0x80 != 0 {
                read_zrle_run_length(buf, pos)?
            } else {
                1
            };
            let remaining = pixel_count - filled;
            if run_len > remaining {
                return Err(format!(
                    "zrle: palette RLE run {run_len} exceeds remaining pixels {remaining}"
                ));
            }
            for _ in 0..run_len {
                rgba[filled * 4..filled * 4 + 4].copy_from_slice(&colour);
                filled += 1;
            }
        }
        return Ok(rgba);
    }

    Err(format!("zrle: unsupported subencoding {}", subenc))
}

/// Read a CPIXEL (3 bytes R, G, B). Alpha is always 0xFF.
fn read_cpixel(buf: &[u8], pos: &mut usize) -> Result<[u8; 4], String> {
    let s = *pos;
    let end = s
        .checked_add(3)
        .ok_or_else(|| "zrle: cpixel cursor overflow".to_string())?;
    if end > buf.len() {
        return Err("zrle: eof cpixel".to_string());
    }
    let out = [buf[s], buf[s + 1], buf[s + 2], 255];
    *pos += 3;
    Ok(out)
}

/// ZRLE run length: bytes of 255 accumulate, the first byte < 255 terminates.
/// The total run length is 1 + sum(bytes).
fn read_zrle_run_length(buf: &[u8], pos: &mut usize) -> Result<usize, String> {
    let mut total: usize = 1;
    loop {
        let b = *buf
            .get(*pos)
            .ok_or_else(|| "zrle: eof run length".to_string())?;
        *pos += 1;
        total = total
            .checked_add(usize::from(b))
            .ok_or_else(|| "zrle: run length overflow".to_string())?;
        if b != 255 {
            return Ok(total);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn raw_alpha_is_forced_opaque() {
        // 2x1 pixels, alpha bytes left at 0 by the server.
        let bytes: Vec<u8> = vec![10, 20, 30, 0, 40, 50, 60, 0];
        let mut cur = Cursor::new(bytes);
        let rect = read_raw(&mut cur, 0, 0, 2, 1).unwrap();
        let DecodedRect::Pixels { rgba, .. } = rect;
        assert_eq!(rgba, vec![10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn copyrect_emits_fb_window_as_pixels() {
        // 4x1 framebuffer, copying the last 2 pixels into the first 2 slots.
        let fb: Vec<u8> = vec![
            1, 1, 1, 255, // (0,0)
            2, 2, 2, 255, // (1,0)
            3, 3, 3, 255, // (2,0)
            4, 4, 4, 255, // (3,0)
        ];
        // src_x=2, src_y=0
        let mut payload = Cursor::new(vec![0u8, 2, 0, 0]);
        let rect = read_copyrect(&mut payload, 0, 0, 2, 1, &fb, 4, 1).unwrap();
        let DecodedRect::Pixels { rgba, .. } = rect;
        assert_eq!(rgba, vec![3, 3, 3, 255, 4, 4, 4, 255]);
    }

    #[test]
    fn copyrect_rejects_out_of_bounds_and_short_framebuffers() {
        let framebuffer = vec![0u8; 4 * 4 * 4];
        let mut out_of_bounds = Cursor::new(vec![0, 3, 0, 0]);
        assert!(
            read_copyrect(&mut out_of_bounds, 0, 0, 2, 1, &framebuffer, 4, 4)
                .unwrap_err()
                .contains("exceeds framebuffer")
        );

        let mut short = Cursor::new(vec![0, 0, 0, 0]);
        assert!(
            read_copyrect(&mut short, 0, 0, 1, 1, &[0; 3], 1, 1)
                .unwrap_err()
                .contains("expected 4")
        );
    }

    #[test]
    fn raw_and_zrle_truncation_fail_deterministically() {
        assert!(read_raw(&mut Cursor::new([0u8; 7]), 0, 0, 2, 1).is_err());

        let mut zrle = Vec::new();
        zrle.extend_from_slice(&8u32.to_be_bytes());
        zrle.extend_from_slice(&[1, 2, 3]);
        assert!(
            read_zrle(
                &mut Cursor::new(zrle),
                0,
                0,
                1,
                1,
                &mut ZrleDecoder::new(),
                &DecodeLimits::default(),
            )
            .unwrap_err()
            .contains("zrle: body")
        );
    }

    #[test]
    fn hextile_raw_subencoding_reads_exact_bytes() {
        let mut payload = vec![HEXTILE_RAW]; // subenc byte
        payload.extend_from_slice(&[255, 0, 0, 0, 0, 255, 0, 0]); // 2 pixels
        // 2x1 rect, exactly one tile
        let mut cur = Cursor::new(&payload);
        let mut st = HextileState::new();
        let out = read_hextile(&mut cur, 0, 0, 2, 1, &mut st).unwrap();
        assert_eq!(out.len(), 1);
        let DecodedRect::Pixels { rgba, .. } = &out[0];
        // Alpha forced to 255.
        assert_eq!(rgba, &vec![255, 0, 0, 255, 0, 255, 0, 255]);
        // No trailing bytes consumed from the cursor.
        assert_eq!(cur.position() as usize, payload.len());
    }

    #[test]
    fn hextile_bg_fg_persist_across_tiles() {
        // Two 16x1 tiles. First tile sets bg to red, no subrects. Second tile
        // has no bg flag and no subrects — should still paint red.
        let mut payload = Vec::new();
        // Tile 1: BG specified, red, no subrects.
        payload.push(HEXTILE_BG_SPECIFIED);
        payload.extend_from_slice(&[255, 0, 0, 0]);
        // Tile 2: no flags — reuse bg.
        payload.push(0);
        let mut cur = Cursor::new(&payload);
        let mut st = HextileState::new();
        let out = read_hextile(&mut cur, 0, 0, 32, 1, &mut st).unwrap();
        assert_eq!(out.len(), 2);
        for rect in &out {
            let DecodedRect::Pixels { rgba, .. } = rect;
            // Every pixel should be red.
            for p in rgba.chunks_exact(4) {
                assert_eq!(p, &[255, 0, 0, 255]);
            }
        }
    }

    #[test]
    fn hextile_rejects_unknown_mixed_raw_and_out_of_bounds_subrects() {
        for payload in [
            vec![0x20],
            vec![HEXTILE_RAW | HEXTILE_BG_SPECIFIED],
            vec![
                HEXTILE_BG_SPECIFIED | HEXTILE_FG_SPECIFIED | HEXTILE_ANY_SUBRECTS,
                0,
                0,
                0,
                0,
                1,
                1,
                1,
                1,
                1,
                0,
                0x10,
            ],
        ] {
            let error = read_hextile(
                &mut Cursor::new(payload),
                0,
                0,
                1,
                1,
                &mut HextileState::new(),
            )
            .unwrap_err();
            assert!(
                error.contains("subencoding flags")
                    || error.contains("incompatible flags")
                    || error.contains("exceeds tile"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn hextile_state_does_not_leak_across_rectangles_and_coordinates_are_checked() {
        let mut state = HextileState::new();
        read_hextile(
            &mut Cursor::new([HEXTILE_BG_SPECIFIED, 1, 2, 3, 0]),
            0,
            0,
            1,
            1,
            &mut state,
        )
        .unwrap();
        let error = read_hextile(&mut Cursor::new([0]), 0, 0, 1, 1, &mut state).unwrap_err();
        assert!(error.contains("must specify a background"));

        let error = read_hextile(&mut Cursor::new([]), u16::MAX, 0, 1, 1, &mut state).unwrap_err();
        assert!(error.contains("coordinate overflow"));
    }

    #[test]
    fn zrle_solid_tile_with_persistent_stream() {
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;

        // One 64x64 ZRLE tile, subenc=1 (solid), CPIXEL = [R,G,B] = [255,0,0].
        let uncompressed: Vec<u8> = vec![1u8, 255, 0, 0];
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&uncompressed).unwrap();
        let compressed = enc.finish().unwrap();

        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let out = read_zrle(&mut cur, 0, 0, 64, 64, &mut dec, &DecodeLimits::default()).unwrap();
        assert_eq!(out.len(), 1);
        let DecodedRect::Pixels { rgba, .. } = &out[0];
        assert_eq!(rgba.len(), 64 * 64 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn zrle_plain_rle_with_run_length_continuation() {
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;

        // subenc=128, colour = green (0,255,0), run length = 1 + 255 + 0 = 256
        // (covers every pixel of a 16x16 tile == 256).
        let mut uncompressed = vec![128u8, 0, 255, 0];
        uncompressed.push(255); // keep reading
        uncompressed.push(0); // terminator
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&uncompressed).unwrap();
        let compressed = enc.finish().unwrap();
        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let out = read_zrle(&mut cur, 0, 0, 16, 16, &mut dec, &DecodeLimits::default()).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out[0];
        assert_eq!(rgba.len(), 16 * 16 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[0, 255, 0, 255]);
        }
    }

    #[test]
    fn zrle_rejects_invalid_packed_palette_index() {
        let mut tile = vec![3];
        tile.extend_from_slice(&[
            1, 2, 3, // palette 0
            4, 5, 6, // palette 1
            7, 8, 9, // palette 2
        ]);
        tile.push(0b1100_0000); // 2bpp index 3, outside a three-colour palette.

        let error = zrle_read_tile(&tile, &mut 0, 1, 1).unwrap_err();
        assert!(error.contains("packed palette index 3 exceeds 3"));
    }

    #[test]
    fn zrle_rejects_runs_longer_than_the_remaining_tile() {
        let plain_rle = [128, 1, 2, 3, 1]; // run length 2 for a one-pixel tile.
        let error = zrle_read_tile(&plain_rle, &mut 0, 1, 1).unwrap_err();
        assert!(error.contains("plain RLE run 2 exceeds remaining pixels 1"));

        let palette_rle = [
            130, // two-colour palette RLE
            1, 2, 3, 4, 5, 6, // palette
            0x80, 1, // palette index 0, run length 2
        ];
        let error = zrle_read_tile(&palette_rle, &mut 0, 1, 1).unwrap_err();
        assert!(error.contains("palette RLE run 2 exceeds remaining pixels 1"));

        let error = read_zrle(
            &mut Cursor::new([]),
            u16::MAX,
            0,
            1,
            1,
            &mut ZrleDecoder::new(),
            &DecodeLimits::default(),
        )
        .unwrap_err();
        assert!(error.contains("coordinate overflow"));
    }

    #[test]
    fn zrle_preserves_zlib_state_across_rects() {
        // Two ZRLE rectangles share a single zlib stream. We build the stream
        // with two FlushCompress::Sync-delimited chunks so the inflater can
        // pause mid-stream and resume on the next rectangle.
        use flate2::{Compress, Compression, FlushCompress};

        fn emit(zlib: &mut Compress, input: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            let in_before = zlib.total_in();
            let target_in = in_before + input.len() as u64;
            let mut src_pos = 0usize;

            // Loop until all input has been consumed AND the Sync flush has
            // flushed everything to the output buffer.
            loop {
                let mut scratch = vec![0u8; 256];
                let prod_before = zlib.total_out();
                zlib.compress(&input[src_pos..], &mut scratch, FlushCompress::Sync)
                    .unwrap();
                let produced = (zlib.total_out() - prod_before) as usize;
                out.extend_from_slice(&scratch[..produced]);
                src_pos = (zlib.total_in() - in_before) as usize;

                if zlib.total_in() == target_in && produced < scratch.len() {
                    break;
                }
                if produced == 0 {
                    break;
                }
            }
            out
        }

        let mut zlib = Compress::new(Compression::default(), true);
        let rect1 = emit(&mut zlib, &[1u8, 255, 0, 0]); // solid red tile
        let rect2 = emit(&mut zlib, &[1u8, 0, 0, 255]); // solid blue tile

        let mut payload1 = Vec::new();
        payload1.extend_from_slice(&(rect1.len() as u32).to_be_bytes());
        payload1.extend_from_slice(&rect1);
        let mut cur1 = Cursor::new(&payload1);
        let mut dec = ZrleDecoder::new();
        let out1 = read_zrle(&mut cur1, 0, 0, 64, 64, &mut dec, &DecodeLimits::default()).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out1[0];
        assert_eq!(rgba[0..4], [255, 0, 0, 255]);

        let mut payload2 = Vec::new();
        payload2.extend_from_slice(&(rect2.len() as u32).to_be_bytes());
        payload2.extend_from_slice(&rect2);
        let mut cur2 = Cursor::new(&payload2);
        let out2 = read_zrle(&mut cur2, 0, 64, 64, 64, &mut dec, &DecodeLimits::default()).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out2[0];
        assert_eq!(rgba[0..4], [0, 0, 255, 255]);
    }

    #[test]
    fn zrle_decompresses_output_larger_than_initial_buffer() {
        // Regression for "zrle: eof cpixel": real ZRLE streams are a single
        // persistent zlib stream that spans the whole session, so the inflater
        // never sees a StreamEnd marker. It is NOT enough to stop decompressing
        // the moment the input slice is drained — the inflater can still have
        // bytes queued internally, and those need to be pulled out with one
        // more call (empty input) before we hand the buffer off to the tile
        // decoder. Otherwise the tile decoder runs off the end with `eof cpixel`.
        //
        // Build a rectangle whose tile stream is well over 64 KB and wrap it
        // in a Sync-flushed zlib frame (no StreamEnd), just like a real server
        // would transmit one rectangle within an ongoing session.
        use flate2::{Compress, Compression, FlushCompress};

        let rect_w: u16 = 256;
        let rect_h: u16 = 256;
        let tile_w: u16 = 64;
        let tile_h: u16 = 64;

        let mut uncompressed: Vec<u8> = Vec::new();
        let tiles_x = rect_w / tile_w;
        let tiles_y = rect_h / tile_h;
        for _ in 0..tiles_y {
            for _ in 0..tiles_x {
                uncompressed.push(0u8); // subenc = raw CPIXEL stream
                for _ in 0..(tile_w as usize * tile_h as usize) {
                    // Distinctive colour so we detect any byte-alignment bug.
                    uncompressed.extend_from_slice(&[0x12, 0x34, 0x56]);
                }
            }
        }
        assert!(uncompressed.len() > 64 * 1024);

        // Compress with Sync flush so the output is complete but the stream
        // is NOT terminated (zlib would otherwise emit StreamEnd, which hides
        // the bug via an early loop exit).
        let mut zlib = Compress::new(Compression::default(), true);
        let mut compressed: Vec<u8> = Vec::new();
        let mut src_pos = 0usize;
        loop {
            let mut scratch = vec![0u8; 32 * 1024];
            let in_before = zlib.total_in();
            let out_before = zlib.total_out();
            zlib.compress(&uncompressed[src_pos..], &mut scratch, FlushCompress::Sync)
                .unwrap();
            let consumed = (zlib.total_in() - in_before) as usize;
            let produced = (zlib.total_out() - out_before) as usize;
            compressed.extend_from_slice(&scratch[..produced]);
            src_pos += consumed;
            if src_pos >= uncompressed.len() && produced < scratch.len() {
                break;
            }
            if consumed == 0 && produced == 0 {
                break;
            }
        }

        let mut payload = Vec::new();
        payload.extend_from_slice(&(compressed.len() as u32).to_be_bytes());
        payload.extend_from_slice(&compressed);

        let mut cur = Cursor::new(&payload);
        let mut dec = ZrleDecoder::new();
        let out = read_zrle(
            &mut cur,
            0,
            0,
            rect_w,
            rect_h,
            &mut dec,
            &DecodeLimits::default(),
        )
        .unwrap();
        assert_eq!(out.len() as u16, tiles_x * tiles_y);
        for rect in &out {
            let DecodedRect::Pixels { rgba, .. } = rect;
            assert_eq!(rgba.len(), tile_w as usize * tile_h as usize * 4);
            for p in rgba.chunks_exact(4) {
                assert_eq!(p, &[0x12, 0x34, 0x56, 255]);
            }
        }
    }
}
