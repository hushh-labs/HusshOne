//
//  OnePuppyApp.swift
//  OnePuppyAgent
//
//  The SwiftUI menu-bar app. It is deliberately thin: it owns the AppModel (observable UI
//  state) and wires OnePuppyKit's controller to the UI. No business logic lives here.
//
//  UX north star (macos-experience.md §1): "Your Mac is a supercomputer — and when one job
//  needs more, One quietly borrows a bigger one and brings the answer back."
//

import SwiftUI
import OnePuppyKit

@main
struct OnePuppyApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        // The calm menu-bar presence. The glyph reflects state (idle/local/bursting).
        MenuBarExtra {
            MenuBarView(model: model)
        } label: {
            Image(systemName: model.menuBarSymbol)
                .accessibilityLabel(model.menuBarAccessibilityLabel)
        }
        .menuBarExtraStyle(.window)

        // Onboarding opens as a regular window the first run (or when the user reconnects a key).
        Window("Welcome to One", id: "onboarding") {
            OnboardingView(model: model)
        }
        .windowResizability(.contentSize)
    }
}

// MARK: - UI state

/// The phase the menu bar reflects (macos-experience.md §4).
enum AgentPhase: Equatable {
    case idle
    case workingLocally(progress: String)
    case bursting(progress: String, costSoFar: Double?)
    case pendingHandoff(message: String)
    case failed(message: String)
}

/// Observable UI state. The single source of truth the SwiftUI views render. It translates
/// OnePuppyKit's `PuppyEvent`s into a calm, human phase and a live cost line.
@MainActor
final class AppModel: ObservableObject {
    @Published var phase: AgentPhase = .idle
    @Published var keyConnected: Bool = false
    @Published var connectedProject: String?
    /// Live, honest cost estimate during a burst, in dollars (macos-experience.md §4/§6).
    @Published var costSoFar: Double?
    /// A short one-line summary after a burst ("Cost: $0.62, billed to your cloud").
    @Published var lastBurstSummary: String?

    private let vault = KeychainVault()

    // The controller is created lazily once a TokenProvider (Firebase) is available. In a real
    // build, `FirebaseTokenProvider` wraps the Firebase Auth SDK; here it is injected by the app.
    private var controller: OnePuppyController?

    init() {
        refreshKeyState()
    }

    // MARK: Key management

    func refreshKeyState() {
        keyConnected = vault.hasKey()
        connectedProject = vault.connectedInfo()?.projectId
    }

    /// Validate + store a pasted SA JSON. Returns a human result for the onboarding UI.
    func connectKey(_ json: String) -> Result<String, String> {
        do {
            let info = try vault.store(serviceAccountJson: json)
            refreshKeyState()
            return .success(info.projectId)
        } catch let e as KeychainVaultError {
            return .failure(e.description)
        } catch {
            return .failure("Couldn't connect that key.")
        }
    }

    /// One-tap disconnect (macos-experience.md §7) — leaves nothing behind.
    func disconnectKey() {
        try? vault.delete()
        refreshKeyState()
        lastBurstSummary = nil
    }

    // MARK: Plain-English privacy answer (macos-experience.md §7)

    let whatWeSendExplanation = """
    When One borrows a supercomputer, it sends two things to your own Google Cloud, over an \
    encrypted connection: the job you're running, and your cloud key — so the work runs in \
    your project, billed to you. Hushh keeps none of it. Your key never leaves this Mac except \
    to start your own burst. Nothing about your files or results is stored by Hushh.
    """

    // MARK: Menu-bar glyph

    var menuBarSymbol: String {
        switch phase {
        case .idle: return "pawprint"
        case .workingLocally: return "pawprint.fill"
        case .bursting: return "bolt.horizontal.circle.fill"
        case .pendingHandoff: return "clock.badge"
        case .failed: return "exclamationmark.triangle"
        }
    }

    var menuBarAccessibilityLabel: String {
        switch phase {
        case .idle: return "One — idle"
        case .workingLocally: return "One — working on this Mac"
        case .bursting: return "One — borrowing a supercomputer"
        case .pendingHandoff: return "One — finishing in your cloud"
        case .failed: return "One — needs attention"
        }
    }

    // MARK: Event handling

    /// Translate a controller event into UI phase + cost. Called on the main actor.
    func apply(_ event: PuppyEvent) {
        switch event {
        case .decidedLocal:
            phase = .workingLocally(progress: "Running on this Mac…")
        case .localProgress(let line):
            phase = .workingLocally(progress: line)
        case .localCompleted:
            phase = .idle
        case .localFailed(let message):
            phase = .failed(message: message)

        case .bursting(let reason):
            phase = .bursting(progress: reason, costSoFar: costSoFar)
        case .burstProgress(let line, _):
            phase = .bursting(progress: line, costSoFar: costSoFar)
        case .burstCompleted:
            lastBurstSummary = costSummaryLine()
            phase = .idle
        case .burstPending(_, let message):
            phase = .pendingHandoff(message: message ?? "This is taking longer than usual — I'll let you know the moment it's done.")
        case .burstFailed(let message):
            phase = .failed(message: message)

        case .recovered(let status):
            phase = status.status == .completed ? .idle
                : status.status == .failed ? .failed(message: status.error ?? "That job didn't finish.")
                : .idle
        }
    }

    private func costSummaryLine() -> String {
        if let cost = costSoFar {
            return String(format: "Done. One borrowed a supercomputer and cleaned it up. Cost: $%.2f, billed to your cloud.", cost)
        }
        return "Done. One borrowed a supercomputer and cleaned it up."
    }
}
