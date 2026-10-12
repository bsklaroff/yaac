import SwiftUI
import WebKit

/// A workspace port the webapp asked to preview: the container port the
/// tunnel dials, and the host port the server offers it at, which the phone
/// binds when it is free.
struct Preview: Identifiable, Equatable {
  let workspaceId: String
  let containerPort: Int
  let hostPort: Int
  var id: String { "\(workspaceId):\(containerPort)" }
}

/**
 * A workspace's dev server, full screen over the webapp (ios/README.md
 * "Previews"). While it shows, a `PortForward` holds the port on this
 * phone's loopback, and the page loads from `http://127.0.0.1:<port>/`.
 */
struct PreviewView: View {
  let preview: Preview
  let close: () -> Void
  @State private var model: PreviewModel
  @Environment(\.scenePhase) private var scenePhase

  init(origin: String, preview: Preview, close: @escaping () -> Void) {
    self.preview = preview
    self.close = close
    _model = State(initialValue: PreviewModel(origin: origin, preview: preview))
  }

  var body: some View {
    NavigationStack {
      Group {
        if let url = model.url {
          PreviewWebView(url: url, model: model)
            .id(url)
            .ignoresSafeArea(edges: .bottom)
        } else if let failure = model.failure {
          ContentUnavailableView(
            "Can't preview :\(preview.containerPort)",
            systemImage: "exclamationmark.triangle",
            description: Text(failure)
          )
        } else {
          ProgressView()
        }
      }
      .safeAreaInset(edge: .top) {
        if let error = model.tunnelError {
          Text("Couldn't reach :\(preview.containerPort) in the workspace: \(error)")
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal)
            .padding(.vertical, 6)
            .background(.bar)
        }
      }
      .navigationTitle(model.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done", action: close)
        }
        ToolbarItemGroup(placement: .primaryAction) {
          Button { model.web?.goBack() } label: { Image(systemName: "chevron.backward") }
            .disabled(!model.canGoBack)
            .accessibilityLabel("Back")
          Button {
            model.tunnelError = nil
            model.web?.reload()
          } label: { Image(systemName: "arrow.clockwise") }
            .accessibilityLabel("Reload")
        }
      }
    }
    .task { await model.start() }
    .onDisappear { model.stop() }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background: model.suspend()
      case .active: Task { await model.resume() }
      default: break
      }
    }
  }
}

@MainActor @Observable
final class PreviewModel {
  /// The page to load while the port is bound. Nil while it is not, so no
  /// web view keeps a page up on a port the phone no longer holds.
  private(set) var url: URL?
  /// Why the port could not be bound.
  private(set) var failure: String?
  /// The last connection the server could not dial.
  var tunnelError: String?
  private(set) var title: String
  private(set) var canGoBack = false
  @ObservationIgnored weak var web: WKWebView?
  /// The page's storage, kept across the web views `resume` rebuilds and
  /// dropped with the preview.
  let dataStore = WKWebsiteDataStore.nonPersistent()
  private let forward: PortForward?
  private let preview: Preview
  /// The port held, or held last before the app went to the background.
  private var port: UInt16 = 0
  /// Where the page was when the app went to the background.
  private var resumeAt: URL?
  private var listening = false

  init(origin: String, preview: Preview) {
    self.preview = preview
    title = ":\(preview.containerPort)"
    forward = PortForward(origin: origin, workspaceId: preview.workspaceId, containerPort: preview.containerPort)
  }

  func start() async {
    guard let forward else {
      failure = "The server's address is not https."
      return
    }
    forward.onError = { [weak self] message in self?.tunnelError = message }
    await listen()
  }

  /**
   * A backgrounded app is suspended while other apps run, and any of them
   * could bind the port and serve the page's origin. So the listener and
   * the web view both go now, and `resume` brings them back.
   */
  func suspend() {
    guard url != nil else { return }
    resumeAt = web?.url.flatMap { isOwn($0) ? $0 : nil }
    url = nil
    forward?.pause()
  }

  /// Listen again, on the same port when it is still free, and reopen the
  /// page where it was; on another port, from its start.
  func resume() async {
    guard url == nil, failure == nil else { return }
    await listen()
  }

  func stop() { forward?.stop() }

  /// Title the page, or name its host once it has left the preview's own
  /// address, so a page elsewhere cannot pass for the dev server.
  func navigated(_ web: WKWebView) {
    canGoBack = web.canGoBack
    guard let at = web.url else { return }
    if isOwn(at) {
      title = web.title.flatMap { $0.isEmpty ? nil : $0 } ?? ":\(preview.containerPort)"
    } else {
      title = at.host ?? at.absoluteString
    }
  }

  private func listen() async {
    guard let forward, !listening else { return }
    listening = true
    defer { listening = false }
    let preferred = port != 0 ? port : UInt16(clamping: preview.hostPort)
    do {
      let bound = try await forward.start(preferred: preferred)
      let page = bound == port ? resumeAt : nil
      port = bound
      resumeAt = nil
      url = page ?? URL(string: "http://127.0.0.1:\(bound)/")
    } catch is CancellationError {
      // Paused or stopped meanwhile; `resume` listens again.
    } catch {
      failure = "Could not listen on this phone: \(error.localizedDescription)"
    }
  }

  private func isOwn(_ url: URL) -> Bool {
    url.host == "127.0.0.1" && url.port == Int(port)
  }
}

/**
 * The preview's web view. The dev server runs repo code, so it gets a data
 * store of its own and no bridge, and every page it opens loads here.
 */
private struct PreviewWebView: UIViewRepresentable {
  let url: URL
  let model: PreviewModel

  func makeCoordinator() -> Coordinator { Coordinator(model: model) }

  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = model.dataStore
    config.allowsInlineMediaPlayback = true
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.uiDelegate = context.coordinator
    web.allowsBackForwardNavigationGestures = true
    #if DEBUG
    web.isInspectable = true
    #endif
    model.web = web
    web.load(URLRequest(url: url))
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}

  @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    private let model: PreviewModel

    init(model: PreviewModel) { self.model = model }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
      model.navigated(webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      model.navigated(webView)
    }

    /// `window.open` and `target=_blank` load in place.
    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for action: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      webView.load(action.request)
      return nil
    }

    /// iOS kills a backgrounded page's process under memory pressure.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      webView.reload()
    }
  }
}
