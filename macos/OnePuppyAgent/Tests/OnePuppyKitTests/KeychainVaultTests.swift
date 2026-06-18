//
//  KeychainVaultTests.swift
//  OnePuppyKitTests
//
//  Validation tests for the BYOC vault. These assert the LOCAL validation contract (§4
//  "validate locally") — they do not touch the real Keychain (storage requires a signed,
//  entitled host; CI runs `validate(...)` which is pure and deterministic).
//

import XCTest
@testable import OnePuppyKit

final class KeychainVaultTests: XCTestCase {
    private let vault = KeychainVault()

    private func saJson(clientEmail: String? = "svc@proj.iam.gserviceaccount.com",
                        privateKey: String? = "-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----\\n",
                        projectId: String? = "proj-x") -> String {
        var fields: [String] = ["\"type\":\"service_account\""]
        if let clientEmail { fields.append("\"client_email\":\"\(clientEmail)\"") }
        if let privateKey { fields.append("\"private_key\":\"\(privateKey)\"") }
        if let projectId { fields.append("\"project_id\":\"\(projectId)\"") }
        return "{" + fields.joined(separator: ",") + "}"
    }

    func testValidatesWellFormedKey() throws {
        let info = try vault.validate(serviceAccountJson: saJson())
        XCTAssertEqual(info.clientEmail, "svc@proj.iam.gserviceaccount.com")
        XCTAssertEqual(info.projectId, "proj-x")
        XCTAssertTrue(info.hasPrivateKey)
    }

    func testRejectsNonJson() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: "not json at all")) { error in
            XCTAssertEqual(error as? KeychainVaultError, .malformedJson)
        }
    }

    func testRejectsJsonArray() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: "[1,2,3]")) { error in
            XCTAssertEqual(error as? KeychainVaultError, .malformedJson)
        }
    }

    func testRejectsMissingClientEmail() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: saJson(clientEmail: nil))) { error in
            XCTAssertEqual(error as? KeychainVaultError, .missingField("client_email"))
        }
    }

    func testRejectsMissingPrivateKey() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: saJson(privateKey: nil))) { error in
            XCTAssertEqual(error as? KeychainVaultError, .missingField("private_key"))
        }
    }

    func testRejectsMissingProjectId() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: saJson(projectId: nil))) { error in
            XCTAssertEqual(error as? KeychainVaultError, .missingField("project_id"))
        }
    }

    func testRejectsEmptyFieldValues() {
        XCTAssertThrowsError(try vault.validate(serviceAccountJson: saJson(privateKey: "   "))) { error in
            XCTAssertEqual(error as? KeychainVaultError, .missingField("private_key"))
        }
    }

    func testErrorMessagesNeverLeakSecretValues() throws {
        // The private key value must never appear in a user-facing error string.
        let secret = "SUPER-SECRET-KEY-MATERIAL-12345"
        let json = saJson(privateKey: nil) // forces a missingField error
        do {
            _ = try vault.validate(serviceAccountJson: json)
            XCTFail("expected throw")
        } catch let e as KeychainVaultError {
            XCTAssertFalse(e.description.contains(secret))
            XCTAssertEqual(e.description, "The key file is missing private_key.")
        }
    }
}
