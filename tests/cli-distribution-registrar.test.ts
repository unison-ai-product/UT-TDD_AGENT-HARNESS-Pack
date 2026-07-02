import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerDistributionCommands } from "../src/cli/distribution";

describe("CLI distribution registrar", () => {
  it("registers the clean distribution command group without the root CLI monolith", () => {
    const program = new Command();

    registerDistributionCommands(program);

    const distribution = program.commands.find((command) => command.name() === "distribution");
    expect(distribution).toBeDefined();
    expect(distribution?.commands.map((command) => command.name()).sort()).toEqual([
      "package",
      "plan",
      "release-plan",
      "sync-pack",
      "sync-plan",
      "sync-stage",
    ]);
    expect(distribution?.helpInformation()).toContain("clean distribution planning");
  });
});
