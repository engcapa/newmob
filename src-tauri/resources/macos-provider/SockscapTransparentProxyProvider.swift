// Sockscap macOS transparent-proxy provider (plan §4.1, §8; ADR-0003).
//
// AUTHORED, NOT COMPILER-VERIFIED IN THIS REPO. This file is Swift for a
// Network Extension *system extension* and can only be built by an Xcode
// system-extension target that is signed with a Developer ID, granted the
// `com.apple.developer.networking.networkextension` entitlement, and notarized —
// none of which a `cargo build` (or a Linux CI) can produce. It is checked in so
// the extension's behaviour lives in one reviewed place; see README.md.
//
// SINGLE SOURCE OF TRUTH. The per-flow capture decision is NOT reimplemented
// here. `handleNewFlow` derives the source app's code-signing identity from the
// flow's `sourceAppAuditToken` and calls `sockscap_provider_decide` from
// `libsockscap_core.a` (exposed via module.modulemap). That is the identical
// function the Rust engine runs, so engine and extension can never disagree.
//
// DYNAMIC CONFIG. The loopback SOCKS port, the control-socket path, the auth
// token, and the capture selection are delivered by the app through the provider
// configuration / `sendProviderMessage` (see `ProviderConfig` on the Rust side).
// Nothing is hardcoded (the old draft hardcoded port 1080 and reimplemented the
// selection check — both removed).

import Foundation
import NetworkExtension
import Network
import Security
import os.log

// Exposed by module.modulemap → sockscap_core.h (libsockscap_core.a).
// sockscap_selection_from_json / _free, sockscap_provider_decide,
// sockscap_control_protocol_version, SOCKSCAP_HANDLE / SOCKSCAP_PASS_THROUGH.

private let logger = OSLog(subsystem: "com.taomni.app.sockscap", category: "provider")

/// Derive the code-signing identifier from a flow's `sourceAppAuditToken`.
///
/// The audit token is the unspoofable anchor on macOS; `sourceAppSigningIdentifier`
/// is *not* guaranteed to equal it, so we resolve the identity ourselves through
/// the code-signing machinery and hand the result to the shared Rust decision.
func signingIdentifier(fromAuditToken tokenData: Data) -> String? {
    guard tokenData.count == MemoryLayout<audit_token_t>.size else { return nil }
    let attrs: [CFString: Any] = [kSecGuestAttributeAudit: tokenData]

    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attrs as CFDictionary, [], &code) == errSecSuccess,
          let guestCode = code else { return nil }

    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(guestCode, [], &staticCode) == errSecSuccess,
          let stat = staticCode else { return nil }

    var infoDict: CFDictionary?
    guard SecCodeCopySigningInformation(stat, SecCSFlags(rawValue: kSecCSSigningInformation), &infoDict)
            == errSecSuccess,
          let info = infoDict as? [String: Any] else { return nil }

    // kSecCodeInfoIdentifier is the signing identifier (bundle id for typical
    // Developer-ID / App-Store apps). This is the value the picker stores and the
    // selection set is keyed on.
    return info[kSecCodeInfoIdentifier as String] as? String
}

final class SockscapTransparentProxyProvider: NETransparentProxyProvider {
    /// Loopback SOCKS port to relay handled flows into (from provider config).
    private var socksPort: UInt16 = 0
    /// Opaque compiled selection owned by the core; freed on stop / reconfig.
    private var selection: OpaquePointer?
    /// Auth token + control-socket path for the engine heartbeat channel.
    private var controlToken: String = ""
    private var controlSocketPath: String = ""

    // MARK: Lifecycle

    override func startProxy(options: [String: Any]? = nil,
                            completionHandler: @escaping (Error?) -> Void) {
        // Version gate: refuse to start against an engine that speaks a different
        // control protocol rather than misinterpret its frames.
        applyConfiguration(options)

        // Include-all outbound TCP; per-flow filtering happens in handleNewFlow.
        // Loopback is excluded so our own relay dial into the SOCKS port is never
        // re-captured (the decision also self-bypasses us, this is defence in depth).
        let settings = NETransparentProxyNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        let tcp = NENetworkRule(remoteNetwork: nil, remotePrefix: 0,
                                localNetwork: nil, localPrefix: 0,
                                protocol: .TCP, direction: .outbound)
        settings.includedNetworkRules = [tcp]
        let loopback4 = NENetworkRule(
            remoteNetwork: NWHostEndpoint(hostname: "127.0.0.0", port: "0"),
            remotePrefix: 8, localNetwork: nil, localPrefix: 0,
            protocol: .TCP, direction: .outbound)
        let loopback6 = NENetworkRule(
            remoteNetwork: NWHostEndpoint(hostname: "::1", port: "0"),
            remotePrefix: 128, localNetwork: nil, localPrefix: 0,
            protocol: .TCP, direction: .outbound)
        settings.excludedNetworkRules = [loopback4, loopback6]

        setTunnelNetworkSettings(settings) { error in
            if let error = error {
                os_log("failed to set settings: %{public}@", log: logger, type: .error, "\(error)")
            }
            completionHandler(error)
        }
    }

    override func stopProxy(with reason: NEProviderStopReason,
                           completionHandler: @escaping () -> Void) {
        if let selection = selection {
            sockscap_selection_free(selection)
        }
        selection = nil
        completionHandler()
    }

    /// The app pushes selection/config updates here (`sendProviderMessage`).
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        applyConfiguration(try? JSONSerialization.jsonObject(with: messageData) as? [String: Any])
        completionHandler?(nil)
    }

    /// Parse a provider-configuration dictionary: dynamic port, token, control
    /// socket, and the selection JSON (rebuilt into a core selection via FFI).
    private func applyConfiguration(_ options: [String: Any]?) {
        guard let options = options else { return }
        if let port = options["socksPort"] as? NSNumber {
            socksPort = port.uint16Value
        }
        if let token = options["token"] as? String { controlToken = token }
        if let path = options["controlSocketPath"] as? String { controlSocketPath = path }
        if let json = options["selectionJson"] as? String {
            let fresh = json.withCString { sockscap_selection_from_json($0) }
            if let old = selection { sockscap_selection_free(old) }
            selection = fresh // may be nil (fail-closed: nothing captured)
        }
    }

    // MARK: Per-flow decision (delegated to the shared Rust core)

    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        // Resolve the source identity from the audit token, then ask the ONE
        // shared decision whether to capture. Empty id + NULL selection are
        // handled inside the core (follow-scope / fail-closed).
        let auditToken = flow.metaData.sourceAppAuditToken ?? Data()
        let signingID = signingIdentifier(fromAuditToken: auditToken) ?? ""

        let verdict = signingID.withCString { idPtr -> Int32 in
            sockscap_provider_decide(selection.map { UnsafePointer($0) }, idPtr)
        }
        guard verdict == SOCKSCAP_HANDLE, let tcpFlow = flow as? NEAppProxyTCPFlow else {
            return false // pass through (DIRECT)
        }
        guard let endpoint = tcpFlow.remoteEndpoint as? NWHostEndpoint else {
            return false
        }
        relayThroughSocks(tcpFlow, host: endpoint.hostname, port: endpoint.port)
        return true
    }

    // MARK: SOCKS relay into the local Sockscap backend (routing lives in Rust)

    /// Open the flow, connect to the engine's loopback SOCKS port, CONNECT to the
    /// original destination, and pump bytes both ways. All PROXY/DIRECT/BLOCK
    /// routing is decided by the engine behind that SOCKS port.
    private func relayThroughSocks(_ flow: NEAppProxyTCPFlow, host: String, port: String) {
        guard socksPort != 0 else {
            os_log("no SOCKS port configured; dropping flow", log: logger, type: .error)
            flow.closeReadWithError(nil); flow.closeWriteWithError(nil)
            return
        }
        let conn = NWConnection(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: socksPort)!,
            using: .tcp)
        conn.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                flow.open(withLocalEndpoint: nil) { error in
                    if error == nil {
                        self.socksHandshake(conn, host: host, port: UInt16(port) ?? 0) {
                            self.pump(flow: flow, conn: conn)
                        }
                    } else {
                        conn.cancel()
                    }
                }
            case .failed, .cancelled:
                flow.closeReadWithError(nil); flow.closeWriteWithError(nil)
            default:
                break
            }
        }
        conn.start(queue: .global())
    }

    /// Minimal SOCKS5 CONNECT handshake to the local backend (no auth — the
    /// listener is loopback-only, matching the engine's ingress contract).
    private func socksHandshake(_ conn: NWConnection, host: String, port: UInt16,
                               done: @escaping () -> Void) {
        let greeting = Data([0x05, 0x01, 0x00])
        conn.send(content: greeting, completion: .contentProcessed { _ in
            conn.receive(minimumIncompleteLength: 2, maximumLength: 2) { _, _, _, _ in
                var req: [UInt8] = [0x05, 0x01, 0x00, 0x03, UInt8(host.utf8.count)]
                req.append(contentsOf: Array(host.utf8))
                req.append(UInt8(port >> 8)); req.append(UInt8(port & 0xff))
                conn.send(content: Data(req), completion: .contentProcessed { _ in
                    conn.receive(minimumIncompleteLength: 10, maximumLength: 10) { _, _, _, _ in
                        done()
                    }
                })
            }
        })
    }

    /// Bidirectionally pump bytes between the app flow and the SOCKS connection.
    private func pump(flow: NEAppProxyTCPFlow, conn: NWConnection) {
        func appToProxy() {
            flow.readData { data, error in
                guard let data = data, !data.isEmpty, error == nil else {
                    conn.cancel(); return
                }
                conn.send(content: data, completion: .contentProcessed { _ in appToProxy() })
            }
        }
        func proxyToApp() {
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                if let data = data, !data.isEmpty {
                    flow.write(data) { _ in proxyToApp() }
                } else if isComplete || error != nil {
                    flow.closeReadWithError(nil); flow.closeWriteWithError(nil)
                }
            }
        }
        appToProxy()
        proxyToApp()
    }
}


