# Voice Failure Modes And Fixes

## Product Risks

1. Slow answer because the model writes a full reply every turn.
Fix:
Use `policy-first` replies. LLM only extracts structure.

2. The model understands the user but invents schedule or price.
Fix:
All schedule, price, and booking actions come from backend tools only.

3. The assistant asks too many questions in one message.
Fix:
Strict stage policy, one primary question per turn.

4. The assistant sounds robotic or verbose in Russian.
Fix:
Short templates, Russian speech normalization, provider A/B testing.

5. STT mistakes names, ages, or branches.
Fix:
Rule-based extraction first, semantic fallback second, clarification when confidence is low.

6. A child is matched to an adult group.
Fix:
Age gating in slot filtering plus under-age handoff rule.

7. The client rejects the first slot and the assistant gets stuck.
Fix:
Sequential fallback: next slot in same branch -> other branch -> admin handoff.

8. A foreign provider receives personal data without the right legal basis.
Fix:
Provider-aware compliance check and separate cross-border flag.

9. One provider fails and the whole flow breaks.
Fix:
Independent provider abstraction. Dialog can continue even if TTS fails.

10. The business logic drifts because there are multiple dialog engines.
Fix:
Main flow is centralized in `salesDialog.ts`; provider layer is separated from policy.

## Engineering Risks

1. Timeout from semantic extraction.
Fix:
Short timeout, fallback to rules.

2. Provider request shape drifts from docs.
Fix:
Mocked request-shape tests for both Yandex and ElevenLabs.

3. Hidden/internal branches leak into the UI.
Fix:
`Черняховского` is no longer public in slot visibility.

4. Booking succeeds after free places reach zero.
Fix:
Booking still re-checks availability at write time.
