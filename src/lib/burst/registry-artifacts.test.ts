/* Drift guard for the committed registry-upload artifacts.
   The files in registry/ are what an operator uploads to the Gemini Enterprise Agent
   Platform. They MUST equal what the code produces. This test asserts that — and, when
   run with UPDATE_REGISTRY=1, regenerates them (the "generator"):
     UPDATE_REGISTRY=1 npx vitest run src/lib/burst/registry-artifacts.test.ts */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROD_ORIGIN, buildAgentCard, burstFunctionDeclaration } from "./agent-card";

const ROOT = join(__dirname, "..", "..", "..");
const DIR = join(ROOT, "registry");
const CARD = join(DIR, "agent-card.json");
const FUNC = join(DIR, "function-declaration.json");

const expectedCard = JSON.stringify(buildAgentCard(PROD_ORIGIN), null, 2) + "\n";
const expectedFunc = JSON.stringify(burstFunctionDeclaration, null, 2) + "\n";

if (process.env.UPDATE_REGISTRY === "1") {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(CARD, expectedCard);
  writeFileSync(FUNC, expectedFunc);
}

describe("registry artifacts", () => {
  it("agent-card.json matches buildAgentCard(PROD_ORIGIN)", () => {
    expect(existsSync(CARD)).toBe(true);
    expect(readFileSync(CARD, "utf8")).toBe(expectedCard);
  });

  it("function-declaration.json matches burstFunctionDeclaration", () => {
    expect(existsSync(FUNC)).toBe(true);
    expect(readFileSync(FUNC, "utf8")).toBe(expectedFunc);
  });

  it("the function declaration covers the required burst inputs", () => {
    expect(burstFunctionDeclaration.parameters.required).toEqual(
      expect.arrayContaining(["image", "acceleratorKind", "acceleratorCount", "estimate"]),
    );
  });
});
