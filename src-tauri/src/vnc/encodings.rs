use flate2::{Decompress, FlushDecompress};
use std::io::Read;

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
pub fn read_raw<R: Read>(
    r: &mut R,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
) -> Result<DecodedRect, String> {
    let pixel_count = w as usize * h as usize;
    let mut rgba = vec![0u8; pixel_count * 4];
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

    let fb_w = fb_w as usize;
    let fb_h = fb_h as usize;
    let w_us = w as usize;
    let h_us = h as usize;

    // Defensive bounds: a misbehaving server could send coordinates that walk
    // off the framebuffer. Clip rather than panic.
    let mut rgba = vec![0u8; w_us * h_us * 4];
    if fb_w == 0 || fb_h == 0 {
        return Ok(DecodedRect::Pixels { x: dst_x, y: dst_y, w, h, rgba });
    }
    for row in 0..h_us {
        let sy = src_y as usize + row;
        if sy >= fb_h {
            break;
        }
        let src_start = (sy * fb_w + src_x as usize) * 4;
        // Row length constrained by both the requested width and the fb edge.
        let avail_cols = fb_w.saturating_sub(src_x as usize).min(w_us);
        let src_end = src_start + avail_cols * 4;
        let dst_start = row * w_us * 4;
        let dst_end = dst_start + avail_cols * 4;
        if src_end <= fb.len() && dst_end <= rgba.len() {
            rgba[dst_start..dst_end].copy_from_slice(&fb[src_start..src_end]);
        }
    }
    Ok(DecodedRect::Pixels { x: dst_x, y: dst_y, w, h, rgba })
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
}

impl HextileState {
    pub fn new() -> Self {
        Self::default()
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
    let mut results: Vec<DecodedRect> = Vec::new();

    let mut tile_y = rect_y;
    while tile_y < rect_y + rect_h {
        let tile_h = 16u16.min(rect_y + rect_h - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_x + rect_w {
            let tile_w = 16u16.min(rect_x + rect_w - tile_x);
            let subenc = read_u8(r).map_err(|e| format!("hextile: subenc: {}", e))?;
            let pixel_count = tile_w as usize * tile_h as usize;
            let byte_count = pixel_count * 4;

            if subenc & HEXTILE_RAW != 0 {
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
                tile_x += tile_w;
                continue;
            }

            if subenc & HEXTILE_BG_SPECIFIED != 0 {
                r.read_exact(&mut state.bg)
                    .map_err(|e| format!("hextile: bg: {}", e))?;
                state.bg[3] = 255;
            }
            if subenc & HEXTILE_FG_SPECIFIED != 0 {
                r.read_exact(&mut state.fg)
                    .map_err(|e| format!("hextile: fg: {}", e))?;
                state.fg[3] = 255;
            }

            // Fill the tile with the background colour.
            let mut tile_pixels = vec![0u8; byte_count];
            for i in 0..pixel_count {
                tile_pixels[i * 4..(i + 1) * 4].copy_from_slice(&state.bg);
            }

            if subenc & HEXTILE_ANY_SUBRECTS != 0 {
                let n_subrects = read_u8(r).map_err(|e| format!("hextile: n_subrects: {}", e))?
                    as usize;
                let coloured = subenc & HEXTILE_SUBRECTS_COLOURED != 0;
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
                    for r2 in sy..(sy + sh).min(tile_h as usize) {
                        for c in sx..(sx + sw).min(tile_w as usize) {
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
) -> Result<Vec<DecodedRect>, String> {
    let zlib_len = read_u32_be(r).map_err(|e| format!("zrle: len: {}", e))? as usize;
    let mut compressed = vec![0u8; zlib_len];
    r.read_exact(&mut compressed)
        .map_err(|e| format!("zrle: body: {}", e))?;

    // Feed the newly-arrived bytes into the persistent inflater, growing the
    // buffer as we go. The inflater's internal state is preserved across
    // rectangles — RFB keeps a single zlib stream per session.
    let mut src_consumed = 0usize;
    loop {
        if src_consumed >= compressed.len() {
            break;
        }
        let current_len = dec.buf.len();
        dec.buf.resize(current_len + 64 * 1024, 0);

        let tin_before = dec.inflater.total_in();
        let tout_before = dec.inflater.total_out();

        let status = dec
            .inflater
            .decompress(
                &compressed[src_consumed..],
                &mut dec.buf[current_len..],
                FlushDecompress::None,
            )
            .map_err(|e| format!("zrle: inflate: {}", e))?;

        let consumed_in = (dec.inflater.total_in() - tin_before) as usize;
        let produced_out = (dec.inflater.total_out() - tout_before) as usize;

        dec.buf.truncate(current_len + produced_out);
        src_consumed += consumed_in;

        if consumed_in == 0 && produced_out == 0 {
            break;
        }
        if matches!(status, flate2::Status::StreamEnd) {
            break;
        }
    }

    // Now decode tiles from `dec.buf`, advancing `dec.pos`.
    let mut results: Vec<DecodedRect> = Vec::new();
    let mut tile_y = rect_y;
    while tile_y < rect_y + rect_h {
        let tile_h = 64u16.min(rect_y + rect_h - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_x + rect_w {
            let tile_w = 64u16.min(rect_x + rect_w - tile_x);
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
    let pixel_count = w as usize * h as usize;
    let mut rgba = vec![0u8; pixel_count * 4];

    let subenc = *buf.get(*pos).ok_or_else(|| "zrle: eof subenc".to_string())?;
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
                let byte = *buf.get(*pos).ok_or_else(|| "zrle: eof packed".to_string())?;
                *pos += 1;
                let pixels_in_byte = 8 / bpp;
                for slot in 0..pixels_in_byte {
                    if col >= w as usize {
                        break;
                    }
                    let shift = 8 - (slot + 1) * bpp;
                    let mask = (1u8 << bpp) - 1;
                    let idx = ((byte >> shift) & mask) as usize;
                    let colour = if idx < palette_size {
                        palette[idx]
                    } else {
                        [0, 0, 0, 255]
                    };
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
            let take = run_len.min(pixel_count - filled);
            for _ in 0..take {
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
            let colour = if pal_idx < palette_size {
                palette[pal_idx]
            } else {
                [0, 0, 0, 255]
            };
            let run_len = if idx_byte & 0x80 != 0 {
                read_zrle_run_length(buf, pos)?
            } else {
                1
            };
            let take = run_len.min(pixel_count - filled);
            for _ in 0..take {
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
    if s + 3 > buf.len() {
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
        total += b as usize;
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
    fn zrle_solid_tile_with_persistent_stream() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
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
        let out = read_zrle(&mut cur, 0, 0, 64, 64, &mut dec).unwrap();
        assert_eq!(out.len(), 1);
        let DecodedRect::Pixels { rgba, .. } = &out[0];
        assert_eq!(rgba.len(), 64 * 64 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[255, 0, 0, 255]);
        }
    }

    #[test]
    fn zrle_plain_rle_with_run_length_continuation() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
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
        let out = read_zrle(&mut cur, 0, 0, 16, 16, &mut dec).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out[0];
        assert_eq!(rgba.len(), 16 * 16 * 4);
        for p in rgba.chunks_exact(4) {
            assert_eq!(p, &[0, 255, 0, 255]);
        }
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
        let out1 = read_zrle(&mut cur1, 0, 0, 64, 64, &mut dec).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out1[0];
        assert_eq!(rgba[0..4], [255, 0, 0, 255]);

        let mut payload2 = Vec::new();
        payload2.extend_from_slice(&(rect2.len() as u32).to_be_bytes());
        payload2.extend_from_slice(&rect2);
        let mut cur2 = Cursor::new(&payload2);
        let out2 = read_zrle(&mut cur2, 0, 64, 64, 64, &mut dec).unwrap();
        let DecodedRect::Pixels { rgba, .. } = &out2[0];
        assert_eq!(rgba[0..4], [0, 0, 255, 255]);
    }
}
