//
//  OnboardingView.swift
//  OnePuppyAgent
//
//  The 3-screen first run (macos-experience.md §3): Welcome → Connect your cloud → Ready.
//  ≤ 60 seconds, plain-English privacy copy, paste + validate the GCP key into KeychainVault.
//
//  Principles honored: invisible mechanics, zero-config (the only step is "connect your cloud"),
//  privacy you can feel (reassurance present *before* the user asks), fail like Apple.
//

import SwiftUI
import OnePuppyKit

struct OnboardingView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private enum Screen { case welcome, connect, ready }
    @State private var screen: Screen = .welcome

    var body: some View {
        VStack(spacing: 24) {
            switch screen {
            case .welcome: welcome
            case .connect: connect
            case .ready: ready
            }
        }
        .padding(40)
        .frame(width: 460)
        .multilineTextAlignment(.center)
    }

    // MARK: Screen 1 — Welcome

    private var welcome: some View {
        VStack(spacing: 16) {
            Image(systemName: "pawprint.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("One makes your Mac a supercomputer.")
                .font(.title2).bold()
            Text("It runs your work right here — and quietly borrows more power only when a job needs it.")
                .foregroundStyle(.secondary)
            Button("Get started") { screen = .connect }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        // One silently reads the device profile here — no questions asked (§3).
    }

    // MARK: Screen 2 — Connect your cloud (the only real step)

    @State private var pastedKey: String = ""
    @State private var connectError: String?
    @State private var connectedProject: String?

    private var connect: some View {
        VStack(spacing: 16) {
            Text("Connect your cloud")
                .font(.title2).bold()
            Text("Paste your Google Cloud key so One can borrow supercomputers when your Mac needs them.")
                .foregroundStyle(.secondary)

            // Inline reassurance — present BEFORE they ask (§3).
            Label {
                Text("Your key stays on this Mac (in the Secure Enclave). Your data runs in your own Google Cloud. We never store either.")
                    .font(.footnote)
            } icon: {
                Image(systemName: "lock.shield")
            }
            .foregroundStyle(.secondary)
            .padding(12)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))

            TextEditor(text: $pastedKey)
                .font(.system(.caption, design: .monospaced))
                .frame(height: 96)
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
                .accessibilityLabel("Google Cloud key")

            HStack {
                Button("Paste") {
                    #if canImport(AppKit)
                    if let clip = NSPasteboard.general.string(forType: .string) { pastedKey = clip }
                    #endif
                }
                Spacer()
                Button("Connect") { attemptConnect() }
                    .buttonStyle(.borderedProminent)
                    .disabled(pastedKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if let connectedProject {
                Label("You're set — connected to \(connectedProject).", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            } else if let connectError {
                // Calm, specific, actionable — never a stack trace (§2.7).
                Label(connectError, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.orange)
            }

            // Quiet helper for users without a key yet (§3).
            Link("Don't have a key? Here's the 2-minute setup",
                 destination: URL(string: "https://one.hushh.ai/setup/byoc")!)
                .font(.footnote)

            HStack {
                // Skipping is allowed; One still works on-device and asks just-in-time (§3).
                Button("Skip for now") { screen = .ready }
                    .buttonStyle(.link)
                Spacer()
                if connectedProject != nil {
                    Button("Continue") { screen = .ready }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    private func attemptConnect() {
        connectError = nil
        switch model.connectKey(pastedKey) {
        case .success(let project):
            connectedProject = project
            pastedKey = "" // don't keep the secret in a view's @State longer than needed
        case .failure(let message):
            connectError = message
        }
    }

    // MARK: Screen 3 — You're ready

    private var ready: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            Text("You're ready")
                .font(.title2).bold()
            Text("One will use your Mac first, and only borrow more power when a job needs it. You're in control.")
                .foregroundStyle(.secondary)
            Button("Start using One") {
                model.refreshKeyState()
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }
}
