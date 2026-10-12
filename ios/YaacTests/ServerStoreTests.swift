import XCTest
@testable import Yaac

/*
 * ServerStore against a stubbed network: what it accepts as an origin, and
 * that it saves and selects only a server that identifies this phone.
 */

final class ServerStoreTests: XCTestCase {
  func testOriginTakesWhatPeopleTypeAndOnlyHttps() {
    XCTAssertEqual(ServerStore.origin(from: "srv.tail1234.ts.net"), "https://srv.tail1234.ts.net")
    XCTAssertEqual(
      ServerStore.origin(from: " HTTPS://Srv.Tail1234.ts.net:443/some/path?q=1 "),
      "https://srv.tail1234.ts.net"
    )
    XCTAssertEqual(ServerStore.origin(from: "https://srv.tail1234.ts.net:8443"), "https://srv.tail1234.ts.net:8443")
    XCTAssertNil(ServerStore.origin(from: "http://127.0.0.1:8787"))
    XCTAssertNil(ServerStore.origin(from: ""))
    XCTAssertEqual(ServerStore.label("https://srv.tail1234.ts.net:8443"), "srv.tail1234.ts.net:8443")
  }

  func testLinksNameAnOriginInEitherForm() {
    XCTAssertEqual(
      ServerStore.origin(fromLink: "yaac://connect?origin=https%3A%2F%2Fsrv.tail1234.ts.net"),
      "https://srv.tail1234.ts.net"
    )
    XCTAssertEqual(ServerStore.origin(fromLink: "https://srv.tail1234.ts.net/?project=p"), "https://srv.tail1234.ts.net")
    XCTAssertNil(ServerStore.origin(fromLink: "yaac://other?origin=https%3A%2F%2Fsrv.tail1234.ts.net"))
    XCTAssertNil(ServerStore.origin(fromLink: "yaac://connect?origin=http%3A%2F%2F127.0.0.1%3A8787"))
    XCTAssertNil(ServerStore.origin(fromLink: "srv.tail1234.ts.net"))
    XCTAssertNil(ServerStore.origin(fromLink: "WIFI:S:home;T:WPA;P:secret;;"))
  }

  /// A link must not show one host and reach another, nor save an origin
  /// WebKit's checks can never match.
  func testHostIsPlainAsciiName() {
    XCTAssertEqual(ServerStore.origin(from: "https://good.ts.net@evil.example"), "https://evil.example")
    XCTAssertNil(ServerStore.origin(fromLink: "yaac://connect?origin=https%3A%2F%2Fsrv.tail1234.ts.net%2540evil.example"))
    XCTAssertNil(ServerStore.origin(from: "https://good.ts.net%2F.evil"))
    XCTAssertNil(ServerStore.origin(from: "https://good.ts.net%0A"))
    XCTAssertNil(ServerStore.origin(from: "https://srv.t\u{0430}il1234.ts.net"))
    XCTAssertNil(ServerStore.origin(from: "https://100.64.0.1"))
    XCTAssertNil(ServerStore.origin(from: "https://[fd7a:115c:a1e0::1]"))
  }

  @MainActor
  func testSelectsOnlyAServerThatIdentifiesThisPhone() async {
    StubServers.answers = [
      "up.ts.net": (200, #"{"kind":"tailnet","userId":"u1","login":"ada@example.com","name":"Ada","users":[]}"#),
      "refuses.ts.net": (401, #"{"error":{"message":"no tailnet identity"}}"#),
      "lookalike.ts.net": (200, "<html></html>"),
    ]
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let store = ServerStore(defaults: defaults, session: StubServers.session)

    await store.connect("https://refuses.ts.net")
    XCTAssertEqual(store.health["https://refuses.ts.net"], .refused("no tailnet identity"))
    await store.connect("https://lookalike.ts.net")
    XCTAssertEqual(store.health["https://lookalike.ts.net"], .stopped("Not a yaac server"))
    await store.connect("https://gone.ts.net")
    XCTAssertTrue(store.failure?.contains("Tailscale") ?? false)
    XCTAssertEqual(store.saved, [])
    XCTAssertNil(store.selected)
    XCTAssertNil(store.connected)

    store.offer("yaac://connect?origin=http%3A%2F%2Fup.ts.net")
    XCTAssertNil(store.offered)
    XCTAssertTrue(store.failure?.contains("https") ?? false, "a refused link says why")

    store.offer("yaac://connect?origin=https%3A%2F%2Fup.ts.net")
    XCTAssertEqual(store.offered, "https://up.ts.net")
    await store.connect("https://up.ts.net")
    XCTAssertEqual(store.health["https://up.ts.net"], .ok(login: "ada@example.com"))
    XCTAssertEqual(store.connected, "https://up.ts.net")
    XCTAssertNil(store.offered)
    XCTAssertNil(store.failure)

    let relaunched = ServerStore(defaults: defaults, session: StubServers.session)
    XCTAssertEqual(relaunched.saved, ["https://up.ts.net"])
    XCTAssertEqual(relaunched.selected, "https://up.ts.net")

    store.remove("https://up.ts.net")
    XCTAssertEqual(store.saved, ["https://up.ts.net"], "the selected server is not removed")
    store.disconnect()
    store.remove("https://up.ts.net")
    XCTAssertEqual(store.saved, [])
  }
}

/// Answers by host: a status and body, or no answer at all for any other host.
final class StubServers: URLProtocol {
  nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]

  static let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubServers.self]
    return URLSession(configuration: config)
  }()

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let answer = Self.answers[url.host ?? ""] else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
      return
    }
    let response = HTTPURLResponse(url: url, statusCode: answer.0, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(answer.1.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
