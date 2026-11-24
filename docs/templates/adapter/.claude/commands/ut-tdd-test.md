---
description: Run UT-TDD verification for the current change
argument-hint: "<Issue number or design document path>"
---

Target: $ARGUMENTS

Run the narrow Vitest target first, then `npm run typecheck`, `npm run lint`, `ut-tdd doctor --profile consumer-setup-smoke`, and `ut-tdd doctor --profile consumer-toolchain` for generated adapter/setup and consumer-safe toolchain health. Use full `ut-tdd doctor` only in source/governance repositories with governance/design/test-design artifacts.
