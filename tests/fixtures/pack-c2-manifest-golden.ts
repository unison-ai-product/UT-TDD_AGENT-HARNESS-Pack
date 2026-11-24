// Expected YAML for the small fixed Pack C2 manifest fixture.
export const C2_GOLDEN = `schema_version: v2
releases:
  rel-sha256:e4ab289b039efe5a6ba3ad550bbdec958b53f6a0f0973e1db11a4d32a5bcaa13:
    materializerVersion: "1"
    artifactSourceCommit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    artifactSetDigest: sha256:38cd7ed025247f8a564dd02fcfc32f414d6a5a6030fad5dccf7082d7764450e4
    artifactInventoryDigest: sha256:bcf5a6a021d45e8069693a3747210f2535b3560c8216925e261e0f0894ca343a
    releaseAssetInventoryDigest: sha256:205223274bbff0ca1bd71c379023a8954e1f98679733857226c4d14dff2e7cd2
    artifacts:
      - sourcePath: README.md
        destinationPath: README.md
        mode: "100644"
        size: 11
        contentDigest: sha256:4af65fcf7e8ca1d236757c18eab9a18ffad1405f43222d582ead442382cac077
    releaseRecordDigest: sha256:9ba7220c6e74e326c401dbbd7bf8f8f803d1dcb9937f4f3dfbfd62196d12d0a3
  rel-sha256:ae3ac141ec797892ffc2381ca385af5178f9d0205472c409419d1e0463de88e8:
    materializerVersion: "1"
    artifactSourceCommit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    artifactSetDigest: sha256:a9756965cde386067fdf3b355b07180faedea70caf651e3675dc9b77c63a6fd9
    artifactInventoryDigest: sha256:6f21818abaf4029e8e29d217cd1ff087e3ca3031a9984dc5ece763f9360d618e
    releaseAssetInventoryDigest: sha256:099c46be57862d9fbb9619a9507b8b8e37f57b6187607f613c8ea6cbff2afe0b
    artifacts:
      - sourcePath: README.md
        destinationPath: README.md
        mode: "100644"
        size: 11
        contentDigest: sha256:e1e5120c529c576c09b255e2878d1d7565d165b88761f2cba34cbec3a444a069
    releaseRecordDigest: sha256:430b2dcc86c2ba60c6acef3bbaba9f41b0e7d2d72556f00cce5e54260675788b
  rel-sha256:ccea107d71593a1a81ec07c3cb0402fabff8056a7c6c9122f33c364fd1bc25a9:
    releaseRecordDigest: sha256:e943a830d7cf3e2e1c5749dcaf2249c44c6de5b0c8b946673857f8135317566b
    materializerVersion: "1"
    artifactSourceCommit: cccccccccccccccccccccccccccccccccccccccc
    artifactSetDigest: sha256:a5e3388c4ed59ef9ac2e2a3314b06c1474ca8156c7d7ecd1fe0a73cd3667df2b
    artifactInventoryDigest: sha256:b08da0a43d5c18aba5c11ff10b62374964f5a515fb0edb955f8fe0b0f037c69f
    releaseAssetInventoryDigest: sha256:2f21d2bae1377518ee27c2f34bc6e191c0891220cbbe6ecd8f1ea0e8b2951bed
    artifacts:
      - sourcePath: README.md
        destinationPath: README.md
        mode: "100644"
        size: 21
        contentDigest: sha256:bf3e79ddf6b7ab375b03723ebcfa47b4df5401f06e8938dcc51417a5350acbd1
  rel-sha256:3ad5b5d470c04bc4077ab597c0156d65f398391c46502fa4470a5612ffc0eb40:
    materializerVersion: "1"
    artifactSourceCommit: "1111111111111111111111111111111111111111"
    artifactSetDigest: sha256:51224e074f80b2378d8e9466ef2712b79f80196aac178d5b0d959556e9f28867
    artifactInventoryDigest: sha256:4618b4c8e4375e8521a2f8ccb5a5842b190455f05679079aba80fc60f25e3a5e
    releaseAssetInventoryDigest: sha256:12c6a18d9657cfa33805a17e8e11e280279a0fe8895cea22c92e2b7e14509402
    artifacts:
      - sourcePath: README.md
        destinationPath: README.md
        mode: "100644"
        size: 18
        contentDigest: sha256:952526de11df72e759f17ec184c16c0314498820607b07fc090fb896f7dadef4
    releaseRecordDigest: sha256:0d8224e77c8b0a6b12f330340a5347b0325ff20a45ab5dfedff93ba75409fbac
channels:
  canary: rel-sha256:3ad5b5d470c04bc4077ab597c0156d65f398391c46502fa4470a5612ffc0eb40
  stable: rel-sha256:ae3ac141ec797892ffc2381ca385af5178f9d0205472c409419d1e0463de88e8
channelOrder:
  - canary
  - stable
`;
