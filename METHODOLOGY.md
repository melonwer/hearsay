# Methodology

Written in full in Phase 3 (§16). It covers, in plain words:

- Repeated sampling and Wilson 95% confidence intervals; why every rate ships with its n.
- Variance decomposition: rerun variance versus phrasing variance, which dominates and
  why intents are sampled at the paraphrase level (§6.6).
- The API-versus-consumer-app caveat: consumer products add hidden system prompts, tools,
  web search, memory and personalisation. That is a bias no amount of sampling removes.
- No system prompt, provider-default temperature — as close as an API gets to defaults.
- The share-of-voice formula and why `branded` prompts are excluded from its denominator.
- Gaps are gaps: days with no valid responses are omitted, never zero-filled.
- Why bring-your-own-keys, and honest framing of how small the channel still is.
- Receipts over scores: no blended visibility number, no rank positions, no prompt-volume
  estimates.
