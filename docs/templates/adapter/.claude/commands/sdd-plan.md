---
description: Create a spec-driven UT-TDD plan before implementation.
argument-hint: "<target>"
---

Command: sdd-plan

Target: $ARGUMENTS

Use repository-local UT-TDD commands. Start with `ut-tdd status --json`, run the narrow verification for the target, and finish with `ut-tdd doctor` when workflow or gate behavior is affected.
