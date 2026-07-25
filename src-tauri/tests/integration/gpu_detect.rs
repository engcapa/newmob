//! GPU detect basics (Layer 2 §16.7): the function should never panic and
//! should return a sensible variant on every host.

use taomni_lib::llm::gpu_detect::{detect, GpuBackend};

#[test]
fn gpu_detect_returns_a_variant() {
    let backend = detect();
    let label = backend.label();
    assert!(!label.is_empty());
    match backend {
        GpuBackend::Cpu => {}
        GpuBackend::Metal => {}
        GpuBackend::Vulkan { device, .. } => assert!(!device.is_empty()),
        GpuBackend::Cuda { device, .. } => assert!(!device.is_empty()),
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_always_returns_metal() {
    matches!(detect(), GpuBackend::Metal);
}
