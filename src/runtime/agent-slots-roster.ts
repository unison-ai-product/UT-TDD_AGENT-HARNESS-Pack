export type RosterSlotSource = "agent_guard" | "team_runner" | "manual";

export interface RosterCapabilityEntry {
  role: string;
  capability: string | string[];
  model_class?: string;
  slot_source?: RosterSlotSource;
  evidence_path?: string;
}

export interface RosterCapabilityInput {
  role: string;
  requested_capability: string;
  slot_source?: RosterSlotSource;
  roster_snapshot: RosterCapabilityEntry[];
}

export interface RosterCapabilityFinding {
  code: "missing-capability" | "missing-role" | "missing-requested-capability";
  severity: "error";
  message: string;
  evidence_path: string;
}

export interface RosterCapabilityResult {
  ok: boolean;
  capability?: string;
  model_class?: string;
  slot_source?: RosterSlotSource;
  evidence_path?: string;
  findings: RosterCapabilityFinding[];
}

function normalizeRosterValue(value: string): string {
  return value.trim().toLowerCase();
}

function rosterCapabilities(entry: RosterCapabilityEntry): string[] {
  return Array.isArray(entry.capability) ? entry.capability : [entry.capability];
}

export function resolveRosterCapability(input: RosterCapabilityInput): RosterCapabilityResult {
  const role = normalizeRosterValue(input.role);
  const requested = normalizeRosterValue(input.requested_capability);
  if (!role) {
    return {
      ok: false,
      findings: [
        {
          code: "missing-role",
          severity: "error",
          message: "role is required",
          evidence_path: "",
        },
      ],
    };
  }
  if (!requested) {
    return {
      ok: false,
      findings: [
        {
          code: "missing-requested-capability",
          severity: "error",
          message: "requested_capability is required",
          evidence_path: "",
        },
      ],
    };
  }
  const match = input.roster_snapshot.find((entry) => {
    if (normalizeRosterValue(entry.role) !== role) return false;
    if (input.slot_source && entry.slot_source && entry.slot_source !== input.slot_source)
      return false;
    return rosterCapabilities(entry).some(
      (capability) => normalizeRosterValue(capability) === requested,
    );
  });
  if (!match) {
    return {
      ok: false,
      findings: [
        {
          code: "missing-capability",
          severity: "error",
          message: `${input.role} cannot resolve ${input.requested_capability}`,
          evidence_path: "",
        },
      ],
    };
  }
  const capability =
    rosterCapabilities(match).find((value) => normalizeRosterValue(value) === requested) ??
    input.requested_capability;
  return {
    ok: true,
    capability,
    model_class: match.model_class,
    slot_source: match.slot_source,
    evidence_path: match.evidence_path,
    findings: [],
  };
}
