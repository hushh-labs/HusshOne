/* Adam's ears (pure matching + a thin browser-speech wrapper).
   Progressive enhancement: where the browser offers speech recognition (Safari/Chrome),
   Adam listens; everywhere else the mic simply isn't shown. Matching is deliberately
   simple — keyword overlap against the preset vocabulary — because at MVP scale a
   transparent matcher beats an opaque one. */

export interface VoiceTarget {
  id: string;
  words: string[];
}

/** Vocabulary per preset — everyday words, not spec words. */
export const VOICE_TARGETS: VoiceTarget[] = [
  { id: "photos-model", words: ["photo", "photos", "picture", "pictures", "train on my"] },
  { id: "clip-edit", words: ["clip", "enhance", "video", "4k"] },
  { id: "finetune-70b", words: ["70", "70b", "fine tune", "fine-tune", "finetune", "model", "llm"] },
  { id: "render-film", words: ["render", "film", "movie", "sequence", "frames"] },
  { id: "backtest-markets", words: ["backtest", "market", "markets", "stocks", "trading", "ticks"] },
  { id: "fold-protein", words: ["protein", "fold", "folding", "biology", "tpu"] },
  { id: "frontier-run", words: ["frontier", "biggest", "largest", "pretrain", "huge"] },
];

/** Match a spoken transcript to a preset id; null when nothing clears the bar. */
export function matchVoiceAsk(transcript: string, targets: VoiceTarget[] = VOICE_TARGETS): string | null {
  const said = transcript.toLowerCase();
  let best: { id: string; hits: number } | null = null;
  for (const t of targets) {
    const hits = t.words.reduce((n, w) => (said.includes(w) ? n + 1 : n), 0);
    if (hits > 0 && (!best || hits > best.hits)) best = { id: t.id, hits };
  }
  return best?.id ?? null;
}

type SpeechRecognitionCtor = new () => {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

/** The browser's recognizer, if it has one. */
export function speechRecognizer(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
