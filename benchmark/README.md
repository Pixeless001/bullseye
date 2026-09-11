# Benchmark

`node ./benchmark/run.mjs` validates and prepares deterministic fixture metadata
for harness-specific pilot runs. It deliberately does not invoke an installed
coding agent; point each harness at the emitted manifest and capture its
transcript separately.
