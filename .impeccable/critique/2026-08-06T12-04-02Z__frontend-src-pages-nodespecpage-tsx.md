---
target: /node-specs (NodeSpecPage.tsx)
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 5
timestamp: 2026-08-06T12-04-02Z
slug: frontend-src-pages-nodespecpage-tsx
---
Method: dual-agent (A: design review · B: detector + evidence)

## `/node-specs` (노드 사양 카탈로그) — Design Critique

### Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2/4 | Host Facts SSH collection shows only a static spinner — no per-host progress, no logs |
| 2 | Match System / Real World | 4/4 | Domain-accurate terms/tooltips throughout (bonding, lsblk, os-release parsing) |
| 3 | User Control and Freedom | 3/4 | CSV/paste have preview→apply gating; Host Facts has no confirm step at all |
| 4 | Consistency and Standards | 1/4 | Hardcoded Tailwind palette colors everywhere instead of design tokens (confirmed systemic by both assessments) |
| 5 | Error Prevention | 3/4 | Preview-before-apply is solid; no duplicate-hostname guard within a batch |
| 6 | Recognition Rather Than Recall | 4/4 | Column tooltips, CSV template, supported-headers reference |
| 7 | Flexibility and Efficiency | 4/4 | Block-select+TSV copy, global paste capture, resizable/persisted columns |
| 8 | Aesthetic and Minimalist Design | 2/4 | 7 equally-weighted, differently-colored header buttons, no primary/secondary distinction |
| 9 | Error Recovery | 2/4 | CSV path gives per-row errors; Host Facts collapses failures to an opaque count |
| 10 | Help and Documentation | 3/4 | Contextual tooltips substitute adequately for a manual |
| **Total** | | **28/40** | **Acceptable/Good boundary** |

### Design Specificity Verdict

High specificity (bonding IP separation, lsblk-based SSD/NVMe detection, os-release parsing, hyperthreading-aware CPU fields). detect.mjs returned 0 findings — true negative, its rule set doesn't cover ARIA/focus/ConfirmDialog/MacCard/named-palette-vs-token conventions this repo actually enforces. Browser evidence skipped (no dev server).

### Overall Impression

Domain modeling and CSV/paste import safety pattern (diff preview before write) are genuinely strong. Gap is in this repo's own conventions: raw palette colors instead of tokens, zero focus rings on an entire modal's form controls, and the one "실행"-labeled button (Host Facts SSH) is the least observable action on the page, in direct violation of CLAUDE.md's custom real-time-log rule.

### What's Working
- CSV/paste two-step preview→apply flow (NodeSpecCsvUploadModal.tsx:108-149)
- Cluster-import confirm dialog names exactly which fields are preserved vs overwritten (NodeSpecPage.tsx:737-745)
- Column-header tooltips carry real operational detail (COL_TIPS, NodeSpecPage.tsx:166-180)

### Priority Issues

[P0] Host Facts "실행" button has no real-time log / no log-view toggle — violates CLAUDE.md's mandatory rule. handleCollectHostFacts (NodeSpecPage.tsx:303-334) runs SSH with root/sudo against N hosts, only a spinner, failures collapse to one opaque toast. Fix: stream per-host progress via LogViewer + toggle panel. Command: harden

[P1] Zero focus-visible indicator on every form control in Host Facts modal — SSH user/password inputs, private-key textarea, host-list textarea, both filter selects (NodeSpecPage.tsx:448-464, 782-805) including a password field. Command: harden

[P1] Hardcoded Tailwind palette colors instead of design tokens, systemic across all 4 files — STATUS_CLS (NodeSpecPage.tsx:22-27) + duplicated ACTION_CLS in both modals. Command: colorize

[P1] List fetch failure renders identically to empty table — listQ (NodeSpecPage.tsx:139-148) has no isError branch. Command: harden

[P1] Header overload — 7 equally-weighted actions, no visual hierarchy (NodeSpecPage.tsx:370-412). Command: distill

[P1] Modal close (X) buttons missing aria-label in all 3 modals (NodeSpecCsvUploadModal.tsx:242-245, NodeSpecPasteModal.tsx:280-283, NodeSpecEditModal.tsx:110-113). Command: harden

[P2] Host Facts collection has no confirm step despite being an equivalent upsert to Cluster Import. Command: harden
[P2] No duplicate-hostname guard within a single CSV/paste batch. Command: harden
[P2] Post-apply errors show only a bare count, not per-row detail. Command: harden
[P2] Table wrapper hand-rolls bg-card border instead of MacCard (NodeSpecPage.tsx:498). Command: polish
[P2] SSD/VM toggle buttons communicate state via glyph+color only, no aria-pressed, un-debounced PATCH per click (NodeSpecPage.tsx:634-676). Command: harden
[P3] No size guard on large CSV/paste input — unverified/theoretical.

### Persona Red Flags
Jordan (first-timer): Host Facts asks for root SSH password/private key with zero blast-radius framing, no confirm before firing.
Sam (accessibility): title-only column help; Host Facts modal's 6 form controls (incl. password) have zero focus indicator.
Riley (stress tester): global window paste listener can pop paste-modal from unrelated clipboard action; un-debounced toggle clicks.

### Minor Observations
- exportCsv/downloadCsvTemplate duplicate BOM+Blob+anchor logic
- ACTION_CLS/ACTION_LABEL/DiffRow near-identical between the two import modals
- Role filter dropdown omits "ingress", present in edit modal's ROLES list
- colSpan={15} for empty/skeleton table doesn't match actual column count

### Questions to Consider
1. If Host Facts SSH touches dozens of production hosts with root/sudo, why less confirmation/observability than a single-row delete?
2. Was this screen built before CLAUDE.md's real-time-log rule landed, or is it exempt?
3. Would merging Cluster Import and Host Facts Collection into one guided "가져오기" step reduce confusion?
