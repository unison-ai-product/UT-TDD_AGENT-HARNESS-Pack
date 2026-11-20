import type { EvidenceAttestation, EvidenceProducer } from "../domain/evidence-types.ts";

export interface EvidenceAttestationInput {
  readonly producer: EvidenceProducer;
  readonly recordDigest: string;
}

export interface EvidenceAttestationIssuerPort {
  issue(input: EvidenceAttestationInput): EvidenceAttestation;
}

export interface EvidenceAttestationVerifierPort {
  verify(input: EvidenceAttestationInput, attestation: EvidenceAttestation): boolean;
}
