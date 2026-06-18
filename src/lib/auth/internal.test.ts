import { afterEach, describe, expect, it } from "vitest";
import { verifyInternalJobRequest, InternalAuthError } from "./internal";

const ORIGINAL = process.env.ONE_INTERNAL_JOB_TOKEN;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ONE_INTERNAL_JOB_TOKEN;
  else process.env.ONE_INTERNAL_JOB_TOKEN = ORIGINAL;
});

function req(headers: Record<string, string>): Request {
  return new Request("https://one.hushh.ai/api/internal/x", { method: "POST", headers });
}

describe("verifyInternalJobRequest", () => {
  it("refuses when the token is not configured (fail closed)", () => {
    delete process.env.ONE_INTERNAL_JOB_TOKEN;
    expect(() => verifyInternalJobRequest(req({ authorization: "Bearer anything" }))).toThrow(InternalAuthError);
  });

  it("accepts a matching Bearer token and the x-one-job-token header", () => {
    process.env.ONE_INTERNAL_JOB_TOKEN = "s3cret-token";
    expect(() => verifyInternalJobRequest(req({ authorization: "Bearer s3cret-token" }))).not.toThrow();
    expect(() => verifyInternalJobRequest(req({ "x-one-job-token": "s3cret-token" }))).not.toThrow();
  });

  it("rejects a wrong or missing token", () => {
    process.env.ONE_INTERNAL_JOB_TOKEN = "s3cret-token";
    expect(() => verifyInternalJobRequest(req({ authorization: "Bearer wrong" }))).toThrow(InternalAuthError);
    expect(() => verifyInternalJobRequest(req({}))).toThrow(InternalAuthError);
  });
});
