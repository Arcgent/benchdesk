// CLI smoke tests, also runnable with Command Line Tools (no XCTest/iOS SDK).
// swiftc -parse-as-library ios/BenchdeskCore/Sources/BenchdeskCore/*.swift ios/verify-core.swift -o /tmp/benchdesk-ios-check
import Foundation

private struct CheckFailure: Error { let message: String }
private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw CheckFailure(message: message) }
}
private func rejects(_ action: () throws -> Void) throws {
    do { try action() } catch { return }
    throw CheckFailure(message: "Expected rejection")
}
private final class MockHTTP: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: String], String))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, headers, body) = try Self.handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
private func body(_ request: URLRequest) throws -> [String: String] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream, data.isEmpty {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
    }
    return try JSONDecoder().decode([String: String].self, from: data)
}

@main private enum VerifyCore {
    static func main() async throws {
        let origin = URL(string: "https://mac.example:8443")!
        let value = String(repeating: "a", count: 64)
        let credential = StationCredential(origin: origin, cookieName: "__Host-benchdesk_mobile_test", cookieValue: value, expires: Date().addingTimeInterval(300))
        func makeClient(auth: Bool = true) throws -> StationClient {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [MockHTTP.self]
            return try StationClient(origin: origin, credential: auth ? credential : nil, configuration: config)
        }
        let normalized = try StationAddress.parse(" https://Mac.Example:8443/ ")
        try check(normalized == origin, "origin normalization")
        for address in ["http://mac.example", "https://u:p@mac.example", "https://mac.example/path", "https://mac.example?secret=x", "https://mac.example#x", "file:///tmp/x", "https://mac.example:0"] {
            try rejects { _ = try StationAddress.parse(address) }
        }
        print("PASS HTTPS origin validation")

        try rejects { _ = try StationClient(origin: URL(string: "https://other.example")!, credential: credential) }
        try check(!StationCredential(origin: origin, cookieName: "__Host-benchdesk_mobile_x\r\nX", cookieValue: value, expires: .distantFuture).isValid, "header injection")
        try check(!StationCredential(origin: origin, cookieName: credential.cookieName, cookieValue: value, expires: .distantPast).isValid, "expiration")
        print("PASS credential scope, injection and expiration")

        MockHTTP.handler = { request in
            try check(request.url?.path == "/api/pair", "pair route")
            try check(request.httpMethod == "POST", "pair method")
            try check(request.value(forHTTPHeaderField: "Origin") == origin.absoluteString, "pair Origin")
            try check(request.value(forHTTPHeaderField: "Cookie") == nil, "pair without cookie")
            let payload = try body(request)
            try check(payload["code"] == "12345678", "pair code")
            return (200, ["Set-Cookie": "\(credential.cookieName)=\(value); HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=2592000"], "{\"ok\":true}")
        }
        let paired = try await makeClient(auth: false).pair(code: "1234 5678")
        try check(paired.isValid && paired.origin == origin, "paired credential")
        print("PASS pairing cookie contract")

        MockHTTP.handler = { request in
            try check(request.url?.path == "/api/sessions", "sessions route")
            try check(request.value(forHTTPHeaderField: "Cookie") == "\(credential.cookieName)=\(value)", "scoped cookie")
            return (200, [:], "{\"station\":\"Mac\",\"sessions\":[]}")
        }
        let sessions = try await makeClient().sessions()
        try check(sessions.station == "Mac" && sessions.sessions.isEmpty, "session decode")
        print("PASS session decoding and authenticated requests")

        MockHTTP.handler = { _ in (401, [:], "{\"error\":\"Koppel opnieuw\"}") }
        do { _ = try await makeClient().sessions(); throw CheckFailure(message: "Expected 401") }
        catch let error as StationError { try check(error.requiresPairing, "401 handling") }
        print("PASS expired pairing response")

        func item(_ text: String, id: String = "a", order: Int = 1) throws -> ChatItem {
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "order": order, "sequence": order, "kind": "assistant", "status": "running", "text": text])
            return try JSONDecoder().decode(ChatItem.self, from: data)
        }
        let merged = try ChatHistory.merging([item("old")], [item("second", id: "b", order: 2), item("updated")])
        try check(merged.map(\.text) == ["updated", "second"], "history merge")
        print("PASS streaming chat deduplication")

        try check(TerminalText.plain("\u{1B}[31mHallo\u{1B}[0m\nwereld") == "Hallo\nwereld", "ANSI color")
        try check(TerminalText.plain("\u{1B}]8;;https://example.com\u{7}Link\u{1B}]8;;\u{7}") == "Link", "OSC link")
        print("PASS terminal escape filtering")

        let messageID = UUID()
        var calls = 0
        MockHTTP.handler = { request in
            calls += 1
            try check(request.url?.path == "/api/message", "message route")
            let payload = try body(request)
            try check(payload["clientMessageId"] == messageID.uuidString.lowercased(), "stable message ID")
            try check(payload["message"] == "Hallo", "message text")
            return (503, [:], "{\"error\":\"Onzeker\"}")
        }
        do { _ = try await makeClient().send(id: UUID().uuidString, text: "Hallo", messageID: messageID); throw CheckFailure(message: "Expected 503") }
        catch let error as StationError {
            if case .server(503, _) = error {} else { throw error }
        }
        try check(calls == 1, "no automatic resend")
        print("PASS stable message ID and no automatic resend")
        print("8/8 core checks passed (mock network; not an iOS UI/device test)")
    }
}
