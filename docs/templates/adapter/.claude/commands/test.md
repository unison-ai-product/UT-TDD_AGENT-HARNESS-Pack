---
description: Run targeted UT-TDD verification for the current change.
argument-hint: "<target>"
---

Command: test

Target: $ARGUMENTS

Use repository-local UT-TDD commands. Start with `ut-tdd status --json`, run the narrow verification for the target, use `ut-tdd doctor --profile consumer-setup-smoke` for generated adapter/setup health, and use `ut-tdd doctor --profile consumer-toolchain` for consumer-safe toolchain health. Full `ut-tdd doctor` is for source/governance repositories with PLAN/design/test-design artifacts.
