//! Lightweight latency telemetry for the local RDP server.
//!
//! The RDP server has native capture, a cross-thread handoff, protocol diffing
//! and a separate input actor. Keeping the measurements at those ownership
//! boundaries makes a slow session diagnosable without adding a profiler to a
//! customer machine. Values are reported as a rolling 256-sample window every
//! five seconds, and never contain screen pixels, credentials, or input data.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::servers::engine::LogEmitter;

const REPORT_INTERVAL: Duration = Duration::from_secs(5);
const SAMPLE_WINDOW: usize = 256;

/// Shared, per-server telemetry. Cloning this handle is cheap; the display
/// capture thread and the input actor both record into the same session view.
#[derive(Clone)]
pub(crate) struct RdpMetrics {
    inner: Arc<Mutex<MetricsState>>,
    /// `None` only in unit tests, which have no Tauri `AppHandle` to emit
    /// through. Recording stays fully active either way.
    log: Option<LogEmitter>,
}

struct MetricsState {
    last_report: Instant,
    captured_frames: u64,
    forwarded_frames: u64,
    duplicate_frames: u64,
    replaced_frames: u64,
    input_coalesced: u64,
    input_dropped: u64,
    raw_bytes: u64,
    capture_us: SampleWindow,
    hash_us: SampleWindow,
    frame_age_us: SampleWindow,
    input_age_us: SampleWindow,
}

#[derive(Default)]
struct SampleWindow {
    values: VecDeque<u64>,
}

#[derive(Clone, Copy)]
struct Percentiles {
    p50: u64,
    p95: u64,
}

impl SampleWindow {
    fn push(&mut self, duration: Duration) {
        if self.values.len() == SAMPLE_WINDOW {
            self.values.pop_front();
        }
        self.values.push_back(duration.as_micros() as u64);
    }

    fn percentiles(&self) -> Option<Percentiles> {
        if self.values.is_empty() {
            return None;
        }
        let mut values = self.values.iter().copied().collect::<Vec<_>>();
        values.sort_unstable();
        let percentile = |numerator: usize, denominator: usize| {
            let index = values.len().saturating_sub(1) * numerator / denominator;
            values[index]
        };
        Some(Percentiles {
            p50: percentile(50, 100),
            p95: percentile(95, 100),
        })
    }
}

impl RdpMetrics {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self::with_sink(Some(log))
    }

    /// Metrics that record but never emit. Lets capture/display loops be driven
    /// in unit tests without a Tauri application handle.
    #[cfg(test)]
    pub(crate) fn silent() -> Self {
        Self::with_sink(None)
    }

    fn with_sink(log: Option<LogEmitter>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MetricsState {
                last_report: Instant::now(),
                captured_frames: 0,
                forwarded_frames: 0,
                duplicate_frames: 0,
                replaced_frames: 0,
                input_coalesced: 0,
                input_dropped: 0,
                raw_bytes: 0,
                capture_us: SampleWindow::default(),
                hash_us: SampleWindow::default(),
                frame_age_us: SampleWindow::default(),
                input_age_us: SampleWindow::default(),
            })),
            log,
        }
    }

    /// Record capture-side latency: the time attributable to getting one frame's
    /// pixels into our hands.
    ///
    /// For a grab-on-demand backend that is the duration of the capture call.
    /// A backend that blocks until the next frame exists — self-paced (see
    /// [`Capturer::is_self_paced`]) or event-driven
    /// ([`Capturer::is_event_driven`]) — spends nearly all of that call waiting,
    /// so the caller passes the frame's age at pickup instead. Charging the
    /// deliberate wait to "capture" would just report the frame interval and
    /// hide the real cost.
    ///
    /// [`Capturer::is_self_paced`]: super::capture::Capturer::is_self_paced
    /// [`Capturer::is_event_driven`]: super::capture::Capturer::is_event_driven
    pub(crate) fn record_capture(&self, duration: Duration, bytes: usize) {
        if let Ok(mut state) = self.inner.lock() {
            state.captured_frames += 1;
            state.raw_bytes += bytes as u64;
            state.capture_us.push(duration);
        }
    }

    /// Capture-side p50 in microseconds. Lets tests assert what the "capture"
    /// metric actually measures, which is the whole point of recording it.
    #[cfg(test)]
    pub(crate) fn capture_p50_us(&self) -> Option<u64> {
        self.inner
            .lock()
            .ok()
            .and_then(|state| state.capture_us.percentiles())
            .map(|values| values.p50)
    }

    #[cfg(test)]
    pub(crate) fn hash_sample_count(&self) -> usize {
        self.inner
            .lock()
            .map(|state| state.hash_us.values.len())
            .unwrap_or_default()
    }

    pub(crate) fn record_hash(&self, duration: Duration) {
        if let Ok(mut state) = self.inner.lock() {
            state.hash_us.push(duration);
        }
    }

    pub(crate) fn record_duplicate_frame(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.duplicate_frames += 1;
        }
    }

    pub(crate) fn record_frame_replaced(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.replaced_frames += 1;
        }
    }

    pub(crate) fn record_input_coalesced(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.input_coalesced += 1;
        }
    }

    pub(crate) fn record_input_dropped(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.input_dropped += 1;
        }
    }

    pub(crate) fn record_frame_handoff(&self, captured_at: Instant) {
        if let Ok(mut state) = self.inner.lock() {
            state.forwarded_frames += 1;
            state.frame_age_us.push(captured_at.elapsed());
        }
    }

    pub(crate) fn record_input_handoff(&self, received_at: Instant) {
        if let Ok(mut state) = self.inner.lock() {
            state.input_age_us.push(received_at.elapsed());
        }
    }

    /// Emit one compact snapshot at most every five seconds. This method is
    /// intentionally cheap in the hot path when a report is not due.
    pub(crate) fn report_if_due(&self) {
        let Some(log) = self.log.as_ref() else {
            return;
        };
        let snapshot = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.last_report.elapsed() < REPORT_INTERVAL {
                return;
            }
            state.last_report = Instant::now();
            (
                state.captured_frames,
                state.forwarded_frames,
                state.duplicate_frames,
                state.replaced_frames,
                state.input_coalesced,
                state.input_dropped,
                state.raw_bytes,
                state.capture_us.percentiles(),
                state.hash_us.percentiles(),
                state.frame_age_us.percentiles(),
                state.input_age_us.percentiles(),
            )
        };

        let fmt = |name: &str, values: Option<Percentiles>| match values {
            Some(values) => format!(
                " {name}=p50:{}ms/p95:{}ms",
                values.p50 / 1_000,
                values.p95 / 1_000
            ),
            None => String::new(),
        };
        let (
            captured,
            forwarded,
            duplicates,
            replaced,
            input_coalesced,
            input_dropped,
            bytes,
            capture,
            hash,
            age,
            input,
        ) = snapshot;
        log.line(format!(
            "RDP latency: captured={captured} forwarded={forwarded} duplicate={duplicates} replaced={replaced} input-coalesced={input_coalesced} input-dropped={input_dropped} raw={}MiB{}{}{}{}",
            bytes / (1024 * 1024),
            fmt(" capture", capture),
            fmt(" hash", hash),
            fmt(" frame-age", age),
            fmt(" input", input),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::SampleWindow;
    use std::time::Duration;

    #[test]
    fn percentile_window_evicts_the_oldest_sample() {
        let mut samples = SampleWindow::default();
        for value in 0..257 {
            samples.push(Duration::from_micros(value));
        }

        let values = samples.percentiles().unwrap();
        assert_eq!(values.p50, 128);
        assert_eq!(values.p95, 243);
    }
}
