import XCTest
@testable import Yaac

/*
 * Where a preview's tunnel connects. The tunnel itself needs a server and a
 * device; ios/README.md "Verifying by hand" covers it.
 */

final class PortForwardTests: XCTestCase {
  func testAttachURLNamesTheWorkspacePortOnTheServer() {
    XCTAssertEqual(
      PortForward.attachURL(origin: "https://srv.tail1234.ts.net", workspaceId: "ws-1", containerPort: 5173)?.absoluteString,
      "wss://srv.tail1234.ts.net/api/forward/attach?id=ws-1&port=5173"
    )
    XCTAssertEqual(
      PortForward.attachURL(origin: "https://srv.tail1234.ts.net:8443", workspaceId: "a b", containerPort: 3000)?.absoluteString,
      "wss://srv.tail1234.ts.net:8443/api/forward/attach?id=a%20b&port=3000"
    )
    XCTAssertNil(PortForward.attachURL(origin: "http://127.0.0.1:8787", workspaceId: "ws-1", containerPort: 3000))
  }
}
