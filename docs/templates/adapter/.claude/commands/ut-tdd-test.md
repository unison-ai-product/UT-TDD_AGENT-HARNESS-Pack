---
description: Run UT-TDD verification for the current change
argument-hint: "<changed area or PLAN id>"
---

Target: $ARGUMENTS

Run the narrow Vitest target first, then `bun run typecheck`, `bun run lint`, and `ut-tdd doctor --profile consumer-setup-smoke` for generated adapter/setup health. Use full `ut-tdd doctor` only in source/governance repositories with PLAN/design/test-design artifacts.
