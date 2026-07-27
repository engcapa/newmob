/*
 * sockscap_core.h — C ABI for the SocksCap capture-plane primitives.
 *
 * The macOS NETransparentProxyProvider system extension links
 * `libsockscap_core.a` and calls these from Swift (via a bridging header or a
 * module map), so the per-flow capture decision has ONE implementation shared
 * with the Taomni engine and can never drift into a second Swift copy.
 *
 * Hand-maintained and kept in sync with src/ffi.rs by a Rust test
 * (ffi::tests::* exercise every symbol below).
 *
 * Safety contract (see src/ffi.rs):
 *  - char* args are NUL-terminated UTF-8 or NULL; NULL/invalid is handled.
 *  - No Rust panic crosses this boundary.
 *  - A pointer from sockscap_selection_from_json must be freed exactly once
 *    with sockscap_selection_free.
 */

#ifndef SOCKSCAP_CORE_H
#define SOCKSCAP_CORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Return values of sockscap_provider_decide. */
#define SOCKSCAP_PASS_THROUGH 0 /* let the OS dial it directly (DIRECT) */
#define SOCKSCAP_HANDLE       1 /* relay into the local SOCKS backend      */

/* Opaque compiled selection. Build once per config version, query per flow. */
typedef struct SockscapSelection SockscapSelection;

/*
 * Parse a selection from JSON, e.g.
 *   {"global":false,"selectedAppIds":["com.a.b"],"bypassIds":["com.c.d"]}
 * Returns NULL on NULL input or malformed JSON — treat NULL as "no selection"
 * and fail closed (pass everything through).
 */
SockscapSelection *sockscap_selection_from_json(const char *json);

/* Release a selection from sockscap_selection_from_json. NULL-safe. */
void sockscap_selection_free(SockscapSelection *selection);

/*
 * Decide a single flow. `source_signing_id` is the identity derived from the
 * flow's sourceAppAuditToken via the OS code-signing machinery. Fails closed
 * (SOCKSCAP_PASS_THROUGH) on a NULL selection or NULL/invalid id.
 */
int32_t sockscap_provider_decide(const SockscapSelection *selection,
                                 const char *source_signing_id);

/* Control-protocol version this build speaks; compare before handshaking. */
uint32_t sockscap_control_protocol_version(void);

#ifdef __cplusplus
}
#endif

#endif /* SOCKSCAP_CORE_H */
