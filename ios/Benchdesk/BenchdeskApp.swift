import SwiftUI
import BenchdeskCore

@main
struct BenchdeskApp: App {
    @StateObject private var store = StationStore()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store).tint(.green)
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: StationStore
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if store.client == nil { PairView() }
            else { SessionsView().id(store.connectionID) }
        }
        .task(id: "\(phase)-\(store.connectionID)") {
            guard phase == .active, store.client != nil else { return }
            while !Task.isCancelled {
                await store.refresh()
                do { try await Task.sleep(nanoseconds: 3_000_000_000) }
                catch { break }
            }
        }
    }
}

struct PairView: View {
    @EnvironmentObject private var store: StationStore
    @State private var address = ""
    @State private var code = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("benchdesk", systemImage: "square.grid.2x2.fill")
                        .font(.largeTitle.bold()).foregroundStyle(.green)
                    Text("Je werk, binnen handbereik.").font(.title2.weight(.semibold))
                    Text("Verbind je iPhone met Benchdesk op je Mac. Volg je agents en praat verder in dezelfde gesprekken.")
                        .foregroundStyle(.secondary)
                }.listRowBackground(Color.clear)
                Section("Je Mac koppelen") {
                    TextField("https://jouw-mac.ts.net:8443", text: $address)
                        .textContentType(.URL).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("HTTPS-adres van je Mac")
                    TextField("Koppelcode", text: $code)
                        .textContentType(.oneTimeCode).keyboardType(.numberPad)
                    Button {
                        Task { await store.pair(address: address, code: code); code = "" }
                    } label: {
                        HStack {
                            Text(store.busy ? "Verbinden…" : "Verbind met Benchdesk")
                            Spacer()
                            if store.busy { ProgressView() } else { Image(systemName: "arrow.right") }
                        }
                    }.disabled(store.busy || address.isEmpty || code.filter(\.isNumber).count != 8)
                }
                if let error = store.error {
                    Section { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                }
                Section("Hoe werkt het?") {
                    Text("Open de mobiele koppeling op je Mac. Neem het privé-HTTPS-adres en de eenmalige code over. Verbind je iPhone en Mac met hetzelfde Tailscale-netwerk.")
                    Text("Je Mac voert het werk uit. Houd Benchdesk open en je Mac wakker.").foregroundStyle(.secondary)
                }
            }.navigationTitle("Welkom").navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct SessionsView: View {
    @EnvironmentObject private var store: StationStore
    @State private var query = ""
    @State private var showSettings = false
    private var filtered: [MobileSession] {
        store.sessions.filter { query.isEmpty || "\($0.title) \($0.company)".localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(store.online ? "Verbonden met \(store.station)" : "Verbinding herstellen…", systemImage: store.online ? "checkmark.circle.fill" : "wifi.slash")
                        .font(.caption).foregroundStyle(store.online ? Color.green : Color.secondary)
                    if let error = store.error { Text(error).font(.caption).foregroundStyle(.red) }
                }
                Section("Gesprekken") {
                    ForEach(filtered) { session in
                        NavigationLink {
                            ConversationView(session: session)
                        } label: {
                            HStack(spacing: 14) {
                                Text(session.provider == "codex" ? "C" : session.provider == "claude" ? "✳" : ">_")
                                    .font(.headline).frame(width: 42, height: 42)
                                    .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(session.company).font(.caption).foregroundStyle(.secondary)
                                    Text(session.title).font(.headline).lineLimit(2)
                                    Text(session.statusLabel).font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 5)
                        }
                    }
                    if filtered.isEmpty {
                        Text(store.sessions.isEmpty ? "Start een gesprek op je Mac; het verschijnt hier vanzelf." : "Geen gesprekken gevonden.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Benchdesk")
            .searchable(text: $query, prompt: "Gesprek of bedrijf")
            .refreshable { await store.refresh() }
            .toolbar { Button { showSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Instellingen") }
            .sheet(isPresented: $showSettings) { StationSettings() }
        }
    }
}

struct StationSettings: View {
    @EnvironmentObject private var store: StationStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("Basisstation") {
                    Text(store.station)
                    Text(store.client?.origin.absoluteString ?? "").font(.caption).textSelection(.enabled)
                    Text("De koppeling verloopt wanneer de mobiele server op je Mac herstart, of na maximaal dertig dagen.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Button("Ontkoppel deze iPhone", role: .destructive) { Task { await store.disconnect() } }.disabled(store.busy)
                    if !store.online {
                        Button("Verwijder alleen de lokale koppeling", role: .destructive) { store.forget() }
                        Text("Het basisstation is niet bereikbaar. De toegang daar blijft bestaan tot de server herstart of de koppeling verloopt.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = store.error { Text(error).foregroundStyle(.red) }
                }
            }.navigationTitle("Instellingen").toolbar { Button("Gereed") { dismiss() } }
        }
    }
}
