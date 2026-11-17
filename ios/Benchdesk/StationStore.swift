import SwiftUI
import Security
import BenchdeskCore

enum CredentialVault {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "nl.benchdesk.ios.station",
         kSecAttrAccount as String: "paired-station"]
    }
    static func load() -> StationCredential? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let credential = try? JSONDecoder().decode(StationCredential.self, from: data),
              credential.isValid else { return nil }
        return credential
    }
    static func save(_ credential: StationCredential) throws {
        let value: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(credential),
                                   kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(value) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: "BenchdeskKeychain", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "De beveiligde koppeling kon niet worden opgeslagen."])
        }
    }
    static func clear() { SecItemDelete(query as CFDictionary) }
}

@MainActor
final class StationStore: ObservableObject {
    struct Draft {
        var text = ""
        var pending: (text: String, id: UUID)?
        var sending = false
        var error: String?
        var receipt: String?
    }
    // Memory only: survives navigation, not app termination or unpairing.
    @Published var drafts: [String: Draft] = [:]
    @Published private(set) var client: StationClient?
    @Published private(set) var connectionID = UUID()
    @Published var sessions: [MobileSession] = []
    @Published var station = "Je Mac"
    @Published var error: String?
    @Published var online = false
    @Published var busy = false

    init() {
        if let credential = CredentialVault.load() {
            client = try? StationClient(origin: credential.origin, credential: credential)
        }
    }

    func pair(address: String, code: String) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let origin = try StationAddress.parse(address)
            let unauthenticated = try StationClient(origin: origin)
            let credential = try await unauthenticated.pair(code: code)
            try CredentialVault.save(credential)
            client = try StationClient(origin: origin, credential: credential)
            connectionID = UUID()
            await refresh()
        } catch { self.error = error.localizedDescription }
    }

    func refresh() async {
        guard let client else { return }
        let identity = connectionID
        do {
            let result = try await client.sessions()
            guard !Task.isCancelled, identity == connectionID else { return }
            sessions = result.sessions; station = result.station; online = true; error = nil
        } catch {
            guard !Task.isCancelled, identity == connectionID else { return }
            handle(error)
        }
    }

    func handle(_ failure: Error) {
        online = false
        if (failure as? StationError)?.requiresPairing == true { forget() }
        error = failure is URLError ? "Je Mac is niet bereikbaar. Houd hem wakker en controleer Tailscale." : failure.localizedDescription
    }

    func disconnect() async {
        guard let client, !busy else { return }
        busy = true
        defer { busy = false }
        do { try await client.logout(); forget() }
        catch { handle(error) }
    }

    func send(sessionID: String) async {
        guard let client, drafts[sessionID]?.sending != true else { return }
        let identity = connectionID
        let text = (drafts[sessionID]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf16.count <= 30000 else {
            drafts[sessionID, default: Draft()].error = "Gebruik maximaal 30.000 tekens."
            return
        }
        if drafts[sessionID]?.pending?.text != text {
            drafts[sessionID, default: Draft()].pending = (text, UUID())
        }
        guard let attempt = drafts[sessionID]?.pending else { return }
        drafts[sessionID, default: Draft()].sending = true
        drafts[sessionID, default: Draft()].error = nil
        drafts[sessionID, default: Draft()].receipt = nil
        do {
            let result = try await client.send(id: sessionID, text: attempt.text, messageID: attempt.id)
            guard identity == connectionID else { return }
            drafts[sessionID] = Draft(receipt: result.queued == true ? "Bericht staat klaar voor je agent." : "Bericht afgeleverd op je Mac.")
        } catch {
            guard identity == connectionID else { return }
            drafts[sessionID, default: Draft()].sending = false
            drafts[sessionID, default: Draft()].error = "Versturen niet bevestigd. Controleer het gesprek; opnieuw proberen met dezelfde tekst gebruikt hetzelfde bericht-ID. \(error.localizedDescription)"
            if (error as? StationError)?.requiresPairing == true { handle(error) }
        }
    }

    func forget() {
        CredentialVault.clear(); client = nil; connectionID = UUID()
        sessions = []; drafts = [:]; station = "Je Mac"; online = false
    }
}
