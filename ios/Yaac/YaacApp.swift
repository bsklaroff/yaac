import SwiftUI

/*
 * The iPhone app: a list of yaac servers, and the selected one's webapp
 * full screen (ios/README.md). The webapp always comes from the server, so
 * the app never needs an update when the SPA changes.
 */

@main
struct YaacApp: App {
  @State private var store = ServerStore()

  var body: some Scene {
    WindowGroup {
      RootView(store: store)
        .onOpenURL { store.offer($0.absoluteString) }
    }
  }
}

/**
 * The connected server's page, or the server list when there is none. Over
 * a connected page the list is a sheet, so closing it uncovers the page as it
 * was, sockets and scroll position included.
 */
struct RootView: View {
  @Bindable var store: ServerStore

  var body: some View {
    Group {
      if store.launching {
        ProgressView()
      } else if let origin = store.connected {
        WebView(origin: origin, store: store)
          .id(origin)
          .ignoresSafeArea()
      } else {
        ServersView(store: store)
      }
    }
    .sheet(isPresented: $store.showingServers) {
      ServersView(store: store)
    }
    .task { await store.launch() }
  }
}
