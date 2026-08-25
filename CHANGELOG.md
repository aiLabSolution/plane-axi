# Changelog

## [0.4.0](https://github.com/aiLabSolution/plane-axi/compare/v0.3.2...v0.4.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* `wi search` searches the selected project instead of the whole workspace; pass `--workspace` for the previous behaviour. Addressing a work item outside the selected project, whether by its ref's own prefix or by `--project`, now fails with exit code 1.

### Features

* scope work-item addressing and search to the selected project ([#17](https://github.com/aiLabSolution/plane-axi/issues/17)) ([75b4595](https://github.com/aiLabSolution/plane-axi/commit/75b459524b349e2b89ea3b055e4d3acd7b589162))

## [0.3.2](https://github.com/aiLabSolution/plane-axi/compare/v0.3.1...v0.3.2) (2026-08-15)


### Bug Fixes

* comment list --all hides real comments ([#15](https://github.com/aiLabSolution/plane-axi/issues/15)) ([bb65d81](https://github.com/aiLabSolution/plane-axi/commit/bb65d81c3a1835de31bd786ff2fb000f559af281))

## [0.3.1](https://github.com/aiLabSolution/plane-axi/compare/v0.3.0...v0.3.1) (2026-07-25)


### Bug Fixes

* make the running build identifiable and automate releases ([#7](https://github.com/aiLabSolution/plane-axi/issues/7)) ([592b1a3](https://github.com/aiLabSolution/plane-axi/commit/592b1a3be0fe889d37da7b48480711099b3e5af1))
