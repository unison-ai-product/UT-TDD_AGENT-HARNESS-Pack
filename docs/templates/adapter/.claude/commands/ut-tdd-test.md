---
description: Run UT-TDD verification for the current change
argument-hint: "<changed area or PLAN id>"
---

Target: $ARGUMENTS

Run the narrow Vitest target first, then `bun run typecheck`, `bun run lint`, `ut-tdd doctor --profile consumer-setup-smoke`, and `ut-tdd doctor --profile consumer-toolchain` for generated adapter/setup and consumer-safe toolchain health. Use full `ut-tdd doctor` only in source/governance repositories with PLAN/design/test-design artifacts.
