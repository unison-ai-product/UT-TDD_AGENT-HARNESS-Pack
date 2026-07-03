---
description: Prepare release evidence, rollback notes, and final verification.
argument-hint: "<target>"
---

Command: ship

Target: $ARGUMENTS

Use repository-local UT-TDD commands. Start with `ut-tdd status --json`, run the narrow verification for the target, and finish with `ut-tdd doctor` when workflow or gate behavior is affected.
