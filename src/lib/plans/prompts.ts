/**
 * Seed prompts for plan-mode sessions. The planning behavior is a
 * prompt-engineered distillation of the "grill-with-docs" interviewing
 * style (one question at a time, recommendations attached, stress-test
 * against existing docs) rather than an installed skill file, so yaac
 * owns the exact text and no container seeding is needed.
 */

/**
 * Prompt for a new planning session. The agent interviews the user in
 * the terminal and maintains the plan doc in the /plans wiki clone,
 * committing and pushing as decisions land (the webapp renders the
 * working-tree file live, so pushes are for durability, not preview).
 */
export function buildGrillPrompt(topic: string, docFileName: string, sessionId: string): string {
  return [
    `We are planning the following piece of work: ${topic}`,
    '',
    'You are running a design interview ("grill session"). Rules:',
    '- Ask exactly ONE question at a time. Never bundle questions.',
    '- Attach your recommended answer (with a one-line why) to every question.',
    '- Walk the decision tree in dependency order: settle decisions other',
    '  decisions hang on first. Challenge vague requirements and surface',
    '  hidden assumptions; stress-test answers with concrete edge cases.',
    '- Check the repository in /workspace before asking anything the code',
    '  or existing docs can already answer.',
    '',
    `Maintain the plan document at /plans/${docFileName} (the project's`,
    'GitHub wiki, cloned for this session). Start it now with this exact',
    'YAML frontmatter, then keep the body updated as decisions crystallize:',
    '',
    '---',
    'phase: plan',
    `sessions: [${sessionId}]`,
    '---',
    '',
    'Structure the body as: a one-paragraph summary, the decisions made so',
    'far (with their why), open questions, and a proposed approach. Rewrite',
    'sections as understanding improves — it is a living document, not a log.',
    '',
    'After each meaningful update to the document, commit and push it:',
    '  git -C /plans add -A && git -C /plans commit -m "<short message>" && git -C /plans push',
    'If the push is rejected, pull --rebase and push again.',
    '',
    'Begin by reading the repository enough to ground yourself, write the',
    'initial document skeleton, then ask your first question.',
  ].join('\n')
}

/**
 * Prompt for resuming the interview on an existing plan doc (one that has
 * no live session — created in an earlier session, by a teammate, or
 * straight on the wiki).
 */
export function buildResumeGrillPrompt(docFileName: string, sessionId: string): string {
  return [
    'We are resuming a design interview ("grill session") for the existing',
    `plan document /plans/${docFileName}.`,
    '',
    'Rules:',
    '- Ask exactly ONE question at a time. Never bundle questions.',
    '- Attach your recommended answer (with a one-line why) to every question.',
    '- Walk the decision tree in dependency order; challenge vague',
    '  requirements; stress-test answers with concrete edge cases.',
    '- Check the repository in /workspace before asking anything the code',
    '  or existing docs can already answer.',
    '',
    'Start by reading the document and the repository to ground yourself.',
    `Then add ${sessionId} to the document's frontmatter sessions list`,
    '(create the frontmatter block with phase: plan if it is missing),',
    'briefly summarize where the plan stands, and ask the single most',
    'load-bearing open question.',
    '',
    'Keep the document structured as: a one-paragraph summary, decisions',
    'made so far (with their why), open questions, and a proposed approach.',
    '',
    'After each meaningful update to the document, commit and push it:',
    '  git -C /plans add -A && git -C /plans commit -m "<short message>" && git -C /plans push',
    'If the push is rejected, pull --rebase and push again.',
  ].join('\n')
}

/**
 * Prompt for a build session spawned by promoting a plan doc. The doc is
 * readable inside the container at /plans/<file> (same wiki clone).
 */
export function buildBuildPrompt(docFileName: string): string {
  return [
    `Implement the plan described in /plans/${docFileName}.`,
    '',
    'Read that document first — it is the source of truth for scope and',
    'decisions. Work in /workspace (the project worktree on its own branch).',
    'Follow the repository\'s contribution conventions (CLAUDE.md, lint,',
    'tests). If you hit a decision the plan does not cover, choose the',
    'option most consistent with the plan and note it.',
    '',
    'When you discover the plan is wrong or incomplete, update',
    `/plans/${docFileName} to match reality, then commit and push it:`,
    '  git -C /plans add -A && git -C /plans commit -m "<short message>" && git -C /plans push',
  ].join('\n')
}
