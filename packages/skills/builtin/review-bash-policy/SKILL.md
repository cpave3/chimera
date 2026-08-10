---
name: review-bash-policy
description: Review bash commands and permission outcomes from a Chimera session to identify scary-command rule gaps, false positives, and repeated approval patterns.
---

# Review bash policy

Use this skill when the user wants to inspect bash behavior from a prior session or refine Chimera's command policy.

## Workflow

1. Identify the session ID. If unknown, run `chimera sessions list --all`.
2. Run the deterministic extractor:

   ```bash
   chimera sessions review-bash <session-id> --all --json
   ```

3. Review the structured commands and historical audit outcomes. Focus on:
   - commands automatically allowed that should match a known scary rule;
   - commands repeatedly prompted or rejected despite being routine development work;
   - repeated user approvals that indicate an overly conservative rule;
   - production-targeted mutations, force pushes, destructive deletion, credential exposure, or system-level writes;
   - disagreement between historical decisions and the current policy.
4. Produce a report with concrete examples, proposed rule changes, and regression fixtures.
5. Never edit policy rules automatically. Ask for explicit approval before implementing proposed changes.

## Reporting format

For each actionable item include:

- redacted command or command family;
- session and historical outcome;
- current policy result;
- why the behavior is a false positive or false negative;
- proposed rule change;
- exact regression test cases.

The extractor redacts likely credentials, but treat reports as sensitive because commands and paths may still reveal project information.
