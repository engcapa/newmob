# Mitmproxy macOS Redirector protocol v2 proposal

> Taomni tracking draft, 2026-08-01. This is an upstream design proposal, not a claim that Redirector v0.12.11 implements these fields.

## Goals

Protocol v2 should remove the two safety ambiguities in v1: path-substring selectors cannot express a durable application identity, and writing `InterceptConf` does not prove that the Provider applied it. It must remain possible for a v1 client to migrate without silently broadening capture.

## Proposed protobuf surface

```proto
message ControlRequest {
  uint32 protocol_version = 1;       // must be 2
  bytes session_id = 2;              // random 128-bit value
  uint64 generation = 3;             // strictly increasing per session
  uint64 request_id = 4;
  oneof command {
    ApplyConfiguration apply = 10;
    DisableInterception disable = 11;
    GetStatus get_status = 12;
  }
}

message ProcessSelector {
  oneof selector {
    string exact_canonical_path = 1;
    BundleIdentity bundle = 2;
    uint32 pid = 3;
  }
  bool include_descendants = 10;
}

message BundleIdentity {
  string bundle_id = 1;
  string team_id = 2;
  string signing_id = 3;
  bytes designated_requirement = 4;
}

message ApplyConfiguration {
  repeated ProcessSelector include = 1;
  repeated ProcessSelector exclude = 2;
  bool default_include = 3;
}

message ControlEvent {
  uint32 protocol_version = 1;
  bytes session_id = 2;
  uint64 generation = 3;
  uint64 request_id = 4;
  oneof event {
    Applied applied = 10;
    Disabled disabled = 11;
    ProviderStatus status = 12;
    ProtocolError error = 13;
  }
}

message NewFlowIdentity {
  uint32 pid = 1;
  string canonical_executable_path = 2;
  string bundle_id = 3;
  string team_id = 4;
  string signing_id = 5;
  bytes cd_hash = 6;
  uint64 audit_token_pid_version = 7;
}
```

`Applied` means the Provider has atomically replaced its active immutable configuration and all subsequent new flows use that generation. A client must not display Active before receiving the matching `(session_id, generation, request_id)`.

`DisableInterception` is explicit and idempotent. Once `Disabled` is returned, new flows are fail-open and the Provider no longer attempts to connect to the client listener. Closing or losing the control channel must atomically produce the same fail-open state, without retaining the last configuration.

## Validation rules

- Reject unknown protocol versions before applying configuration.
- Reject generation zero, a repeated/lower generation, empty session IDs, empty selector identity, relative paths and bundle selectors without bundle/signing identity.
- Resolve and validate signing identity inside the privileged Provider at process admission time; client-supplied identity is a constraint, not trusted metadata.
- Include the Provider-observed identity in every `NewFlow`; the client may fail open on any mismatch.
- Bound every frame and selector count before allocation. Unknown protobuf fields remain forward compatible; unknown commands fail explicitly.
- Scope replacement and control EOF are atomic with respect to admission of new flows.

## Compatibility and rollout

1. Add a version negotiation/status exchange without changing the v1 frame type. A v1-only peer closes or rejects the v2 probe; the client then uses the existing v1 path-family adapter only when the user selected that compatibility mode.
2. Publish v2 as a newly signed Redirector release. Taomni pins its version, app/extension hashes, Team/bundle identity and golden fixtures; it never patches or re-signs the Provider.
3. Migrate stored selectors by revalidating the `.app`, then emit a v2 `BundleIdentity`. Preserve canonical paths only as diagnostic/fail-open constraints.
4. Prefer v2 for Global and Applications. Keep v1 recovery support long enough to disable a residual v1 scope, but never translate an ambiguous v1 substring into a broader v2 selector.
5. Remove the v1 compatibility path only after signed Intel and Apple Silicon fault-injection, update/move, EOF and selected/unselected matrices pass.

## Required upstream tests

- Apply/replace/disable ACK correlation, replayed and out-of-order generation rejection.
- Control EOF and Provider restart atomically fail open.
- Exact path, PID, bundle/signing ID and helper/XPC family selection.
- Invalid/replaced signatures, PID reuse, process exec and app update during a session.
- Unknown fields, malformed and oversized frames, action/selector limits.
- 1/32/256 concurrent flows, 1,000–5,000 long-lived flows, UDP flood and sleep/network transitions on arm64 and x86_64.

External submission and the signed upstream release remain outside this repository; Taomni can only integrate v2 after mitmproxy accepts and ships it.
