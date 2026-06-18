import { afterEach, describe, expect, it } from "vitest";
import { verifyDevApiRequest, apiOwnerUid, DevApiAuthError } from "./dev-api";

const ORIGINAL = process.env.ONE_DEV_API_KEYS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONE_DEV_API_KEYS;
  else process.env.ONE_DEV_API_KEYS = ORIGINAL;
});

function req(headers: Record<string, string>): Request {
  return new Request("https://one.hushh.ai/api/v1/scan", { method: "POST", headers });
}

describe("verifyDevApiRequest", () => {
  it("fails closed when no keys are configured", () => {
    delete process.env.ONE_DEV_API_KEYS;
    expect(() => verifyDevApiRequest(req({ authorization: "Bearer anything" }))).toThrow(DevApiAuthError);
  });

  it("resolves the keyId for a matching Bearer secret (multi-key list)", () => {
    process.env.ONE_DEV_API_KEYS = "acme:sk_live_aaa, mobile:sk_live_bbb";
    expect(verifyDevApiRequest(req({ authorization: "Bearer sk_live_aaa" }))).toEqual({ keyId: "acme" });
    expect(verifyDevApiRequest(req({ authorization: "Bearer sk_live_bbb" }))).toEqual({ keyId: "mobile" });
  });

  it("rejects a wrong or missing secret", () => {
    process.env.ONE_DEV_API_KEYS = "acme:sk_live_aaa";
    expect(() => verifyDevApiRequest(req({ authorization: "Bearer nope" }))).toThrow(DevApiAuthError);
    expect(() => verifyDevApiRequest(req({}))).toThrow(DevApiAuthError);
  });

  it("ignores malformed key entries", () => {
    process.env.ONE_DEV_API_KEYS = "  , broken, :nosecret, good:sk_ok ";
    expect(verifyDevApiRequest(req({ authorization: "Bearer sk_ok" }))).toEqual({ keyId: "good" });
    expect(() => verifyDevApiRequest(req({ authorization: "Bearer nosecret" }))).toThrow(DevApiAuthError);
  });

  it("namespaces the owner uid", () => {
    expect(apiOwnerUid("acme")).toBe("api:acme");
  });
});
