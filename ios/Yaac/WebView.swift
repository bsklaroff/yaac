import SwiftUI
import WebKit

/**
 * The connected server's webapp. The page is a plain browser on that origin:
 * the server identifies this phone through `tailscale serve` exactly as it
 * does Safari, so nothing here holds a credential.
 *
 * The page gets one bridge, `window.yaacWindow`, with the two calls the SPA
 * makes of a native shell (`windowApi()` in
 * packages/frontend/src/components/WindowControls.tsx): show the server
 * list, and open a link in Safari. Like the desktop shell's, it cannot change
 * which server the app is on, so a server cannot move the app to one it
 * chooses. Navigation away from the origin opens in Safari instead.
 */
struct WebView: UIViewRepresentable {
  let origin: String
  let store: ServerStore

  private static let bridge = """
    window.yaacWindow = {
      showServers: () => window.webkit.messageHandlers.yaac.postMessage({ op: 'showServers' }),
      openExternal: (url) => window.webkit.messageHandlers.yaac.postMessage({ op: 'openExternal', url: String(url) }),
    }
    """

  func makeCoordinator() -> Coordinator { Coordinator(origin: origin, store: store) }

  /*
   * The default data store persists each origin's localStorage, where the
   * SPA keeps its theme, selection and mobile screen. The page pads itself
   * for the notch and home indicator (`viewport-fit=cover`), so the scroll
   * view must not inset it again, and the page never scrolls, so it does not
   * bounce either. Because the page sets `viewport-fit=cover`, WebKit passes
   * the view's own `safeAreaInsets` to it as `env(safe-area-inset-*)`.
   */
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    config.allowsInlineMediaPlayback = true
    config.userContentController.addUserScript(
      WKUserScript(source: Self.bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )
    config.userContentController.add(context.coordinator, name: "yaac")

    let web = FullScreenWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.uiDelegate = context.coordinator
    web.isOpaque = false
    web.backgroundColor = .systemBackground
    web.scrollView.contentInsetAdjustmentBehavior = .never
    web.scrollView.bounces = false
    #if DEBUG
    web.isInspectable = true
    #endif
    if let url = URL(string: origin) { web.load(URLRequest(url: url)) }
    return web
  }

  func updateUIView(_ web: WKWebView, context: Context) {}

  static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
    web.configuration.userContentController.removeScriptMessageHandler(forName: "yaac")
  }

  @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let origin: String
    private let store: ServerStore

    init(origin: String, store: ServerStore) {
      self.origin = origin
      self.store = store
    }

    /// Only the top frame of the connected origin may use the bridge.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      let from = message.frameInfo.securityOrigin
      guard message.frameInfo.isMainFrame,
            Self.origin(scheme: from.`protocol`, host: from.host, port: from.port) == origin,
            let body = message.body as? [String: Any],
            let op = body["op"] as? String
      else { return }
      switch op {
      case "showServers":
        store.showingServers = true
      case "openExternal":
        if let text = body["url"] as? String, let url = URL(string: text) { Self.openInSafari(url) }
      default:
        break
      }
    }

    /// The top frame stays on the origin; a link anywhere else, or to a new
    /// window, opens in Safari. Subframes are left to the page's CSP.
    func webView(
      _ webView: WKWebView,
      decidePolicyFor action: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      guard let url = action.request.url else { return decisionHandler(.cancel) }
      if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
      if action.targetFrame != nil, Self.origin(of: url) == origin { return decisionHandler(.allow) }
      Self.openInSafari(url)
      decisionHandler(.cancel)
    }

    /// `window.open` and `target=_blank` links that reach here open in Safari.
    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for action: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if let url = action.request.url { Self.openInSafari(url) }
      return nil
    }

    /// The server went away between the probe and the load: back to the list.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      let error = error as NSError
      guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
      store.loadFailed(origin, error)
    }

    /// iOS kills a backgrounded page's process under memory pressure, which
    /// leaves the view blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      webView.reload()
    }

    private static func openInSafari(_ url: URL) {
      guard url.scheme == "https" || url.scheme == "http" else { return }
      UIApplication.shared.open(url)
    }

    private static func origin(of url: URL) -> String? {
      guard let scheme = url.scheme, let host = url.host else { return nil }
      return origin(scheme: scheme, host: host, port: url.port ?? 0)
    }

    /// The origin as `ServerStore` writes it: default ports left out.
    private static func origin(scheme: String, host: String, port: Int) -> String {
      let scheme = scheme.lowercased()
      let isDefault = port == 0 || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
      return "\(scheme)://\(host.lowercased())\(isDefault ? "" : ":\(port)")"
    }
  }
}

/**
 * A web view that reports the window's safe area as its own. SwiftUI gives a
 * representable under `.ignoresSafeArea()` zero insets, which would reach
 * the page as zero `env(safe-area-inset-*)` and put its header under the
 * status bar. The view always fills the window, so the window's insets are
 * the page's.
 */
private final class FullScreenWebView: WKWebView {
  override var safeAreaInsets: UIEdgeInsets { window?.safeAreaInsets ?? .zero }

  /// WebKit rereads the insets when told they changed, and they do on
  /// joining a window.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    safeAreaInsetsDidChange()
  }
}
