// swift-tools-version: 5.9
//
// One Puppy — the native macOS on-device agent for Hushh One "Xtreme Compute Burst".
//
// Layout:
//   • OnePuppyKit       — the testable core (no UI): models, device profiling, pressure
//                          sensing, the Keychain vault, the control-plane HTTP client, and
//                          the orchestrator. Pure Foundation/Network/Security/Metal/IOKit.
//   • OnePuppyAgent     — the SwiftUI menu-bar app that wires OnePuppyKit to a UI.
//   • OnePuppyKitTests  — XCTest suites a Mac CI runs (`swift test`).
//
// macOS 14+ (Sonoma) for MenuBarExtra + the modern URLSession bytes AsyncSequence APIs.
// No third-party dependencies — Apple frameworks only.
import PackageDescription

let package = Package(
    name: "OnePuppyAgent",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "OnePuppyAgent", targets: ["OnePuppyAgent"]),
        .library(name: "OnePuppyKit", targets: ["OnePuppyKit"]),
    ],
    targets: [
        // The UI layer. Kept deliberately thin: it owns no business logic.
        .executableTarget(
            name: "OnePuppyAgent",
            dependencies: ["OnePuppyKit"],
            path: "Sources/OnePuppyAgent"
        ),
        // The testable core. Everything that can be unit-tested lives here.
        .target(
            name: "OnePuppyKit",
            path: "Sources/OnePuppyKit"
        ),
        .testTarget(
            name: "OnePuppyKitTests",
            dependencies: ["OnePuppyKit"],
            path: "Tests/OnePuppyKitTests"
        ),
    ]
)
