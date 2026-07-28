//! Platform-independent runtime helpers for the transparent backend.
//!
//! The pieces here decide *which* macOS backend to run and *whether the provider
//! actually connected*, with no macOS API surface — so they build and are
//! unit-tested on every Unix host, unlike the thin macOS wiring in
//! [`capture::macos::transparent`](crate::sockscap::capture) that consumes them.

use std::time::Duration;

use tokio::sync::watch;

/// Which macOS capture backend the engine should run for a Start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacosBackend {
    /// Transparent per-flow capture via the Network Extension. Chosen only when
    /// a signed extension is actually present in the build.
    Transparent,
    /// Phase 1 fallback: system SOCKS proxy → loopback ingress. Global scope
    /// only, but always available without any extension.
    SystemProxy,
}

/// Pick the macOS backend. Transparent is strictly better (real capture, per-app
/// identity, honours Global too), so it wins whenever the extension is installed;
/// otherwise the always-available system-proxy backend is used.
///
/// Kept as one named decision point (rather than an inline `if`) so the rule is
/// documented and unit-tested, and so a future "force system proxy" preference
/// has one obvious home.
pub fn choose_macos_backend(extension_present: bool) -> MacosBackend {
    if extension_present {
        MacosBackend::Transparent
    } else {
        MacosBackend::SystemProxy
    }
}

/// Wait up to `timeout` for the provider to authenticate on the control channel.
///
/// Returns `true` as soon as readiness is observed (including if it was already
/// ready), `false` on timeout or if the sender is dropped. The engine uses this
/// to decide between reporting the transparent plane Active and falling back to
/// the system-proxy backend when the user has not yet approved the extension.
pub async fn wait_for_provider(mut ready: watch::Receiver<bool>, timeout: Duration) -> bool {
    if *ready.borrow() {
        return true;
    }
    match tokio::time::timeout(timeout, ready.changed()).await {
        Ok(Ok(())) => *ready.borrow(),
        // Sender dropped, or timed out: provider did not connect in time.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparent_only_when_extension_present() {
        assert_eq!(choose_macos_backend(true), MacosBackend::Transparent);
        assert_eq!(choose_macos_backend(false), MacosBackend::SystemProxy);
    }

    #[tokio::test]
    async fn wait_returns_true_when_already_ready() {
        let (tx, rx) = watch::channel(true);
        assert!(wait_for_provider(rx, Duration::from_millis(50)).await);
        drop(tx);
    }

    #[tokio::test]
    async fn wait_returns_true_when_readiness_arrives() {
        let (tx, rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let _ = tx.send(true);
            // Keep the sender alive briefly so the receiver observes the change.
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        assert!(wait_for_provider(rx, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn wait_times_out_when_no_provider_connects() {
        let (_tx, rx) = watch::channel(false);
        assert!(!wait_for_provider(rx, Duration::from_millis(20)).await);
    }

    #[tokio::test]
    async fn wait_returns_false_when_sender_dropped() {
        let (tx, rx) = watch::channel(false);
        drop(tx);
        assert!(!wait_for_provider(rx, Duration::from_millis(20)).await);
    }
}
