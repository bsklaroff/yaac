import SwiftUI

/**
 * The server list, the app's counterpart of the desktop shell's Servers page
 * (docs/server-selection.md "The desktop shell"): the saved servers with what
 * each answered, a field to add one by address, and the QR scanner.
 */
struct ServersView: View {
  @Bindable var store: ServerStore
  @State private var address = ""
  @State private var scanning = false
  @State private var removing: String?

  var body: some View {
    NavigationStack {
      List {
        if let failure = store.failure {
          Section {
            Text(failure).font(.callout).foregroundStyle(.red)
          }
        }
        Section("Servers") {
          if store.saved.isEmpty {
            Text("No servers yet. On a computer, open your server's webapp and scan the QR code "
              + "in Settings → General, or type the server's address below.")
              .font(.callout)
              .foregroundStyle(.secondary)
          }
          ForEach(store.saved, id: \.self) { row($0) }
        }
        Section {
          TextField("srv.tailnet.ts.net", text: $address)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit(add)
          Button("Add server", action: add)
            .disabled(ServerStore.origin(from: address) == nil)
          Button {
            scanning = true
          } label: {
            Label("Scan QR code", systemImage: "qrcode.viewfinder")
          }
        } footer: {
          Text("Addresses are https, as tailscale serve provides. This phone reaches a server over "
            + "your tailnet, so the Tailscale app must be connected.")
        }
      }
      .navigationTitle("Servers")
      .toolbar {
        if let connected = store.connected {
          ToolbarItem(placement: .cancellationAction) {
            Button("Back to \(ServerStore.label(connected))") { store.showingServers = false }
          }
        }
      }
      .disabled(store.busy)
      .task { await store.probeAll() }
      .refreshable { await store.probeAll() }
      .sheet(isPresented: $scanning) {
        QRScannerSheet { text in
          scanning = false
          store.offer(text)
        }
      }
      .alert(
        "Add \(store.offered.map(ServerStore.label) ?? "server")?",
        isPresented: Binding(get: { store.offered != nil }, set: { if !$0 { store.offered = nil } }),
        presenting: store.offered
      ) { origin in
        Button("Add") { Task { await store.connect(origin) } }
        Button("Cancel", role: .cancel) {}
      } message: { origin in
        Text("Connect to \(origin)? Only add servers you trust: the app shows whatever page it serves.")
      }
      .confirmationDialog(
        "Remove \(removing.map(ServerStore.label) ?? "server")?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
        titleVisibility: .visible,
        presenting: removing
      ) { origin in
        Button("Remove", role: .destructive) { store.remove(origin) }
      }
    }
  }

  private func add() {
    guard let origin = ServerStore.origin(from: address) else { return }
    address = ""
    Task { await store.connect(origin) }
  }

  /// Tap connects. The selected server can be disconnected but not removed,
  /// as on the desktop; any other can be removed.
  private func row(_ origin: String) -> some View {
    Button {
      Task { await store.connect(origin) }
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(ServerStore.label(origin)).foregroundStyle(.primary)
          Text(status(origin)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        Spacer()
        if origin == store.connected {
          Image(systemName: "checkmark").foregroundStyle(.green)
        }
      }
    }
    .swipeActions {
      if origin == store.selected {
        Button("Disconnect") { store.disconnect() }
      } else {
        Button("Remove", role: .destructive) { removing = origin }
      }
    }
  }

  private func status(_ origin: String) -> String {
    switch store.health[origin] {
    case nil: return "Checking…"
    case .ok(let login): return login.map { "Signed in as \($0)" } ?? "Reachable"
    case .stopped(let why): return "Stopped: \(why)"
    case .refused(let why): return "Refused: \(why)"
    }
  }
}
