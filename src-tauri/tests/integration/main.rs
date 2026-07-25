//! Single integration-test binary for the taomni crate.
//!
//! Cargo builds one executable per top-level file under `tests/`. Each of those
//! binaries links the full `taomni_lib` with debug info (~hundreds of MB). With
//! a dozen separate files that multiplies into many GB under `target/debug`.
//! Keeping every integration case as a module of this one crate links once.

mod support;

mod acp_runtime;
mod asr_llm_isolation;
mod cloud_only_smoke;
mod concurrent_three_workloads;
mod fim_latency;
mod gpu_detect;
mod models_downloader;
mod network_policy;
mod perf_baseline;
mod router_routing;
mod router_vault_lock;
mod sockscap_win11_scenarios;
mod three_source_probe;
mod voice_intent_latency;
