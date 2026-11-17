import SwiftUI
import BenchdeskCore

struct ConversationView: View {
    let session: MobileSession
    @EnvironmentObject private var store: StationStore
    @Environment(\.scenePhase) private var phase
    @State private var detail: SessionDetail?
    @State private var items: [ChatItem] = []
    @State private var sequence = 0
    @State private var error: String?
    @State private var connected = false

    private var draft: StationStore.Draft { store.drafts[session.id] ?? .init() }
    private var message: Binding<String> {
        Binding(get: { draft.text }, set: { store.drafts[session.id, default: .init()].text = $0 })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(session.company.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text((detail?.session ?? session).statusLabel).font(.subheadline).foregroundStyle(.secondary)
                if let memory = detail?.session.memory, !memory.isEmpty {
                    DisclosureGroup("Waar we waren gebleven") {
                        Text(memory).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.padding().background(Color.green.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                }
                if let frame = detail?.frame {
                    Text("Terminal · tekstweergave").font(.caption).foregroundStyle(.secondary)
                    ScrollView(.horizontal) {
                        Text(TerminalText.plain(frame.screen))
                            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false).padding()
                    }.background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                    Text("De interactieve terminal en toestemmingsvragen bedien je op je Mac.").font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(items) { item in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.kind == "user" ? "Jij" : item.kind == "assistant" ? "Assistent" : "Benchdesk")
                                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(item.text.isEmpty && item.status == "running" ? "Bezig…" : item.text)
                                .textSelection(.enabled)
                            if item.needsDesktop {
                                Label("Beantwoord deze vraag op je Mac.", systemImage: "desktopcomputer")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding()
                            .background(item.kind == "user" ? Color.green.opacity(0.1) : Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
                    }
                    if detail == nil { ProgressView("Gesprek ophalen…") }
                    else if items.isEmpty { Text("Dit gesprek heeft nog geen berichten.").foregroundStyle(.secondary) }
                }
                if let error { Text(error).foregroundStyle(.red).font(.callout) }
                if let error = draft.error { Text(error).foregroundStyle(.red).font(.callout) }
                if let receipt = draft.receipt { Text(receipt).foregroundStyle(.green).font(.callout) }
            }.padding()
        }
        .navigationTitle(session.title).navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                TextField(detail?.session.canSend == true ? "Praat verder…" : "Hervat dit gesprek op je Mac", text: message, axis: .vertical)
                    .lineLimit(2...5).padding(10).background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    .disabled(draft.sending || detail?.session.canSend != true)
                HStack {
                    Text("Uitvoering op je Mac").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button { Task { await store.send(sessionID: session.id) } } label: {
                        Label(draft.sending ? "Versturen…" : "Verstuur", systemImage: "arrow.up")
                    }.buttonStyle(.borderedProminent)
                        .disabled(draft.sending || !connected || detail?.session.canSend != true || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }.padding().background(.regularMaterial)
        }
        .task(id: "\(session.id)-\(phase)-\(store.connectionID)") {
            guard phase == .active, let client = store.client else { return }
            let identity = store.connectionID
            while !Task.isCancelled && identity == store.connectionID {
                var delay: UInt64 = 2_000_000_000
                do {
                    let response = try await client.detail(id: session.id, after: sequence)
                    guard !Task.isCancelled, identity == store.connectionID else { return }
                    detail = response; connected = true; error = nil
                    if let chat = response.chat {
                        items = ChatHistory.merging(items, chat.items)
                        sequence = chat.nextSequence
                        if chat.more { delay = 30_000_000 }
                    }
                } catch {
                    guard !Task.isCancelled, identity == store.connectionID else { return }
                    connected = false
                    self.error = "Gesprek niet bereikbaar. \(error.localizedDescription)"
                    if (error as? StationError)?.requiresPairing == true { store.handle(error); return }
                    delay = 4_000_000_000
                }
                do { try await Task.sleep(nanoseconds: delay) } catch { return }
            }
        }
    }

}
