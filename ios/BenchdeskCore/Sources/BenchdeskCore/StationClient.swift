import Foundation

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public final class StationClient: @unchecked Sendable {
    public let origin: URL
    private let credential: StationCredential?
    private let session: URLSession

    public init(origin: URL, credential: StationCredential? = nil, configuration: URLSessionConfiguration = .ephemeral) throws {
        self.origin = try StationAddress.parse(origin.absoluteString)
        if let credential, (!credential.isValid || credential.origin != self.origin) {
            throw StationError.missingCookie
        }
        self.credential = credential
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    private func request(_ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil) async throws -> (Data, HTTPURLResponse) {
        var components = URLComponents(url: origin.appendingPathComponent("api/" + path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let credential {
            guard credential.isValid else { throw StationError.server(401, "Koppel je iPhone opnieuw met je Mac.") }
            request.setValue("\(credential.cookieName)=\(credential.cookieValue)", forHTTPHeaderField: "Cookie")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw StationError.invalidResponse }
        guard (200...299).contains(response.statusCode) else {
            struct Failure: Decodable { let error: String }
            let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? "Het basisstation is niet bereikbaar (\(response.statusCode))."
            throw StationError.server(response.statusCode, message)
        }
        return (data, response)
    }

    public func pair(code: String) async throws -> StationCredential {
        let code = code.filter { !$0.isWhitespace }
        guard code.count == 8, code.allSatisfy({ $0.isASCII && $0.isNumber }) else { throw StationError.invalidCode }
        let (_, response) = try await request("pair", body: ["code": code])
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { fields, entry in
            if let key = entry.key as? String, let value = entry.value as? String { fields[key] = value }
        }
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: origin)
            .first(where: { $0.name.hasPrefix("__Host-benchdesk_mobile_") && $0.isSecure && $0.path == "/" && $0.domain == origin.host }),
              let expires = cookie.expiresDate else { throw StationError.missingCookie }
        let result = StationCredential(origin: origin, cookieName: cookie.name, cookieValue: cookie.value, expires: expires)
        guard result.isValid else { throw StationError.missingCookie }
        return result
    }

    public func sessions() async throws -> SessionList {
        let (data, _) = try await request("sessions")
        return try JSONDecoder().decode(SessionList.self, from: data)
    }

    public func detail(id: String, after: Int) async throws -> SessionDetail {
        let (data, _) = try await request("session", query: [.init(name: "id", value: id), .init(name: "after", value: String(after))])
        return try JSONDecoder().decode(SessionDetail.self, from: data)
    }

    public func send(id: String, text: String, messageID: UUID) async throws -> SendReceipt {
        let (data, _) = try await request("message", body: ["id": id, "message": text, "clientMessageId": messageID.uuidString.lowercased()])
        return try JSONDecoder().decode(SendReceipt.self, from: data)
    }

    public func logout() async throws { _ = try await request("logout", body: [:]) }
}
