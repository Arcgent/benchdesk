import Foundation

public struct MobileSession: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let company: String
    public let provider: String
    public let state: String
    public let alive: Bool
    public let agentRunning: Bool
    public let transport: String
    public let canSend: Bool
    public let memory: String

    public var statusLabel: String {
        if !alive && transport == "pty" { return "Opgeslagen" }
        switch state {
        case "working", "running": return "Aan het werk"
        case "waiting", "idle": return "Wacht op jou"
        case "error": return "Aandacht nodig"
        case "ended", "exited", "stopped", "interrupted": return "Afgesloten"
        default: return alive ? "Actief" : "Opgeslagen"
        }
    }
}

public struct SessionList: Decodable, Sendable {
    public let station: String
    public let sessions: [MobileSession]
}

public struct ChatItem: Decodable, Identifiable, Sendable {
    public let id: String
    public let order: Int
    public let sequence: Int
    public let kind: String
    public let text: String
    public let status: String
    public var needsDesktop: Bool {
        ["approval", "question"].contains(kind) && status == "pending"
    }
}

public struct ChatPage: Decodable, Sendable {
    public let items: [ChatItem]
    public let more: Bool
    public let nextSequence: Int
}

public struct TerminalFrame: Decodable, Sendable {
    public let screen: String
    public let sequence: Int
    public let cols: Int
    public let rows: Int
}

public struct SessionDetail: Decodable, Sendable {
    public let session: MobileSession
    public let frame: TerminalFrame?
    public let chat: ChatPage?
}

public struct SendReceipt: Decodable, Sendable {
    public let queued: Bool?
}

public enum StationError: LocalizedError {
    case invalidAddress, insecureAddress, invalidCode, missingCookie, invalidResponse
    case server(Int, String)
    public var errorDescription: String? {
        switch self {
        case .invalidAddress: return "Vul alleen het HTTPS-adres van je Mac in, inclusief eventuele poort."
        case .insecureAddress: return "Gebruik de privé-HTTPS-verbinding van je Mac."
        case .invalidCode: return "De koppelcode bestaat uit acht cijfers."
        case .missingCookie: return "Koppelen leverde geen geldige toegang op. Vraag een nieuwe code op je Mac."
        case .invalidResponse: return "Het basisstation gaf een onverwacht antwoord."
        case .server(_, let message): return message
        }
    }
    public var requiresPairing: Bool {
        if case .server(401, _) = self { return true }
        return false
    }
}

public enum StationAddress {
    public static func parse(_ value: String) throws -> URL {
        guard let c = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", c.port == nil || (1...65535).contains(c.port!),
              let url = c.url else { throw StationError.invalidAddress }
        var normalized = URLComponents()
        normalized.scheme = "https"
        normalized.host = host.lowercased()
        normalized.port = c.port == 443 ? nil : c.port
        guard let origin = normalized.url, url.scheme == "https" else { throw StationError.insecureAddress }
        return origin
    }
}

// Contains a secret cookie. Persist only in the device Keychain, never defaults/logs.
public struct StationCredential: Codable, Sendable {
    public let origin: URL
    public let cookieName: String
    public let cookieValue: String
    public let expires: Date

    public init(origin: URL, cookieName: String, cookieValue: String, expires: Date) {
        self.origin = origin; self.cookieName = cookieName
        self.cookieValue = cookieValue; self.expires = expires
    }

    public var isValid: Bool {
        guard (try? StationAddress.parse(origin.absoluteString)) == origin else { return false }
        return cookieName.hasPrefix("__Host-benchdesk_mobile_") &&
            cookieName.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") } &&
            cookieValue.count == 64 && cookieValue.allSatisfy { $0.isASCII && $0.isHexDigit } && expires > Date()
    }
}

public enum ChatHistory {
    public static func merging(_ existing: [ChatItem], _ incoming: [ChatItem]) -> [ChatItem] {
        var items = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for item in incoming { items[item.id] = item }
        return items.values.sorted { $0.order == $1.order ? $0.id < $1.id : $0.order < $1.order }
    }
}

public enum TerminalText {
    // Read-only text preview. This does not claim to emulate cursor positioning.
    public static func plain(_ input: String) -> String {
        let patterns = ["\\u{001B}\\][^\\u{0007}\\u{001B}]*(?:\\u{0007}|\\u{001B}\\\\)",
                        "\\u{001B}\\[[0-?]*[ -/]*[@-~]", "\\u{001B}[()][0-2A-Z]", "\\u{001B}[@-_]"]
        var value = input
        // ICU uses hexadecimal escapes rather than Swift's scalar syntax.
        for pattern in patterns {
            let regex = pattern.replacingOccurrences(of: "\\u{001B}", with: "\\x{001B}")
                .replacingOccurrences(of: "\\u{0007}", with: "\\x{0007}")
            value = value.replacingOccurrences(of: regex, with: "", options: .regularExpression)
        }
        return String(value.unicodeScalars.filter { $0.value >= 32 || $0 == "\n" || $0 == "\t" })
    }
}
