import { describe, expect, it } from "vitest";
import { matchVoiceAsk } from "./voice";

describe("matchVoiceAsk — everyday words to asks", () => {
  it("matches natural phrasings to the right preset", () => {
    expect(matchVoiceAsk("Adam, fine tune the 70B on my data")).toBe("finetune-70b");
    expect(matchVoiceAsk("train a model on my photos please")).toBe("photos-model");
    expect(matchVoiceAsk("can you backtest the markets for me")).toBe("backtest-markets");
    expect(matchVoiceAsk("fold this protein")).toBe("fold-protein");
    expect(matchVoiceAsk("render the film sequence")).toBe("render-film");
  });

  it("prefers the target with more matched words", () => {
    // "train the 70b model": three finetune words hit, no photos phrase does.
    expect(matchVoiceAsk("train the 70b model")).toBe("finetune-70b");
  });

  it("returns null when nothing matches", () => {
    expect(matchVoiceAsk("what's the weather like")).toBeNull();
    expect(matchVoiceAsk("")).toBeNull();
  });
});
