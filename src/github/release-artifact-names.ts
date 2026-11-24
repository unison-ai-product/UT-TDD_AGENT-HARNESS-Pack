/** package/release-plan が共有する、release artifact の安全なファイル名変換。 */
export function releaseArtifactStem(sourceTag: string): string {
  return sourceTag.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function releaseArtifactFileNames(sourceTag: string): {
  tarball: string;
  checksum: string;
  compiledEsm: string;
  consumerRuntime: string;
  consumerChecksum: string;
} {
  const stem = releaseArtifactStem(sourceTag);
  const tarball = `${stem}.tar.gz`;
  return {
    tarball,
    checksum: `${tarball}.sha256`,
    compiledEsm: `${stem}.ut-tdd.mjs`,
    consumerRuntime: `${stem}.consumer-runtime.json`,
    consumerChecksum: `${stem}.consumer.sha256`,
  };
}
