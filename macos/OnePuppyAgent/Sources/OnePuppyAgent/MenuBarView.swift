//
//  MenuBarView.swift
//  OnePuppyAgent
//
//  The everyday menu-bar surface (macos-experience.md §4). One click reveals what's running,
//  where (On this Mac / In your cloud), live progress, an honest cost line during a burst, a
//  one-tap plain-English "what does One send to the cloud?" answer, and a disconnect-key control.
//
//  Tone: calm, specific, human. No "instance/provision/quota/VM/zone" ever appears. Failure
//  states mirror the §8 table exactly.
//

import SwiftUI
import OnePuppyKit

struct MenuBarView: View {
    @ObservedObject var model: AppModel
    @State private var showingPrivacy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            Divider()
            statusSection
            if let summary = model.lastBurstSummary {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Divider()
            footer
        }
        .padding(16)
        .frame(width: 320)
    }

    // MARK: Header

    private var header: some View {
        HStack {
            Image(systemName: "pawprint.fill").foregroundStyle(.tint)
            Text("One").font(.headline)
            Spacer()
            cloudBadge
        }
    }

    private var cloudBadge: some View {
        Group {
            if model.keyConnected {
                Label(model.connectedProject ?? "Cloud connected", systemImage: "checkmark.seal.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            } else {
                Label("On this Mac only", systemImage: "desktopcomputer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Status (idle / working-locally / bursting / pending / failed)

    @ViewBuilder
    private var statusSection: some View {
        switch model.phase {
        case .idle:
            row(icon: "moon.zzz", title: "Idle", subtitle: "Ready when you are.")

        case .workingLocally(let progress):
            VStack(alignment: .leading, spacing: 6) {
                row(icon: "pawprint.fill", title: "Working on this Mac", subtitle: progress)
                ProgressView().controlSize(.small) // alive, never a dead spinner (§2.6)
            }

        case .bursting(let progress, let cost):
            VStack(alignment: .leading, spacing: 6) {
                // The accelerator name reads as *power*, not jargon — a confident phrase (§5.3).
                row(icon: "bolt.horizontal.circle.fill", title: "Borrowing a supercomputer", subtitle: progress)
                ProgressView().controlSize(.small)
                // Live, honest cost line (§4 / §6).
                Text(cost.map { String(format: "~$%.2f so far · billed to your cloud", $0) } ?? "Running in your cloud")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        case .pendingHandoff(let message):
            row(icon: "clock.badge", title: "Finishing in your cloud", subtitle: message)

        case .failed(let message):
            // Calm, specific, actionable (§8). No HTTP codes, no stack traces.
            VStack(alignment: .leading, spacing: 8) {
                row(icon: "exclamationmark.triangle", title: "Needs your attention", subtitle: message)
                HStack {
                    Button("Run on this Mac") { model.phase = .idle }
                    if !model.keyConnected {
                        Button("Update key") { /* opens onboarding via the app's Window scene */ }
                    }
                }
                .font(.caption)
            }
        }
    }

    // MARK: Footer — privacy answer + key control

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            // One-tap plain-English answer (§7).
            DisclosureGroup(isExpanded: $showingPrivacy) {
                Text(model.whatWeSendExplanation)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } label: {
                Label("What does One send to the cloud?", systemImage: "lock.shield")
                    .font(.callout)
            }

            HStack {
                if model.keyConnected {
                    // One tap, obviously complete (§7).
                    Button(role: .destructive) {
                        model.disconnectKey()
                    } label: {
                        Label("Disconnect cloud", systemImage: "xmark.shield")
                    }
                } else {
                    Button {
                        // Re-open onboarding to connect a key (just-in-time).
                    } label: {
                        Label("Connect your cloud", systemImage: "link")
                    }
                }
                Spacer()
                Button("Quit One") { NSApplication.shared.terminate(nil) }
                    .foregroundStyle(.secondary)
            }
            .font(.callout)

            if !model.keyConnected {
                Text("Your cloud is disconnected. One will run on this Mac only.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: Helpers

    private func row(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .frame(width: 20)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout).bold()
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
