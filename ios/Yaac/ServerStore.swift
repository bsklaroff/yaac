import Foundation
import Observation

/// What the last probe of a saved server found.
enum Health: Equatable {
  /// It identified this phone, as `login` (nil for a `local` install's owner).
  case ok(login: String?)
  /// No answer, or not a yaac server.
  case stopped(String)
  /// It answered but would not identify this phone; the reason is the server's.
  case refused(String)
}

/**
 * The saved servers and which one is selected: the rules of the CLI's
 * `~/.yaac-client/server.json` (docs/server-selection.md), kept in
 * UserDefaults. A server is selected only after it answers `/api/whoami` for
 * this phone, so the selection is never one that will not, and every
 * selection moves its origin to the front of the list.
 */
@MainActor @Observable
final class ServerStore {
  /// Every saved origin, the most recently selected first.
  private(set) var saved: [String]
  private(set) var selected: String?
  /// The origin the web view shows; nil shows the list full screen.
  private(set) var connected: String?
  /// Why the list is showing instead of a server.
  var failure: String?
  var health: [String: Health] = [:]
  /// An origin from a scan or a `yaac://` link, waiting for the user to agree.
  var offered: String?
  /// The list is open over the connected server's page.
  var showingServers = false
  /// The launch probe has not answered yet.
  private(set) var launching = true
  /// A connect is in flight.
  private(set) var busy = false

  private let defaults: UserDefaults
  private let session: URLSession

  private static let savedKey = "servers.saved"
  private static let selectedKey = "servers.selected"

  init(defaults: UserDefaults = .standard, session: URLSession = ServerStore.probeSession) {
    self.defaults = defaults
    self.session = session
    saved = defaults.stringArray(forKey: Self.savedKey) ?? []
    selected = defaults.string(forKey: Self.selectedKey)
  }

  /// No cookies or cache, and the desktop's 5-second probe timeout.
  nonisolated static let probeSession: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 5
    return URLSession(configuration: config)
  }()

  /// Connect to the selected server, if there is one. A link that opened
  /// the app is offered, or refused, over it once it is up.
  func launch() async {
    defer { launching = false }
    let linkFailure = failure
    if let selected { await connect(selected) }
    if connected != nil && (offered != nil || linkFailure != nil) {
      failure = linkFailure
      showingServers = true
    }
  }

  /**
   * Probe `origin` and, when it identifies this phone, save it, select it and
   * show it. Connect on the selected origin is a real retry, which is how the
   * list reaches a server that has come back. An origin that fails is not
   * saved; the failure shows above the list.
   */
  func connect(_ origin: String) async {
    busy = true
    defer { busy = false }
    let found = await probe(origin)
    health[origin] = found
    guard case .ok = found else {
      failure = Self.describe(found, origin)
      return
    }
    saved = [origin] + saved.filter { $0 != origin }
    selected = origin
    persist()
    failure = nil
    connected = origin
    showingServers = false
    if offered == origin { offered = nil }
  }

  /// Forget a saved server. The selected one is refused: disconnect or
  /// switch first, as on the desktop.
  func remove(_ origin: String) {
    guard origin != selected else { return }
    saved.removeAll { $0 == origin }
    health[origin] = nil
    persist()
  }

  /// Deselect without forgetting, as `yaac remote disconnect` does.
  func disconnect() {
    selected = nil
    connected = nil
    failure = nil
    showingServers = false
    persist()
  }

  /// The web view could not load the connected server.
  func loadFailed(_ origin: String, _ error: Error) {
    guard connected == origin else { return }
    connected = nil
    showingServers = false
    failure = "Could not connect to \(origin): \(Self.describe(error))"
  }

  /**
   * A scanned code or an opened `yaac://` link. It is only offered, never
   * connected to at once: any page can carry such a link, and the app trusts
   * the server it shows with everything typed into it.
   */
  func offer(_ link: String) {
    if let origin = Self.origin(fromLink: link) {
      offered = origin
    } else {
      failure = "\(link) does not name a server this app can reach. It connects only to https "
        + "addresses, which tailscale serve provides."
    }
    if connected != nil { showingServers = true }
  }

  /// Probe every saved server at once, for the list's status lines.
  func probeAll() async {
    await withTaskGroup(of: (String, Health).self) { group in
      for origin in saved {
        group.addTask { (origin, await self.probe(origin)) }
      }
      for await (origin, found) in group { health[origin] = found }
    }
  }

  /**
   * `GET /api/whoami`. A 2xx naming a user is a yaac server that identifies
   * this phone; a 401 is one that will not, with its reason.
   */
  func probe(_ origin: String) async -> Health {
    guard let url = URL(string: origin + "/api/whoami") else { return .stopped("Not a URL") }
    do {
      let (data, response) = try await session.data(from: url)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status == 401 || status == 403 {
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        return .refused(body?.error.message ?? "HTTP \(status)")
      }
      guard (200..<300).contains(status) else { return .stopped("HTTP \(status)") }
      guard let me = try? JSONDecoder().decode(Whoami.self, from: data) else {
        return .stopped("Not a yaac server")
      }
      return .ok(login: me.login)
    } catch {
      return .stopped(Self.describe(error))
    }
  }

  private func persist() {
    defaults.set(saved, forKey: Self.savedKey)
    defaults.set(selected, forKey: Self.selectedKey)
  }

  private struct Whoami: Decodable {
    let userId: String
    let login: String?
  }

  private struct ErrorBody: Decodable {
    struct Detail: Decodable { let message: String }
    let error: Detail
  }

  /**
   * An origin from what a user typed or scanned: https only, path and query
   * dropped, host lowercased, default port left out. A bare host gets
   * `https://`, since that is what people type. A phone reaches a server
   * through `tailscale serve`, which is always https on a `*.ts.net` name.
   *
   * The host must be plain ASCII letters, digits, dots and hyphens.
   * `URLComponents.host` is percent-decoded, so without the check a link
   * could smuggle in an `@` or `/` (`%40`, `%2F`) and the confirmation would
   * show one host while the probe asks another; a Unicode host could pass
   * for a look-alike, and would never equal WebKit's punycode origin. IP
   * literals are refused with the rest, since none can carry a publicly
   * trusted certificate.
   */
  nonisolated static func origin(from input: String) -> String? {
    var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.contains("://") { text = "https://" + text }
    guard let url = URLComponents(string: text),
          url.scheme?.lowercased() == "https",
          let host = url.host?.lowercased(),
          host.range(of: "^[a-z0-9.-]+\\z", options: .regularExpression) != nil,
          host.contains(where: \.isLetter)
    else { return nil }
    let port = url.port.map { $0 == 443 ? "" : ":\($0)" } ?? ""
    return "https://\(host)\(port)"
  }

  /**
   * The origin a scanned code or an opened link names: the webapp's
   * `yaac://connect?origin=<origin>` (`phoneLink` in
   * packages/frontend/src/components/settings/PhoneLink.tsx), or a plain
   * https URL.
   */
  nonisolated static func origin(fromLink text: String) -> String? {
    if let link = URLComponents(string: text), link.scheme == "yaac" {
      guard link.host == "connect",
            let origin = link.queryItems?.first(where: { $0.name == "origin" })?.value
      else { return nil }
      return Self.origin(from: origin)
    }
    guard text.lowercased().hasPrefix("https://") else { return nil }
    return Self.origin(from: text)
  }

  /// host[:port], as the webapp's server badge names a server.
  nonisolated static func label(_ origin: String) -> String {
    guard let url = URLComponents(string: origin), let host = url.host else { return origin }
    return url.port.map { "\(host):\($0)" } ?? host
  }

  /// A network failure in words, naming Tailscale when nothing answered:
  /// a phone reaches every server over the tailnet.
  nonisolated static func describe(_ error: Error) -> String {
    let unanswered: [URLError.Code] = [
      .cannotFindHost, .cannotConnectToHost, .timedOut, .networkConnectionLost,
      .notConnectedToInternet, .dnsLookupFailed,
    ]
    if let error = error as? URLError, unanswered.contains(error.code) {
      return "no answer. Is the Tailscale app connected?"
    }
    return error.localizedDescription
  }

  nonisolated static func describe(_ health: Health, _ origin: String) -> String {
    switch health {
    case .ok: return ""
    case .stopped(let why): return "Could not connect to \(origin): \(why)"
    case .refused(let why): return "\(origin) refused to identify this phone: \(why)"
    }
  }
}
