// Conventional Commits v1.0.0 強制 (要件 §6.6)。harness-check の commitlint subjob が参照。
// setup は対象 repo の package.json を変更せず standalone file を emit する (非破壊)。
module.exports = {
  extends: ["@commitlint/config-conventional"],
};
