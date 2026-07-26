//! Control protocol — re-exported from [`sockscap_core`].
//!
//! The message types, codec, and [`ControlServer`] state machine live in the
//! `sockscap-core` crate so the Network Extension links the identical
//! definitions. The engine-side socket loop that drives them is in
//! [`super::adapter`].

pub use sockscap_core::control::{
    CONTROL_PROTOCOL_VERSION, ControlRequest, ControlResponse, ControlServer, ControlState,
    decode_line, encode_line,
};
