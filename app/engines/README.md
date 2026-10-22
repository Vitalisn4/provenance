# Meterless engines (pre-existing component)

`hmem/src` and `world-model/src` are copied unchanged from the Apache-2.0 reference implementations in
[Meterless/Meterless](https://github.com/Meterless/Meterless) at commit `1742dec56a66e58eef9dda2d2b865823758ca8cd`
(`engines/hmem/reference/src`, `engines/world-model/reference/src`). Each folder keeps its `LICENSE`.

The official conformance suites from the same commit live in `tests/conformance/` and run against these copies:

```bash
npm run conformance
```

Provenance's own logic stays outside this folder, so the engines stay conformant. Any change to files here must
keep both suites green.
