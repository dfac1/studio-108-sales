# System Prompt And Step Policy

## Core Model

The manager is built in `policy-first` mode:

`STT -> semantic extraction -> dialog policy -> tools -> short reply -> TTS`

The LLM is not responsible for writing the whole answer on every turn. Its main job is to understand messy Russian speech and return structured fields fast. The dialog policy then decides the next step and produces a short reply.

## System Prompt

Source of truth in code: [src/services/salesPrompts.ts](</C:/Users/Андрей/Desktop/Sales/src/services/salesPrompts.ts>)

High-level intent:

- sound like a real Studio 108 administrator
- move one step at a time
- do not invent schedule, prices, or branches
- ask one main question per message
- avoid internal slot details unless the client explicitly asks

## Step Order

1. Name
2. For self or for child
3. Need / goal or concrete direction
4. Age if needed
5. Branch
6. One best time option
7. Phone
8. Consent for booking
9. Confirmation

## Guardrails

- Never jump to the next step if the current one is not clearly closed.
- Never expose internal branches in proactive offers.
- Never dump full slot metadata in the first offer.
- Never offer rent or individual lessons.
- Never offer Strip-plastic on Shkolnaya.
- If age is below the minimum public groups, hand off to admin.
- If the user asks about price early, answer briefly and return to the missing step.
- If the STT/LLM layer is slow or unavailable, fall back to rules and keep the answer short.
