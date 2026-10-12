import Foundation
import Network

/**
 * A workspace's forwarded port, held on this phone's loopback while a preview
 * shows it (ios/README.md "Previews"). It is the Swift twin of `startForward`
 * in packages/shared/src/port-tunnel.ts: each accepted connection opens its
 * own WebSocket to the server's `/api/forward/attach`, and each binary
 * message carries the next bytes of that one connection.
 *
 * The WebSocket goes through `tailscale serve` like the page's own requests,
 * so the server identifies this phone's owner, and admits only the
 * workspace's owner. The app holds no credential for it either.
 *
 * Every callback runs on one serial queue, which owns all the state here.
 */
final class PortForward {
  /// Called on the main queue with why a connection could not reach the
  /// workspace port, e.g. nothing listening there.
  var onError: ((String) -> Void)?

  private let attach: URL
  private let origin: String
  private let queue = DispatchQueue(label: "yaac.port-forward")
  private var listener: NWListener?
  private var tunnels: [ObjectIdentifier: Tunnel] = [:]
  /// Bumped by `pause` and `stop`, so a bind still in flight when either
  /// runs cancels itself instead of installing a listener nothing will close.
  private var generation = 0
  private var stopped = false

  init?(origin: String, workspaceId: String, containerPort: Int) {
    guard let attach = Self.attachURL(origin: origin, workspaceId: workspaceId, containerPort: containerPort)
    else { return nil }
    self.attach = attach
    self.origin = origin
  }

  /// `wss://<server>/api/forward/attach?id=<workspace>&port=<container port>`.
  static func attachURL(origin: String, workspaceId: String, containerPort: Int) -> URL? {
    guard var url = URLComponents(string: origin), url.scheme == "https" else { return nil }
    url.scheme = "wss"
    url.path = "/api/forward/attach"
    url.queryItems = [
      URLQueryItem(name: "id", value: workspaceId),
      URLQueryItem(name: "port", value: String(containerPort)),
    ]
    return url.url
  }

  /**
   * Listen on `127.0.0.1`, at `preferred` when it is free and at any free
   * port otherwise. The preferred one is the host port the server offers
   * (or, coming back from the background, the port bound before), so a
   * dev server that builds absolute URLs from its port still works.
   * Returns the port bound.
   */
  func start(preferred: UInt16) async throws -> UInt16 {
    do {
      return try await listen(on: preferred)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      return try await listen(on: 0)
    }
  }

  /// Stop listening and cut every open connection; `start` listens again.
  func pause() {
    queue.async { self.closeAll() }
  }

  /// Stop for good.
  func stop() {
    queue.async {
      self.stopped = true
      self.closeAll()
    }
  }

  private func closeAll() {
    generation += 1
    listener?.cancel()
    listener = nil
    for tunnel in tunnels.values { tunnel.close() }
  }

  private func listen(on port: UInt16) async throws -> UInt16 {
    let ticket = try queue.sync { () throws -> Int in
      if stopped { throw CancellationError() }
      return generation
    }
    // No `allowLocalEndpointReuse`: on iOS every app shares one user, so it
    // would let another app bind this port beside ours and take its
    // connections. A port still in TIME_WAIT is just another taken port.
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port) ?? .any)
    let listener = try NWListener(using: params)
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    return try await withCheckedThrowingContinuation { continuation in
      var waiting = true
      let settle = { (result: Result<UInt16, Error>) in
        guard waiting else { return }
        waiting = false
        continuation.resume(with: result)
      }
      listener.stateUpdateHandler = { [weak self] state in
        switch state {
        case .ready:
          guard let self, self.generation == ticket else {
            listener.cancel()
            return settle(.failure(CancellationError()))
          }
          self.listener = listener
          settle(.success(listener.port?.rawValue ?? port))
        // A port in use can show as either.
        case .failed(let error), .waiting(let error):
          listener.cancel()
          settle(.failure(error))
        case .cancelled:
          // The handler holds the listener; let both go.
          listener.stateUpdateHandler = nil
          listener.newConnectionHandler = nil
          settle(.failure(CancellationError()))
        default:
          break
        }
      }
      listener.start(queue: queue)
    }
  }

  private func accept(_ connection: NWConnection) {
    let tunnel = Tunnel(connection: connection, attach: attach, origin: origin, queue: queue)
    let key = ObjectIdentifier(tunnel)
    tunnel.onClose = { [weak self] in self?.tunnels[key] = nil }
    tunnel.onError = { [weak self] message in
      DispatchQueue.main.async { self?.onError?(message) }
    }
    tunnels[key] = tunnel
    tunnel.start()
  }
}

/**
 * One accepted connection and its WebSocket. The connection is read only
 * once the WebSocket is open, so a request the page sends at once is not
 * lost, and each side is read again only once the other has taken the last
 * chunk, so neither buffers without bound.
 *
 * A clean close from the server ends the connection only when the receive
 * loop fails, after every message the task already holds has gone to the
 * page; the close frame can arrive while some are still queued.
 */
private final class Tunnel: NSObject, URLSessionWebSocketDelegate {
  var onClose: (() -> Void)?
  var onError: ((String) -> Void)?

  private let connection: NWConnection
  private let queue: DispatchQueue
  private var session: URLSession!
  private var task: URLSessionWebSocketTask!
  private var opened = false
  private var finishing = false
  private var closed = false

  init(connection: NWConnection, attach: URL, origin: String, queue: DispatchQueue) {
    self.connection = connection
    self.queue = queue
    super.init()
    let delegateQueue = OperationQueue()
    delegateQueue.underlyingQueue = queue
    delegateQueue.maxConcurrentOperationCount = 1
    // The default 60 s would end a quiet connection, such as an idle
    // dev server's hot-reload socket; neither end pings.
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 24 * 60 * 60
    session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    // The server's Origin guard wants either none or its own; send its own.
    var request = URLRequest(url: attach)
    request.setValue(origin, forHTTPHeaderField: "Origin")
    task = session.webSocketTask(with: request)
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self?.close()
      default: break
      }
    }
    connection.start(queue: queue)
    task.resume()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    opened = true
    toServer()
    toPage()
  }

  /// Codes from 4000 are the server explaining a failed dial
  /// (docs/port-forward-tunnel.md): cut the connection, as a dev server
  /// that never answered would. Any other close is left to the receive loop.
  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    guard closeCode.rawValue >= 4000 else { return }
    let why = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    onError?(why.isEmpty ? "tunnel closed (\(closeCode.rawValue))" : why)
    close()
  }

  /// Before the WebSocket opened, the handshake was refused or the network
  /// is gone; after, the receive loop ends the connection.
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard !opened else { return }
    if let error, !closed { onError?(ServerStore.describe(error)) }
    close()
  }

  private func toServer() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
      guard let self, !self.closed else { return }
      guard let data, !data.isEmpty else {
        if isComplete || error != nil { self.close() } else { self.toServer() }
        return
      }
      self.task.send(.data(data)) { error in
        if error != nil || isComplete { self.close() } else { self.toServer() }
      }
    }
  }

  private func toPage() {
    task.receive { [weak self] result in
      guard let self, !self.closed else { return }
      switch result {
      case .success(.data(let data)):
        self.connection.send(content: data, completion: .contentProcessed { error in
          if error != nil { self.close() } else { self.toPage() }
        })
      case .success:
        self.toPage()
      case .failure:
        self.finish()
      }
    }
  }

  /// End the connection once the bytes already sent to it are out.
  private func finish() {
    guard !closed, !finishing else { return }
    finishing = true
    connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [weak self] _ in
      self?.close()
    })
  }

  /// Cut both ends. Invalidating the session also releases it, since a
  /// session holds its delegate until then.
  func close() {
    guard !closed else { return }
    closed = true
    connection.cancel()
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
    onClose?()
  }
}
