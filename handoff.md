# Teammate Handoff

## Session State (세션 복구용 필수 필드)
- **current_phase**: [Phase 0/1/2/3/3.5/4/5/R]
- **completed_tasks**: [완료된 태스크 ID 목록]
- **blocked_items**: [블로킹 이슈]
- **next_steps**: [다음에 해야 할 일]
- **active_worktrees**: [활성 worktree 경로 + 상태]

## Outgoing Teammate Summary
- **Role**: [what this teammate was doing]
- **Agent**: [subagent_type used]
- **Termination reason**: [completed / stuck / error loop / context full / timeout]

## What Was Completed
- [bullet list of done work]
- Files created/modified: [paths]

## What Remains
- [bullet list of remaining tasks]
- Expected approach: [brief strategy]

## Gotchas & Warnings
- [things the next teammate should know]
- [edge cases discovered]
- [failed approaches — don't repeat these]

## Key File Paths
- [list of files relevant to this work]

## Interface Changes (다른 모듈에 영향)
- [API 계약 변경, 공유 타입 변경, DB 스키마 변경 등]

---

## For Incoming Teammate

Read this handoff, then:
1. Confirm understanding of remaining tasks
2. Submit your plan before starting
3. Report at checkpoints
