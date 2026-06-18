//
//  JobLedgerTests.swift
//  OnePuppyKitTests
//
//  The crash-safe in-flight job ledger (one-puppy-macos-agent.md §8). Uses a temp directory so
//  it doesn't touch the user's real Application Support.
//

import XCTest
@testable import OnePuppyKit

final class JobLedgerTests: XCTestCase {
    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OnePuppyLedgerTests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testAddRemoveAndList() async {
        let dir = tempDir()
        let ledger = JobLedger(directory: dir)
        await ledger.add(.init(burstJobId: "a", placement: "gcp", createdAt: Date(timeIntervalSince1970: 1)))
        await ledger.add(.init(burstJobId: "b", placement: "puppy", createdAt: Date(timeIntervalSince1970: 2)))

        let all = await ledger.all()
        XCTAssertEqual(all.map(\.burstJobId), ["a", "b"])

        await ledger.remove("a")
        let after = await ledger.all()
        XCTAssertEqual(after.map(\.burstJobId), ["b"])
    }

    func testPersistsAcrossInstances() async {
        let dir = tempDir()
        let first = JobLedger(directory: dir)
        await first.add(.init(burstJobId: "survivor", placement: "gcp", createdAt: Date()))

        // A fresh ledger over the same directory must re-read the entry (crash-safe resume).
        let second = JobLedger(directory: dir)
        let all = await second.all()
        XCTAssertEqual(all.map(\.burstJobId), ["survivor"])
    }
}
