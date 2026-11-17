import XCTest
@testable import BenchdeskCore

final class StubProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, headers, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class CoreTests: XCTestCase {
    let origin = URL(string: "https://mac.example:8443")!
    func client(credential: StationCredential? = nil) throws -> StationClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return try StationClient(origin: origin, credential: credential, configuration: config)
    }
    func credential() -> StationCredential {
        .init(origin: origin, cookieName: "__Host-benchdesk_mobile_123", cookieValue: String(repeating: "a", count: 64), expires: Date().addingTimeInterval(300))
    }
    func testAddressOnlyAcceptsHTTPSOrigins() throws {
        XCTAssertEqual(try StationAddress.parse(" https://Mac.Example:8443/ "), origin)
        for address in ["http://mac.example", "https://user:pass@mac.example", "https://mac.example/path", "https://mac.example?key=secret", "https://mac.example#fragment", "file:///tmp/x", "https://mac.example:0"] {
            XCTAssertThrowsError(try StationAddress.parse(address), address)
        }
    }
    func testCredentialCannotCrossStationOrInjectHeaders() throws {
        XCTAssertThrowsError(try StationClient(origin: URL(string: "https://other.example")!, credential: credential()))
        XCTAssertFalse(StationCredential(origin: origin, cookieName: "__Host-benchdesk_mobile_x\r\nHeader", cookieValue: "x", expires: .distantFuture).isValid)
        XCTAssertFalse(StationCredential(origin: origin, cookieName: "__Host-benchdesk_mobile_x", cookieValue: String(repeating: "a", count: 64), expires: .distantPast).isValid)
    }
    func testPairingUsesExistingOriginCookieContract() async throws {
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/pair")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), self.origin.absoluteString)
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            return (200, ["Set-Cookie": "__Host-benchdesk_mobile_123=\(String(repeating: "a", count: 64)); HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=2592000"], Data("{\"ok\":true}".utf8))
        }
        let paired = try await client().pair(code: "1234 5678")
        XCTAssertTrue(paired.isValid)
        XCTAssertEqual(paired.origin, origin)
    }
    func testSessionsDecodeAndSendOnlyScopedCookie() async throws {
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/sessions")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "__Host-benchdesk_mobile_123=\(String(repeating: "a", count: 64))")
            return (200, [:], Data("{\"station\":\"Mac\",\"sessions\":[]}".utf8))
        }
        let list = try await client(credential: credential()).sessions()
        XCTAssertEqual(list.station, "Mac")
        XCTAssertTrue(list.sessions.isEmpty)
    }
    func testUnauthorizedRequestsRequirePairing() async throws {
        StubProtocol.handler = { _ in (401, [:], Data("{\"error\":\"Koppel opnieuw\"}".utf8)) }
        do { _ = try await client(credential: credential()).sessions(); XCTFail("Expected unauthorized") }
        catch let error as StationError { XCTAssertTrue(error.requiresPairing) }
    }
    func testHistoryReplacesStreamingItemsAndSorts() throws {
        func item(_ text: String, _ id: String = "a", _ order: Int = 1) throws -> ChatItem {
            let data = try JSONSerialization.data(withJSONObject: ["id":id,"order":order,"sequence":order,"kind":"assistant","status":"running","text":text])
            return try JSONDecoder().decode(ChatItem.self, from: data)
        }
        let merged = try ChatHistory.merging([item("old")], [item("second", "b", 2), item("updated")])
        XCTAssertEqual(merged.map(\.text), ["updated", "second"])
    }
    func testTerminalPreviewDropsANSIAndLinkDestinations() {
        XCTAssertEqual(TerminalText.plain("\u{1B}[31mHallo\u{1B}[0m\nwereld"), "Hallo\nwereld")
        XCTAssertEqual(TerminalText.plain("\u{1B}]8;;https://example.com\u{7}Link\u{1B}]8;;\u{7}"), "Link")
    }
    func testMessageKeepsCallerIDAndDoesNotRetryErrors() async throws {
        let id = UUID()
        var calls = 0
        StubProtocol.handler = { request in
            calls += 1
            XCTAssertEqual(request.url?.path, "/api/message")
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream, data.isEmpty {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            }
            let body = try JSONSerialization.jsonObject(with: data) as! [String: String]
            XCTAssertEqual(body["clientMessageId"], id.uuidString.lowercased())
            return (503, [:], Data("{\"error\":\"Onzeker\"}".utf8))
        }
        do { _ = try await client(credential: credential()).send(id: UUID().uuidString, text: "Hallo", messageID: id); XCTFail("Expected failure") }
        catch { XCTAssertEqual(calls, 1) }
    }
}
