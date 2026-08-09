use std::fmt;

/// Hard resource ceilings for all data controlled by an RFB peer or the
/// loopback relay. These values are intentionally not user-configurable below
/// the hard maximums: a malformed server must not be able to turn a preference
/// into an allocation denial-of-service.
#[derive(Debug, Clone, Copy)]
pub struct DecodeLimits {
    pub max_framebuffer_dimension: u16,
    pub max_framebuffer_bytes: usize,
    pub max_server_string_bytes: usize,
    pub max_reason_bytes: usize,
    pub max_rectangles_per_update: usize,
    pub max_compressed_rect_bytes: usize,
    pub max_decompressed_rect_bytes: usize,
    pub max_clipboard_format_bytes: usize,
    pub max_clipboard_decompressed_bytes: usize,
    pub max_relay_message_bytes: usize,
    pub max_relay_frame_bytes: usize,
    pub max_control_queue: usize,
    pub max_frame_queue_bytes: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_framebuffer_dimension: 16_384,
            max_framebuffer_bytes: 256 * 1024 * 1024,
            max_server_string_bytes: 64 * 1024,
            max_reason_bytes: 64 * 1024,
            max_rectangles_per_update: 4_096,
            max_compressed_rect_bytes: 64 * 1024 * 1024,
            max_decompressed_rect_bytes: 128 * 1024 * 1024,
            max_clipboard_format_bytes: 16 * 1024 * 1024,
            max_clipboard_decompressed_bytes: 32 * 1024 * 1024,
            max_relay_message_bytes: 64 * 1024 * 1024,
            max_relay_frame_bytes: 128 * 1024 * 1024 + 12,
            max_control_queue: 256,
            max_frame_queue_bytes: 129 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitError(pub String);

impl fmt::Display for LimitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LimitError {}

impl DecodeLimits {
    pub fn framebuffer_bytes(&self, width: u16, height: u16) -> Result<usize, LimitError> {
        if width == 0 || height == 0 {
            return Err(LimitError("framebuffer dimensions must be non-zero".into()));
        }
        let width = width as usize;
        let height = height as usize;
        if width > self.max_framebuffer_dimension as usize
            || height > self.max_framebuffer_dimension as usize
        {
            return Err(LimitError(format!(
                "framebuffer dimensions exceed {} pixels",
                self.max_framebuffer_dimension
            )));
        }
        let pixels = width
            .checked_mul(height)
            .ok_or_else(|| LimitError("framebuffer pixel count overflow".into()))?;
        let bytes = pixels
            .checked_mul(4)
            .ok_or_else(|| LimitError("framebuffer byte count overflow".into()))?;
        if bytes > self.max_framebuffer_bytes {
            return Err(LimitError(format!(
                "framebuffer exceeds {} MiB",
                self.max_framebuffer_bytes / (1024 * 1024)
            )));
        }
        Ok(bytes)
    }

    pub fn rectangle_bytes(&self, width: u16, height: u16) -> Result<usize, LimitError> {
        if width == 0 || height == 0 {
            return Err(LimitError("rectangle dimensions must be non-zero".into()));
        }
        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| LimitError("rectangle byte count overflow".into()))?;
        if bytes > self.max_decompressed_rect_bytes {
            return Err(LimitError(
                "decoded rectangle exceeds configured limit".into(),
            ));
        }
        Ok(bytes)
    }

    pub fn compressed_bytes(&self, len: u32) -> Result<usize, LimitError> {
        let len = len as usize;
        if len > self.max_compressed_rect_bytes {
            return Err(LimitError(
                "compressed rectangle exceeds configured limit".into(),
            ));
        }
        Ok(len)
    }

    pub fn clipboard_bytes(&self, len: usize) -> Result<(), LimitError> {
        if len > self.max_clipboard_format_bytes {
            return Err(LimitError(
                "clipboard format exceeds configured limit".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framebuffer_limits_checked() {
        let limits = DecodeLimits::default();
        assert_eq!(
            limits.framebuffer_bytes(1920, 1080).unwrap(),
            1920 * 1080 * 4
        );
        assert!(limits.framebuffer_bytes(0, 10).is_err());
        assert!(limits.framebuffer_bytes(16_385, 1).is_err());
    }

    #[test]
    fn rectangle_overflow_is_rejected() {
        let limits = DecodeLimits::default();
        assert!(limits.rectangle_bytes(u16::MAX, u16::MAX).is_err());
    }
}
