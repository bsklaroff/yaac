import AVFoundation
import SwiftUI
import VisionKit

/**
 * The camera, reading QR codes until one names a server. VisionKit's
 * DataScannerViewController does the recognition; this only asks for the
 * camera and hands back the first code that is a link.
 */
struct QRScannerSheet: View {
  let found: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var access = AVCaptureDevice.authorizationStatus(for: .video)

  var body: some View {
    NavigationStack {
      Group {
        if !DataScannerViewController.isSupported {
          ContentUnavailableView(
            "Scanning unavailable",
            systemImage: "qrcode.viewfinder",
            description: Text("This device cannot scan codes. Type the server's address instead.")
          )
        } else if access == .authorized {
          QRScanner(found: found).ignoresSafeArea()
        } else if access == .notDetermined {
          ProgressView()
        } else {
          ContentUnavailableView(
            "Camera access needed",
            systemImage: "camera",
            description: Text("Allow camera access for yaac in Settings, or type the server's address.")
          )
        }
      }
      .navigationTitle("Scan QR code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .task {
      if access == .notDetermined {
        access = await AVCaptureDevice.requestAccess(for: .video) ? .authorized : .denied
      }
    }
  }
}

private struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      isHighlightingEnabled: true
    )
    scanner.delegate = context.coordinator
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
    if !scanner.isScanning { try? scanner.startScanning() }
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let found: (String) -> Void
    private var done = false

    init(found: @escaping (String) -> Void) { self.found = found }

    func dataScanner(
      _ dataScanner: DataScannerViewController,
      didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      for case .barcode(let code) in addedItems {
        guard !done, let text = code.payloadStringValue, Self.isLink(text) else { continue }
        done = true
        found(text)
      }
    }

    /// Any web or yaac link ends the scan, even one the app cannot use, so
    /// `ServerStore.offer` can say why rather than the camera ignoring it.
    private static func isLink(_ text: String) -> Bool {
      ["https", "http", "yaac"].contains(URLComponents(string: text)?.scheme?.lowercased() ?? "")
    }
  }
}
