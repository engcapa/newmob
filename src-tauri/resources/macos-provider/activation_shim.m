/*
 * activation_shim.m — submit an OSSystemExtensionRequest from Rust.
 *
 * AUTHORED, NOT COMPILER-VERIFIED IN THIS REPO. Compiled only by a macOS
 * `cargo build` (see ../../build.rs `compile_macos_ne_shim`), which links
 * `-framework SystemExtensions -framework Foundation` and sets the
 * `sockscap_ne_shim` cfg. On every other target the Rust side uses a fallback
 * that reports the infrastructure gap, so the crate always links.
 *
 * Exposes one C entry point:
 *
 *     int sockscap_ne_activate(const char *identifier);
 *
 * It submits an activation request for the Network Extension system extension
 * and returns 0 when the request was *accepted for submission*, non-zero on a
 * synchronous failure (bad identifier). Submission is asynchronous and requires
 * user approval on first run; the Rust engine confirms the extension is actually
 * live only when the provider connects to the control socket and authenticates —
 * so a 0 here never by itself means "capturing".
 */

#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>

/*
 * Minimal delegate. OSSystemExtensionRequest requires a delegate; the real
 * activation outcome (needs-approval, superseded, failed, completed) is observed
 * by the engine through the control channel, so this delegate only logs. It is
 * intentionally long-lived (leaked once) because the request runs asynchronously
 * after this function returns.
 */
@interface SockscapActivationDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end

@implementation SockscapActivationDelegate

- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request
                  actionForReplacingExtension:(OSSystemExtensionProperties *)existing
                                withExtension:(OSSystemExtensionProperties *)ext {
    // Always take the newer bundle on upgrade.
    return OSSystemExtensionReplacementActionReplace;
}

- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
    NSLog(@"[sockscap] system extension needs user approval in System Settings");
}

- (void)request:(OSSystemExtensionRequest *)request
    didFinishWithResult:(OSSystemExtensionRequestResult)result {
    NSLog(@"[sockscap] system extension request finished: %ld", (long)result);
}

- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
    NSLog(@"[sockscap] system extension request failed: %@", error);
}

@end

int sockscap_ne_activate(const char *identifier) {
    if (identifier == NULL) {
        return 1;
    }
    NSString *bundleID = [NSString stringWithUTF8String:identifier];
    if (bundleID == nil || bundleID.length == 0) {
        return 2;
    }
    @autoreleasepool {
        OSSystemExtensionRequest *req =
            [OSSystemExtensionRequest activationRequestForExtension:bundleID
                                                              queue:dispatch_get_main_queue()];
        // The delegate must outlive this call (request is async). One controlled
        // leak per activation submission is acceptable and bounded.
        static SockscapActivationDelegate *delegate = nil;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            delegate = [[SockscapActivationDelegate alloc] init];
        });
        req.delegate = delegate;
        [[OSSystemExtensionManager sharedManager] submitRequest:req];
    }
    return 0;
}
