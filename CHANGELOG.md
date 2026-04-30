# Changelog

## 1.0.0-rc.1 - Unreleased

Public RC hardening:

- Default server bind is loopback-only.
- Public RC source promotion is review-only by default.
- Source promotion requires explicit trusted-write opt-in, verifier pass, critic actual-diff review, and approved final diff receipt.
- File writes, rollback paths, patch application, git staging, and source promotion use realpath/lstat containment checks.
- Rollback failure or incomplete rollback dominates final run status.
- Unsupported provider, model, or lane configuration fails closed by default.
- Release gates include typecheck, build, tests, secret scan, smoke check, and npm audit.
