//! C-ABI the macOS Network Extension provider calls per flow.
//!
//! The extension links `libsockscap_core.a` and calls these functions from
//! Swift (`handleNewFlow`), so the capture rule has exactly one implementation.
//! The header is hand-maintained at `include/sockscap_core.h` and kept in sync
//! by [`tests::header_matches_exports`].
//!
//! # Safety contract for all exports
//!
//! * Every `*const c_char` must be a NUL-terminated C string or NULL. NULL and
//!   invalid UTF-8 are handled (never dereferenced blindly, never assumed
//!   valid), so a bad pointer degrades to a safe default instead of UB.
//! * No Rust panic ever crosses the FFI boundary — the pure logic underneath
//!   does not panic, and nothing here can unwind into C.
//! * Ownership: [`sockscap_selection_from_json`] returns a pointer that the
//!   caller **must** release with [`sockscap_selection_free`] exactly once.

use std::ffi::{CStr, c_char};

use crate::control::CONTROL_PROTOCOL_VERSION;
use crate::decision::{ProviderFlowDecision, SelectedApps, macos_provider_decision};

/// Decision result across the C boundary (avoids assuming an enum ABI).
pub const SOCKSCAP_PASS_THROUGH: i32 = 0;
pub const SOCKSCAP_HANDLE: i32 = 1;

/// Opaque compiled selection. Built once per config version, queried per flow.
pub struct SockscapSelection {
    inner: SelectedApps,
}

/// JSON shape delivered to the provider (mirrors the control protocol's
/// selection fields). Example: `{"global":false,"selectedAppIds":["com.a.b"]}`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionJson {
    #[serde(default)]
    global: bool,
    #[serde(default)]
    selected_app_ids: Vec<String>,
    /// Extra always-pass-through identities (e.g. the resolved upstream client).
    #[serde(default)]
    bypass_ids: Vec<String>,
}

/// Read a C string as UTF-8, or `None` for NULL / invalid UTF-8.
///
/// # Safety
/// `ptr` must be NULL or a valid NUL-terminated C string.
unsafe fn cstr(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .ok()
        .map(str::to_owned)
}

/// Parse a selection from JSON. Returns NULL on NULL input or malformed JSON;
/// the caller must treat NULL as "no selection" (fail closed).
///
/// # Safety
/// `json` must be NULL or a valid NUL-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sockscap_selection_from_json(
    json: *const c_char,
) -> *mut SockscapSelection {
    let Some(text) = (unsafe { cstr(json) }) else {
        return std::ptr::null_mut();
    };
    let Ok(parsed) = serde_json::from_str::<SelectionJson>(&text) else {
        return std::ptr::null_mut();
    };
    let mut selection = SelectedApps::new(parsed.global, parsed.selected_app_ids);
    for id in parsed.bypass_ids {
        selection = selection.with_bypass(id);
    }
    Box::into_raw(Box::new(SockscapSelection { inner: selection }))
}

/// Release a selection returned by [`sockscap_selection_from_json`]. NULL-safe.
///
/// # Safety
/// `selection` must be NULL or a pointer previously returned by
/// [`sockscap_selection_from_json`] and not already freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sockscap_selection_free(selection: *mut SockscapSelection) {
    if !selection.is_null() {
        drop(unsafe { Box::from_raw(selection) });
    }
}

/// Decide a single flow. Returns [`SOCKSCAP_HANDLE`] or [`SOCKSCAP_PASS_THROUGH`].
///
/// A NULL selection fails closed to `PASS_THROUGH`. A NULL/invalid
/// `source_signing_id` is treated as an empty (unattributable) identity and
/// *follows scope*: captured under a global selection, passed through under an
/// app selection — the same rule as [`macos_provider_decision`].
///
/// # Safety
/// `selection` must be NULL or valid (see [`sockscap_selection_from_json`]);
/// `source_signing_id` must be NULL or a valid NUL-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sockscap_provider_decide(
    selection: *const SockscapSelection,
    source_signing_id: *const c_char,
) -> i32 {
    let Some(selection) = (unsafe { selection.as_ref() }) else {
        return SOCKSCAP_PASS_THROUGH;
    };
    let id = unsafe { cstr(source_signing_id) }.unwrap_or_default();
    match macos_provider_decision(&id, &selection.inner) {
        ProviderFlowDecision::Handle => SOCKSCAP_HANDLE,
        ProviderFlowDecision::PassThrough => SOCKSCAP_PASS_THROUGH,
    }
}

/// The control-protocol version this build speaks. The extension compares it
/// against its own compiled-in constant before handshaking.
#[unsafe(no_mangle)]
pub extern "C" fn sockscap_control_protocol_version() -> u32 {
    CONTROL_PROTOCOL_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn selection(json: &str) -> *mut SockscapSelection {
        let c = CString::new(json).unwrap();
        unsafe { sockscap_selection_from_json(c.as_ptr()) }
    }

    fn decide(sel: *const SockscapSelection, id: &str) -> i32 {
        let c = CString::new(id).unwrap();
        unsafe { sockscap_provider_decide(sel, c.as_ptr()) }
    }

    #[test]
    fn app_selection_handles_only_listed_ids() {
        let sel = selection(r#"{"global":false,"selectedAppIds":["com.apple.Safari"]}"#);
        assert!(!sel.is_null());
        assert_eq!(decide(sel, "com.apple.Safari"), SOCKSCAP_HANDLE);
        assert_eq!(decide(sel, "org.mozilla.firefox"), SOCKSCAP_PASS_THROUGH);
        unsafe { sockscap_selection_free(sel) };
    }

    #[test]
    fn global_selection_handles_everything_but_self() {
        let sel = selection(r#"{"global":true,"selectedAppIds":[]}"#);
        assert_eq!(decide(sel, "com.apple.Safari"), SOCKSCAP_HANDLE);
        assert_eq!(
            decide(sel, crate::decision::SELF_BUNDLE_ID),
            SOCKSCAP_PASS_THROUGH
        );
        unsafe { sockscap_selection_free(sel) };
    }

    #[test]
    fn bypass_ids_are_honored() {
        let sel =
            selection(r#"{"global":true,"selectedAppIds":[],"bypassIds":["com.acme.upstream"]}"#);
        assert_eq!(decide(sel, "com.acme.upstream"), SOCKSCAP_PASS_THROUGH);
        unsafe { sockscap_selection_free(sel) };
    }

    #[test]
    fn null_selection_fails_closed() {
        assert_eq!(
            decide(std::ptr::null(), "com.apple.Safari"),
            SOCKSCAP_PASS_THROUGH
        );
    }

    #[test]
    fn null_and_malformed_json_return_null() {
        assert!(unsafe { sockscap_selection_from_json(std::ptr::null()) }.is_null());
        assert!(selection("{not json").is_null());
    }

    #[test]
    fn null_signing_id_follows_scope() {
        // Unattributable under app scope: pass through (matches no app).
        let app = selection(r#"{"global":false,"selectedAppIds":["com.apple.Safari"]}"#);
        assert_eq!(
            unsafe { sockscap_provider_decide(app, std::ptr::null()) },
            SOCKSCAP_PASS_THROUGH
        );
        unsafe { sockscap_selection_free(app) };

        // Unattributable under global scope: handle (global = everything).
        let glob = selection(r#"{"global":true}"#);
        assert_eq!(
            unsafe { sockscap_provider_decide(glob, std::ptr::null()) },
            SOCKSCAP_HANDLE
        );
        unsafe { sockscap_selection_free(glob) };
    }

    #[test]
    fn free_is_null_safe() {
        unsafe { sockscap_selection_free(std::ptr::null_mut()) };
    }

    #[test]
    fn protocol_version_matches_control() {
        assert_eq!(
            sockscap_control_protocol_version(),
            CONTROL_PROTOCOL_VERSION
        );
    }
}
