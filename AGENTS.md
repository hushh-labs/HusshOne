<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# Design canon (founder directive, 2026-08 — applies to ALL published work)

- **Apple first, to the letter.** Every surface, document, and artifact follows Apple's design
  principles — whitespace-generous, one accent, SF system stack, large-title typography,
  pixel-perfect details. The bar: Jony Ive would be proud of it.
- **Summer White is the reference theme** (the iOS 27 / WWDC summer look): near-white field
  (`#fbfbfd`), ink type (`#1d1d1f`), Apple blue accent (`#0071e3`), Liquid-Glass surfaces with
  hairline borders. Dark is the first-class complement via `prefers-color-scheme: dark` — never
  an afterthought, never the default. The shared palette lives in `src/app/adam/adam.module.css`.
- **Letterhead on published surfaces:** "Built and published by the 🤫 Research & Advisory Team ·
  Signed **🤫 Confidential**" with the signature line *"Simplicity is the signature of excellence."*
  (see `.letterhead`). Everything is ALWAYS signed 🤫 Confidential — it is the brand's signature
  mark (hushh = confidentiality), on every artifact: pages, documents, briefs, decks.
- **Simplicity is the discipline.** Remove until it breaks; one CTA per surface; if a feature
  needs explaining, redesign it.
<!-- END:nextjs-agent-rules -->
