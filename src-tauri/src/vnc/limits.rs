use serde::{Deserialize, Serialize};

pub const HARD_MAX_FRAMEBUFFER_DIMENSION: u16 = 16_384;
pub const HARD_MAX_FRAMEBUFFER_BYTES: usize = 256 * 1024 * 1024;
pub const HARD_MAX_RECTANGLES: u16 = 4_096;
pub const HARD_MAX_COMPRESSED_RECT_BYTES: usize = 64 * 1024 * 1024;
pub const HARD_MAX_DECOMPRESSED_RECT_BYTES: usize = 128 * 1024 * 1024;
pub const HARD_MAX_TEXT_BYTES: usize = 64 * 1024;
pub const HARD_MAX_CLIPBOARD_FORMAT_BYTES: usize = 16 * 1024 * 1024;
pub const HARD_MAX_CLIPBOARD_TOTAL_BYTES: usize = 32 * 1024 * 1024;
pub const HARD_MAX_RELAY_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
pub const HARD_MAX_FRAME_BATCH_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeLimits {
    pub max_framebuffer_dimension: u16,
    pub max_framebuffer_bytes: usize,
    pub max_rectangles: u16,
    pub max_compressed_rect_bytes: usize,
    pub max_decompressed_rect_bytes: usize,
    pub max_text_bytes: usize,
    pub max_clipboard_format_bytes: usize,
    pub max_clipboard_total_bytes: usize,
    pub max_relay_message_bytes: usize,
    pub max_frame_batch_bytes: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_framebuffer_dimension: HARD_MAX_FRAMEBUFFER_DIMENSION,
            max_framebuffer_bytes: HARD_MAX_FRAMEBUFFER_BYTES,
            max_rectangles: HARD_MAX_RECTANGLES,
            max_compressed_rect_bytes: HARD_MAX_COMPRESSED_RECT_BYTES,
            max_decompressed_rect_bytes: HARD_MAX_DECOMPRESSED_RECT_BYTES,
            max_text_bytes: HARD_MAX_TEXT_BYTES,
            max_clipboard_format_bytes: HARD_MAX_CLIPBOARD_FORMAT_BYTES,
            max_clipboard_total_bytes: HARD_MAX_CLIPBOARD_TOTAL_BYTES,
            max_relay_message_bytes: HARD_MAX_RELAY_MESSAGE_BYTES,
            max_frame_batch_bytes: HARD_MAX_FRAME_BATCH_BYTES,
        }
    }
}

impl DecodeLimits {
    pub fn framebuffer_bytes(&self, width: u16, height: u16) -> Result<usize, String> {
        if width == 0 || height == 0 {
            return Err("framebuffer dimensions must be non-zero".to_string());
        }
        if width > self.max_framebuffer_dimension || height > self.max_framebuffer_dimension {
            return Err(format!(
                "framebuffer {}x{} exceeds {}px dimension limit",
                width, height, self.max_framebuffer_dimension
            ));
        }
        let pixels = usize::from(width)
            .checked_mul(usize::from(height))
            .ok_or_else(|| "framebuffer pixel count overflow".to_string())?;
        let bytes = pixels
            .checked_mul(4)
            .ok_or_else(|| "framebuffer byte size overflow".to_string())?;
        if bytes > self.max_framebuffer_bytes {
            return Err(format!(
                "framebuffer requires {} bytes, limit is {}",
                bytes, self.max_framebuffer_bytes
            ));
        }
        Ok(bytes)
    }

    pub fn rectangle_bytes(&self, width: u16, height: u16) -> Result<usize, String> {
        let bytes = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| "rectangle byte size overflow".to_string())?;
        if bytes > self.max_decompressed_rect_bytes {
            return Err(format!(
                "rectangle requires {} bytes, limit is {}",
                bytes, self.max_decompressed_rect_bytes
            ));
        }
        Ok(bytes)
    }

    pub fn validate_rectangle(
        &self,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        framebuffer_width: u16,
        framebuffer_height: u16,
    ) -> Result<usize, String> {
        if width == 0 || height == 0 {
            return Err("rectangle dimensions must be non-zero".to_string());
        }
        let right = x
            .checked_add(width)
            .ok_or_else(|| "rectangle x coordinate overflow".to_string())?;
        let bottom = y
            .checked_add(height)
            .ok_or_else(|| "rectangle y coordinate overflow".to_string())?;
        if right > framebuffer_width || bottom > framebuffer_height {
            return Err(format!(
                "rectangle ({x},{y}) {width}x{height} exceeds framebuffer {framebuffer_width}x{framebuffer_height}"
            ));
        }
        self.rectangle_bytes(width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_framebuffer_limits_reject_zero_overflow_and_excessive_size() {
        let limits = DecodeLimits::default();
        assert!(limits.framebuffer_bytes(0, 1).is_err());
        assert!(limits.framebuffer_bytes(16_384, 16_384).is_err());
        assert_eq!(limits.framebuffer_bytes(1_920, 1_080).unwrap(), 8_294_400);
    }

    #[test]
    fn rectangle_must_fit_framebuffer() {
        let limits = DecodeLimits::default();
        assert!(limits.validate_rectangle(90, 90, 20, 20, 100, 100).is_err());
        assert_eq!(
            limits.validate_rectangle(10, 10, 20, 20, 100, 100).unwrap(),
            1_600
        );
    }
}
