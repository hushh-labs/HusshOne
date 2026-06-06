import { describe, expect, it } from "vitest";
import { initialsForName, isValidEmail, normalizeEmail, normalizeName } from "./identity";

describe("identity helpers", () => {
  it("normalizes Google profile fields", () => {
    expect(normalizeName("  Ankit   Kumar Singh  ")).toBe("Ankit Kumar Singh");
    expect(normalizeEmail("  Ankit@Example.COM ")).toBe("ankit@example.com");
  });

  it("validates emails and creates stable initials", () => {
    expect(isValidEmail("ankit@example.com")).toBe(true);
    expect(isValidEmail("ankit")).toBe(false);
    expect(initialsForName("Ankit Kumar Singh")).toBe("AK");
  });
});
