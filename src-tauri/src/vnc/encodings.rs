use flate2::read::ZlibDecoder;
use std::io::Read;

pub enum DecodedRect {
    Pixels {
        x: u16,
        y: u16,
        w: u16,
        h: u16,
        rgba: Vec<u8>,
    },
    Copy {
        src_x: u16,
        src_y: u16,
    },
}

const _TIGHT_FILL: u8 = 0x80;
const _TIGHT_JPEG: u8 = 0x90;
const _TIGHT_PNG: u8 = 0xA0;

/// Read a big-endian u16 from bytes at offset.
fn read_u16(data: &[u8], pos: &mut usize) -> u16 {
    let v = u16::from_be_bytes([data[*pos], data[*pos + 1]]);
    *pos += 2;
    v
}

/// Raw encoding (0): w*h*bpp bytes of raw pixel data.
pub fn decode_raw(data: &[u8], x: u16, y: u16, w: u16, h: u16) -> DecodedRect {
    let pixel_count = w as usize * h as usize;
    let byte_count = pixel_count * 4;
    let mut rgba = data[..byte_count].to_vec();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel[3] = 255;
    }
    DecodedRect::Pixels { x, y, w, h, rgba }
}

/// CopyRect encoding (1): 2 bytes src_x, 2 bytes src_y.
pub fn decode_copyrect(data: &[u8]) -> (u16, u16) {
    let mut pos = 0;
    (read_u16(data, &mut pos), read_u16(data, &mut pos))
}

/// Hextile encoding (5): 16x16 tiles with subencoding.
pub fn decode_hextile(
    data: &[u8],
    rect_x: u16,
    rect_y: u16,
    rect_w: u16,
    rect_h: u16,
    fb: &[u8],
    fb_w: u16,
) -> Result<Vec<DecodedRect>, String> {
    let mut results: Vec<DecodedRect> = Vec::new();
    let mut pos: usize = 0;
    let mut tile_y = rect_y;

    while tile_y < rect_y + rect_h {
        let tile_h = 16u16.min(rect_y + rect_h - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_x + rect_w {
            let tile_w = 16u16.min(rect_x + rect_w - tile_x);
            let subenc = data[pos];
            pos += 1;
            let pixel_count = tile_w as usize * tile_h as usize;
            let byte_count = pixel_count * 4;

            if subenc & 0x01 != 0 {
                // Raw tile
                let pixels = data[pos..pos + byte_count].to_vec();
                pos += byte_count;
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba: pixels,
                });
            } else {
                let has_bg = subenc & 0x02 != 0;
                let mut bg: [u8; 4] = [0, 0, 0, 0];
                if has_bg {
                    bg.copy_from_slice(&data[pos..pos + 4]);
                    pos += 4;
                }
                // Initialize tile with background color
                let mut tile_pixels = vec![0u8; byte_count];
                if has_bg {
                    for i in 0..pixel_count {
                        tile_pixels[i * 4..(i + 1) * 4].copy_from_slice(&bg);
                    }
                }
                // Copy from framebuffer when no explicit background
                if !has_bg {
                    for py in 0..tile_h as usize {
                        let fb_row = (tile_y as usize + py) * fb_w as usize + tile_x as usize;
                        let t_row = py * tile_w as usize;
                        let src = fb_row * 4;
                        let dst = t_row * 4;
                        let len = tile_w as usize * 4;
                        tile_pixels[dst..dst + len].copy_from_slice(&fb[src..src + len]);
                    }
                }

                if subenc & 0x04 != 0 {
                    // Has foreground subrects
                    let fg: [u8; 4] = [data[pos], data[pos + 1], data[pos + 2], data[pos + 3]];
                    pos += 4;
                    let n_subrects = data[pos] as usize;
                    pos += 1;
                    for _ in 0..n_subrects {
                        let sr_rgba: [u8; 4] =
                            [data[pos], data[pos + 1], data[pos + 2], data[pos + 3]];
                        pos += 4;
                        let sr_xy = data[pos];
                        pos += 1;
                        let sr_wh = data[pos];
                        pos += 1;
                        let sr_x = (sr_xy >> 4) as usize;
                        let sr_y = (sr_xy & 0x0F) as usize;
                        let sr_w = ((sr_wh >> 4) + 1) as usize;
                        let sr_h = ((sr_wh & 0x0F) + 1) as usize;
                        if sr_rgba != fg {
                            for r in sr_y..sr_y + sr_h {
                                for c in sr_x..sr_x + sr_w {
                                    let idx = (r * tile_w as usize + c) * 4;
                                    tile_pixels[idx..idx + 4].copy_from_slice(&sr_rgba);
                                }
                            }
                        } else {
                            for r in sr_y..sr_y + sr_h {
                                for c in sr_x..sr_x + sr_w {
                                    let idx = (r * tile_w as usize + c) * 4;
                                    tile_pixels[idx..idx + 4].copy_from_slice(&fg);
                                }
                            }
                        }
                    }
                }
                if subenc & 0x08 != 0 {
                    // Subrects colored (each subrect has its own color)
                    let n_subrects = data[pos] as usize;
                    pos += 1;
                    for _ in 0..n_subrects {
                        let sr_rgba: [u8; 4] =
                            [data[pos], data[pos + 1], data[pos + 2], data[pos + 3]];
                        pos += 4;
                        let sr_xy = data[pos];
                        pos += 1;
                        let sr_wh = data[pos];
                        pos += 1;
                        let sr_x = (sr_xy >> 4) as usize;
                        let sr_y = (sr_xy & 0x0F) as usize;
                        let sr_w = ((sr_wh >> 4) + 1) as usize;
                        let sr_h = ((sr_wh & 0x0F) + 1) as usize;
                        for r in sr_y..sr_y + sr_h {
                            for c in sr_x..sr_x + sr_w {
                                let idx = (r * tile_w as usize + c) * 4;
                                tile_pixels[idx..idx + 4].copy_from_slice(&sr_rgba);
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
            }
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }
    Ok(results)
}

/// Tight encoding (7): zlib-compressed with multiple compression types.
pub fn decode_tight(
    data: &[u8],
    rect_x: u16,
    rect_y: u16,
    rect_w: u16,
    rect_h: u16,
) -> Result<Vec<DecodedRect>, String> {
    let mut results: Vec<DecodedRect> = Vec::new();
    let mut pos: usize = 0;
    let fb_w = rect_w;
    let fb_h = rect_h;

    // Allocate a temporary framebuffer for this rectangle
    let mut fb = vec![0u8; rect_w as usize * rect_h as usize * 4];

    let mut row = 0u16;
    while row < fb_h {
        if pos >= data.len() {
            break;
        }
        let ctrl = data[pos];
        pos += 1;

        let comp_type = ctrl >> 4;
        let row_size = (ctrl & 0x0F) as u16 + 1;

        match comp_type {
            0x08 => {
                // Fill - single color repeated
                let pixel = [data[pos], data[pos + 1], data[pos + 2], data[pos + 3]];
                pos += 4;
                let mut rgba = vec![0u8; (fb_w as usize * row_size as usize) * 4];
                for i in 0..fb_w as usize * row_size as usize {
                    rgba[i * 4..(i + 1) * 4].copy_from_slice(&pixel);
                }
                // Write into temp framebuffer
                let dst_start = row as usize * fb_w as usize * 4;
                fb[dst_start..dst_start + rgba.len()].copy_from_slice(&rgba);

                results.push(DecodedRect::Pixels {
                    x: rect_x,
                    y: rect_y + row,
                    w: fb_w,
                    h: row_size,
                    rgba,
                });
            }
            0x09 => {
                // JPEG - not supported, skip
                let jpeg_len = read_compact_len(data, &mut pos) as usize;
                pos += jpeg_len;
                // Fill with grey as fallback
                let pixel_count = fb_w as usize * row_size as usize;
                let rgba = vec![128u8; pixel_count * 4];
                let dst_start = row as usize * fb_w as usize * 4;
                fb[dst_start..dst_start + rgba.len()].copy_from_slice(&rgba);
                results.push(DecodedRect::Pixels {
                    x: rect_x,
                    y: rect_y + row,
                    w: fb_w,
                    h: row_size,
                    rgba,
                });
            }
            _ => {
                // Basic compression (0x00-0x07) with optional filter
                let filter_id = comp_type;
                let data_size = read_compact_len(data, &mut pos) as usize;
                let row_bytes = fb_w as usize * row_size as usize * 4;

                let mut decompressed = vec![0u8; row_bytes];
                {
                    // Tight basic compression uses a new zlib stream per row
                    let all_compressed = &data[pos..pos + data_size];
                    let mut new_dec = ZlibDecoder::new(all_compressed);
                    new_dec
                        .read_exact(&mut decompressed)
                        .map_err(|e| format!("tight zlib decompress failed: {}", e))?;
                }
                pos += data_size;

                // Apply filter
                if filter_id == 1 {
                    // Palette filter: each pixel is an index into a color palette
                    let palette_count = decompressed[0] as usize + 1;
                    let mut palette = vec![[0u8; 4]; palette_count];
                    for i in 0..palette_count {
                        palette[i][0] = decompressed[1 + i * 3];
                        palette[i][1] = decompressed[1 + i * 3 + 1];
                        palette[i][2] = decompressed[1 + i * 3 + 2];
                        palette[i][3] = 255;
                    }
                    let data_offset = 1 + palette_count * 3;
                    let pixel_count = fb_w as usize * row_size as usize;
                    let mut rgba = vec![0u8; pixel_count * 4];
                    for i in 0..pixel_count {
                        let idx = decompressed[data_offset + i] as usize;
                        if idx < palette_count {
                            rgba[i * 4..(i + 1) * 4].copy_from_slice(&palette[idx]);
                        }
                    }
                    let dst_start = row as usize * fb_w as usize * 4;
                    fb[dst_start..dst_start + rgba.len()].copy_from_slice(&rgba);
                    results.push(DecodedRect::Pixels {
                        x: rect_x,
                        y: rect_y + row,
                        w: fb_w,
                        h: row_size,
                        rgba,
                    });
                } else if filter_id == 2 {
                    // Gradient filter
                    let mut rgba = vec![0u8; row_bytes];
                    for y in 0..row_size as usize {
                        for x in 0..fb_w as usize {
                            let idx = (y * fb_w as usize + x) * 4;
                            if data_size > 0 && idx + 3 < decompressed.len() {
                                rgba[idx] = decompressed[idx];
                                rgba[idx + 1] = decompressed[idx + 1];
                                rgba[idx + 2] = decompressed[idx + 2];
                                rgba[idx + 3] = 255;
                            }
                        }
                    }
                    let dst_start = row as usize * fb_w as usize * 4;
                    fb[dst_start..dst_start + rgba.len()].copy_from_slice(&rgba);
                    results.push(DecodedRect::Pixels {
                        x: rect_x,
                        y: rect_y + row,
                        w: fb_w,
                        h: row_size,
                        rgba,
                    });
                } else {
                    // No filter (filter_id 0): raw BGRA → RGBA
                    let mut rgba = vec![0u8; row_bytes];
                    for i in 0..fb_w as usize * row_size as usize {
                        let src = i * 3; // Tight basic uses 3 bytes per pixel (BGR)
                        if src + 2 < decompressed.len() {
                            // BGR → RGBA
                            rgba[i * 4] = decompressed[src + 2]; // R
                            rgba[i * 4 + 1] = decompressed[src + 1]; // G
                            rgba[i * 4 + 2] = decompressed[src]; // B
                            rgba[i * 4 + 3] = 255; // A
                        }
                    }
                    let dst_start = row as usize * fb_w as usize * 4;
                    fb[dst_start..dst_start + rgba.len()].copy_from_slice(&rgba);
                    results.push(DecodedRect::Pixels {
                        x: rect_x,
                        y: rect_y + row,
                        w: fb_w,
                        h: row_size,
                        rgba,
                    });
                }
            }
        }
        row += row_size;
    }

    Ok(results)
}

/// ZRLE encoding (16): zlib-compressed tile-based encoding.
pub fn decode_zrle(
    data: &[u8],
    rect_x: u16,
    rect_y: u16,
    rect_w: u16,
    rect_h: u16,
) -> Result<Vec<DecodedRect>, String> {
    let zipped_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let compressed = &data[4..4 + zipped_len];
    let mut dec = ZlibDecoder::new(compressed);
    let mut decompressed = Vec::new();
    dec.read_to_end(&mut decompressed)
        .map_err(|e| format!("zrle zlib: {}", e))?;

    let mut results: Vec<DecodedRect> = Vec::new();
    let mut pos: usize = 0;

    let mut tile_y = rect_y;
    while tile_y < rect_y + rect_h {
        let tile_h = 64u16.min(rect_y + rect_h - tile_y);
        let mut tile_x = rect_x;
        while tile_x < rect_x + rect_w {
            let tile_w = 64u16.min(rect_x + rect_w - tile_x);
            let subenc = decompressed[pos];
            pos += 1;

            if subenc == 0 {
                // Raw pixels (RGBA)
                let count = tile_w as usize * tile_h as usize * 4;
                let rgba = decompressed[pos..pos + count].to_vec();
                pos += count;
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba,
                });
            } else if subenc == 1 {
                // Solid tile (single color)
                let rgba: Vec<u8> = vec![
                    decompressed[pos],
                    decompressed[pos + 1],
                    decompressed[pos + 2],
                    decompressed[pos + 3],
                ];
                pos += 4;
                let mut pixels = vec![0u8; tile_w as usize * tile_h as usize * 4];
                for i in 0..tile_w as usize * tile_h as usize {
                    pixels[i * 4..(i + 1) * 4].copy_from_slice(&rgba);
                }
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba: pixels,
                });
            } else if subenc >= 2 && subenc <= 16 {
                // Packed palette (subenc-1 colors)
                let palette_size = subenc as usize;
                let mut palette = vec![[0u8; 4]; palette_size];
                for i in 0..palette_size {
                    palette[i][0] = decompressed[pos + i * 4];
                    palette[i][1] = decompressed[pos + i * 4 + 1];
                    palette[i][2] = decompressed[pos + i * 4 + 2];
                    palette[i][3] = decompressed[pos + i * 4 + 3];
                }
                pos += palette_size * 4;
                let pixel_count = tile_w as usize * tile_h as usize;
                let bits_per_pixel = if palette_size <= 2 {
                    1
                } else if palette_size <= 4 {
                    2
                } else {
                    4
                };
                let mut rgba = vec![0u8; pixel_count * 4];
                for pi in 0..pixel_count {
                    let byte_idx = pos + (pi * bits_per_pixel) / 8;
                    let bit_offset = (pi * bits_per_pixel) % 8;
                    let mask = (1u8 << bits_per_pixel) - 1;
                    let palette_idx = ((decompressed[byte_idx] >> bit_offset) & mask) as usize;
                    if palette_idx < palette_size {
                        rgba[pi * 4..(pi + 1) * 4].copy_from_slice(&palette[palette_idx]);
                    }
                }
                pos += (pixel_count * bits_per_pixel + 7) / 8;
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba,
                });
            } else if subenc == 128 {
                // Plain RLE
                let pixel_count = tile_w as usize * tile_h as usize;
                let mut rgba = vec![0u8; pixel_count * 4];
                let mut pix_idx: usize = 0;
                while pix_idx < pixel_count {
                    let color = [
                        decompressed[pos],
                        decompressed[pos + 1],
                        decompressed[pos + 2],
                        decompressed[pos + 3],
                    ];
                    pos += 4;
                    let mut run_len: usize = 1;
                    loop {
                        let b = decompressed[pos];
                        pos += 1;
                        run_len += b as usize;
                        if b != 255 {
                            break;
                        }
                    }
                    for _ in 0..run_len {
                        if pix_idx < pixel_count {
                            rgba[pix_idx * 4..(pix_idx + 1) * 4].copy_from_slice(&color);
                            pix_idx += 1;
                        }
                    }
                }
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba,
                });
            } else if subenc >= 130 {
                // Palette RLE
                let palette_size = (subenc - 128) as usize;
                let mut palette = vec![[0u8; 4]; palette_size];
                for i in 0..palette_size {
                    palette[i][0] = decompressed[pos + i * 4];
                    palette[i][1] = decompressed[pos + i * 4 + 1];
                    palette[i][2] = decompressed[pos + i * 4 + 2];
                    palette[i][3] = decompressed[pos + i * 4 + 3];
                }
                pos += palette_size * 4;
                let pixel_count = tile_w as usize * tile_h as usize;
                let mut rgba = vec![0u8; pixel_count * 4];
                let mut pix_idx: usize = 0;
                while pix_idx < pixel_count {
                    let pal_idx = decompressed[pos] as usize & 0x7F;
                    pos += 1;
                    let mut run_len: usize = 1;
                    if decompressed[pos - 1] & 0x80 != 0 {
                        loop {
                            let b = decompressed[pos];
                            pos += 1;
                            run_len += b as usize;
                            if b != 255 {
                                break;
                            }
                        }
                    }
                    if pal_idx < palette_size {
                        for _ in 0..run_len {
                            if pix_idx < pixel_count {
                                rgba[pix_idx * 4..(pix_idx + 1) * 4]
                                    .copy_from_slice(&palette[pal_idx]);
                                pix_idx += 1;
                            }
                        }
                    }
                }
                results.push(DecodedRect::Pixels {
                    x: tile_x,
                    y: tile_y,
                    w: tile_w,
                    h: tile_h,
                    rgba,
                });
            }
            tile_x += tile_w;
        }
        tile_y += tile_h;
    }
    Ok(results)
}

/// Read a "compact length" used by Tight encoding.
/// Lengths 0-127 are stored in 1 byte, 128-16383 in 2 bytes, larger in 3 bytes.
fn read_compact_len(data: &[u8], pos: &mut usize) -> u32 {
    let b1 = data[*pos];
    *pos += 1;
    if b1 <= 0x7F {
        b1 as u32
    } else if b1 <= 0xBF {
        let b2 = data[*pos];
        *pos += 1;
        (((b1 & 0x3F) as u32) << 8) | (b2 as u32)
    } else {
        let b2 = data[*pos];
        *pos += 1;
        let b3 = data[*pos];
        *pos += 1;
        (((b1 & 0x3F) as u32) << 16) | ((b2 as u32) << 8) | (b3 as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_decoding() {
        // 2x2 RGBA pixels: red, green, blue, white
        let data: Vec<u8> = vec![
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
            0, 0, 255, 255, // blue
            255, 255, 255, 255, // white
        ];
        let result = decode_raw(&data, 0, 0, 2, 2);
        match result {
            DecodedRect::Pixels { x, y, w, h, rgba } => {
                assert_eq!((x, y, w, h), (0, 0, 2, 2));
                assert_eq!(rgba.len(), 16);
                assert_eq!(rgba[0..4], [255, 0, 0, 255]);
                assert_eq!(rgba[12..16], [255, 255, 255, 255]);
            }
            _ => panic!("expected Pixels"),
        }
    }

    #[test]
    fn test_copyrect_decoding() {
        let data: Vec<u8> = vec![0x00, 0x0A, 0x00, 0x14]; // src_x=10, src_y=20
        let (sx, sy) = decode_copyrect(&data);
        assert_eq!(sx, 10);
        assert_eq!(sy, 20);
    }

    #[test]
    fn test_hextile_raw_subenc() {
        // Single 2x2 tile with raw subencoding (0x01)
        let data: Vec<u8> = {
            let mut v = vec![0x01u8]; // raw subencoding
                                      // 4 pixels RGBA
            v.extend_from_slice(&[255, 0, 0, 255]);
            v.extend_from_slice(&[0, 255, 0, 255]);
            v.extend_from_slice(&[0, 0, 255, 255]);
            v.extend_from_slice(&[255, 255, 255, 255]);
            v
        };
        let fb = vec![0u8; 16];
        let results = decode_hextile(&data, 0, 0, 2, 2, &fb, 2).unwrap();
        assert_eq!(results.len(), 1);
        match &results[0] {
            DecodedRect::Pixels { x, y, w, h, rgba } => {
                assert_eq!((*x, *y, *w, *h), (0, 0, 2, 2));
                assert_eq!(rgba[0..4], [255, 0, 0, 255]);
            }
            _ => panic!("expected Pixels"),
        }
    }

    #[test]
    fn test_tight_fill() {
        // Fill: control byte 0x80 (fill, 1 row: 0+1=1), 4 bytes color
        let data: Vec<u8> = vec![0x80, 255, 0, 0, 255]; // red fill, 1 row
        let results = decode_tight(&data, 0, 0, 2, 1).unwrap();
        assert_eq!(results.len(), 1);
        match &results[0] {
            DecodedRect::Pixels { w, h, rgba, .. } => {
                assert_eq!((*w, *h), (2, 1));
                // Both pixels should be red
                assert_eq!(rgba[0..4], [255, 0, 0, 255]);
                assert_eq!(rgba[4..8], [255, 0, 0, 255]);
            }
            _ => panic!("expected Pixels"),
        }
    }

    #[test]
    fn test_read_compact_len() {
        // 1-byte
        assert_eq!(read_compact_len(&[0x42], &mut 0), 0x42);
        // 2-byte
        assert_eq!(read_compact_len(&[0x80, 0x42], &mut 0), 0x42);
        // 3-byte
        assert_eq!(read_compact_len(&[0xC0, 0x00, 0x42], &mut 0), 0x42);
    }

    #[test]
    fn test_zrle_solid_tile() {
        // zlib-compressed data: subenc=1 (solid), color=red
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let raw = vec![1u8, 255, 0, 0, 255]; // solid, red
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&raw).unwrap();
        let compressed = enc.finish().unwrap();

        let zipped_len = compressed.len() as u32;
        let mut data = vec![0u8; 4 + compressed.len()];
        data[0..4].copy_from_slice(&zipped_len.to_be_bytes());
        data[4..].copy_from_slice(&compressed);

        let results = decode_zrle(&data, 0, 0, 64, 64).unwrap();
        assert_eq!(results.len(), 1);
        match &results[0] {
            DecodedRect::Pixels { rgba, .. } => {
                assert_eq!(rgba[0..4], [255, 0, 0, 255]);
            }
            _ => panic!("expected Pixels"),
        }
    }
}
