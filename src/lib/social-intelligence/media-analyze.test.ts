import { describe, expect, it } from "vitest";
import {
  buildVisionRequestBody,
  parseVisionResponse,
  isSafeForSynthesis,
  buildGeminiRequestBody,
  parseGeminiStructured,
  PREFERENCE_MEDIA_SCHEMA,
} from "./media-analyze";

describe("buildVisionRequestBody", () => {
  it("requests all preference-relevant features in one annotate call", () => {
    const body = buildVisionRequestBody("BASE64");
    expect(body.requests[0].image.content).toBe("BASE64");
    const types = body.requests[0].features.map((f) => f.type);
    expect(types).toEqual(
      expect.arrayContaining(["TEXT_DETECTION", "LABEL_DETECTION", "LOGO_DETECTION", "LANDMARK_DETECTION", "OBJECT_LOCALIZATION", "IMAGE_PROPERTIES", "SAFE_SEARCH_DETECTION"]),
    );
  });
});

describe("parseVisionResponse", () => {
  it("normalizes OCR, labels, logos, landmarks, objects, dominant colors, and safe-search", () => {
    const facts = parseVisionResponse({
      responses: [
        {
          fullTextAnnotation: { text: "Made by   Google\nPixel" },
          labelAnnotations: [
            { description: "Smartphone", score: 0.98 },
            { description: "", score: 0.5 },
          ],
          logoAnnotations: [{ description: "Google" }],
          landmarkAnnotations: [{ description: "Golden Gate Bridge" }],
          localizedObjectAnnotations: [{ name: "Phone" }, { name: "Person" }],
          imagePropertiesAnnotation: {
            dominantColors: { colors: [{ color: { red: 10, green: 20, blue: 250 }, score: 0.7, pixelFraction: 0.4 }] },
          },
          safeSearchAnnotation: { adult: "VERY_UNLIKELY", racy: "UNLIKELY", violence: "VERY_UNLIKELY" },
        },
      ],
    });
    expect(facts.ocrText).toBe("Made by Google Pixel");
    expect(facts.labels).toEqual([{ description: "Smartphone", score: 0.98 }]);
    expect(facts.logos).toEqual(["Google"]);
    expect(facts.landmarks).toEqual(["Golden Gate Bridge"]);
    expect(facts.objects).toEqual(["Phone", "Person"]);
    expect(facts.dominantColors[0]).toEqual({ rgb: "rgb(10, 20, 250)", score: 0.7, fraction: 0.4 });
    expect(facts.safeSearch.adult).toBe("VERY_UNLIKELY");
  });

  it("returns empty facts for a malformed response", () => {
    const facts = parseVisionResponse({});
    expect(facts).toEqual({ ocrText: null, labels: [], logos: [], landmarks: [], objects: [], dominantColors: [], safeSearch: {} });
  });
});

describe("isSafeForSynthesis", () => {
  const base = { ocrText: null, labels: [], logos: [], landmarks: [], objects: [], dominantColors: [] };
  it("excludes assets flagged LIKELY/VERY_LIKELY for adult/racy/violence", () => {
    expect(isSafeForSynthesis({ ...base, safeSearch: { adult: "VERY_LIKELY" } })).toBe(false);
    expect(isSafeForSynthesis({ ...base, safeSearch: { racy: "LIKELY" } })).toBe(false);
    expect(isSafeForSynthesis({ ...base, safeSearch: { adult: "UNLIKELY", racy: "POSSIBLE", violence: "VERY_UNLIKELY" } })).toBe(true);
  });
});

describe("buildGeminiRequestBody", () => {
  it("forces JSON output with the preference schema and includes the inline image", () => {
    const body = buildGeminiRequestBody("IMG64", "image/png", "caption about a trip");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toBe(PREFERENCE_MEDIA_SCHEMA);
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: "image/png", data: "IMG64" });
    expect(body.contents[0].parts[0].text).toContain("trip");
    expect(body.contents[0].parts[0].text).toContain("Do NOT identify");
  });
});

describe("parseGeminiStructured", () => {
  it("parses the model's JSON candidate into a typed semantic read", () => {
    const semantic = parseGeminiStructured({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  scene: "outdoor cafe",
                  brands: ["Google", "Apple", ""],
                  confidence: "medium",
                  foodDrink: ["coffee"],
                }),
              },
            ],
          },
        },
      ],
    });
    expect(semantic).toMatchObject({ scene: "outdoor cafe", brands: ["Google", "Apple"], confidence: "medium", foodDrink: ["coffee"] });
  });

  it("defaults confidence to low and tolerates junk", () => {
    expect(parseGeminiStructured({ candidates: [{ content: { parts: [{ text: "{}" }] } }] })?.confidence).toBe("low");
    expect(parseGeminiStructured({ candidates: [{ content: { parts: [{ text: "not json" }] } }] })).toBeNull();
    expect(parseGeminiStructured({})).toBeNull();
  });
});
