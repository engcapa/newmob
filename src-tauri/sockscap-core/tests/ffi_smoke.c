/*
 * ffi_smoke.c — proves the exact C boundary the macOS Network Extension will
 * use: link libsockscap_core.a and call the decision through the C ABI.
 *
 * This is NOT a cargo test (cargo ignores .c under tests/). Build + run it
 * against the staticlib — see sockscap-core/tests/run_ffi_smoke.sh, or:
 *
 *   cargo build -p sockscap-core
 *   cc tests/ffi_smoke.c -I include \
 *      -L ../target/debug -lsockscap_core -o /tmp/ffi_smoke \
 *      -framework CoreFoundation -framework Security   # macOS system libs
 *   /tmp/ffi_smoke
 *
 * Exit code 0 = every assertion held.
 */

#include "sockscap_core.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    /* App scope: only the listed signing id is handled. */
    SockscapSelection *app = sockscap_selection_from_json(
        "{\"global\":false,\"selectedAppIds\":[\"com.apple.Safari\"]}");
    assert(app != NULL);
    assert(sockscap_provider_decide(app, "com.apple.Safari") == SOCKSCAP_HANDLE);
    assert(sockscap_provider_decide(app, "org.mozilla.firefox") == SOCKSCAP_PASS_THROUGH);
    sockscap_selection_free(app);

    /* Global scope: everything handled except our own bundle. */
    SockscapSelection *glob =
        sockscap_selection_from_json("{\"global\":true}");
    assert(glob != NULL);
    assert(sockscap_provider_decide(glob, "com.apple.Safari") == SOCKSCAP_HANDLE);
    assert(sockscap_provider_decide(glob, "com.taomni.app") == SOCKSCAP_PASS_THROUGH);
    sockscap_selection_free(glob);

    /* Fail closed on a NULL selection and malformed JSON. */
    assert(sockscap_provider_decide(NULL, "com.apple.Safari") == SOCKSCAP_PASS_THROUGH);
    assert(sockscap_selection_from_json("{not json") == NULL);
    sockscap_selection_free(NULL); /* NULL-safe */

    /* Control protocol version is exported. */
    assert(sockscap_control_protocol_version() >= 1);

    printf("ffi_smoke: OK (control protocol v%u)\n",
           sockscap_control_protocol_version());
    return 0;
}
