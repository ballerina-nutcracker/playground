# Shared HIR validation corpus

`cases.json` declares each fixture's acceptance expectation. Both
`packages/compiler/hir_test.go` and `packages/compiler/tests/hir.test.mjs` read
these same JSON files; Go may reject malformed shape during JSON decoding or
validation, while TypeScript must reject it during validation.

`files` records the source text used by the fixtures: the single emoji occupies
one code-point column, not two UTF-16 columns. Every accepted graph and displayed
node has a matching `sources` entry. Nullable HIR fields are explicit `null`;
collections are never `null`. The automation scope retains Go's existing
`serviceType: null` encoding.

Coverage includes empty collections/programs, required nullable keys, null
collections, malformed/contradictory tags, duplicate and dangling identities,
source index/coordinate disagreements, ownership and function-reference cycles,
entry/exit/export bindings and export indices, root connection batches,
collapsed presence cycles, inactive edges, hidden inline owners, and separate
root/inline emission coverage, stream validity, duplication and node preorder.
Direct and mutual function references are accepted; ownership and collapsed
presence cycles are rejected.

Adversarial parity cases additionally cover required scalar omission/null (including
booleans and source coordinates), contradictory anchor payloads, unavailable but
dangling targets, reference/node/call-disclosure occurrence and availability
agreement, expandable collapsed-edge slots, and expansion-dependent reference
container visibility. Unavailable references still require an existing target;
collapsed edge slots are inert, not invalid, while their reference is expanded.

The symbolic stress case uses 24 direct, independently expandable references and
an edge enabled only when all 24 expand. Its negative counterpart omits exactly
that edge slot. The registered Go and TypeScript suites also test disjoint
exhaustive emission partitions and an overlap confined to the all-expanded
assignment. These checks exercise all 2^24 assignments without enumerating them;
recursive self-references would not provide independent expansion choices.

These are post-baseline contract fixtures, not frozen rendering fixtures. No
SVG, geometry, browser, legacy lowering, or rendering baseline is involved.
