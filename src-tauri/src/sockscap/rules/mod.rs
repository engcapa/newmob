//! Rule compilation and matching (GFWList / AutoProxy + user helpers).

mod autopxy;
pub mod dns;
pub mod dns_map;
mod gfwlist;
pub mod source;
pub mod sni;

#[allow(unused_imports)]
pub use dns_map::DnsMap;
pub use gfwlist::{CompiledRules, GfwListMeta, RuleMatch};
#[allow(unused_imports)]
pub use sni::extract_sni;
#[allow(unused_imports)]
pub use autopxy::parse_autopxy_line;
