/**
 * Template rendering for notification messages. Templates are plain text
 * with `{variable}` placeholders (documented per category in docs/09);
 * unknown placeholders render empty. When `dropEmptyOptionsLine` is set,
 * a line consisting only of "Options: {options}" is dropped entirely when
 * the options variable is empty (mirrors the opencode-lark-bridge template
 * convention).
 * @module dsh-lark-bridge/render
 */

export type RenderValue = string | number | undefined
export type RenderVars = Record<string, RenderValue>

export interface RenderOptions {
  /** Drop "Options: {options}" lines whose options resolve to empty. */
  dropEmptyOptionsLine?: boolean
  /**
   * Drop a line that consists only of a label prefix plus a single empty
   * variable. Keys are variable names; values are the accepted static label
   * prefixes (after removing all placeholders, trimmed). Example: to drop
   * "工作区: {workspace}" when workspace is empty, pass
   * `{ workspace: ['', '工作区:', '工作区：', 'Workspace:'] }`.
   */
  dropEmptyVarLine?: Record<string, readonly string[]>
}

/**
 * Shared drop rule for workspace/project label lines: a line that is only
 * "工作区: {workspace}" (or a full-width colon / English variant) is dropped
 * when the workspace is unknown. Applied to every category's frame template.
 */
export const WORKSPACE_DROP_RULE: Record<string, readonly string[]> = {
  workspace: ['', '工作区:', '工作区：', '项目:', '项目：', 'Workspace:', 'Project:'],
  workspaceTitle: ['', '工作区:', '工作区：', '项目:', '项目：', 'Workspace:', 'Project:'],
}

/** Replace `{var}` placeholders; unknown names become empty strings. */
export function renderTemplate(template: string, vars: RenderVars, options: RenderOptions = {}): string {
  const lines = template.split('\n')
  const output: string[] = []
  let blankRun = 0
  for (const raw of lines) {
    // Decide on the RAW line: placeholder replacement happens below.
    if (options.dropEmptyOptionsLine === true && isEmptyOptionsLine(raw, vars)) continue
    if (options.dropEmptyVarLine !== undefined && isDroppedVarLine(raw, vars, options.dropEmptyVarLine)) continue
    let line = raw
    for (const [name, value] of Object.entries(vars)) {
      line = line.replaceAll(`{${name}}`, value === undefined || value === null ? '' : String(value))
    }
    line = line.replaceAll(/\{[A-Za-z0-9_]+\}/g, '').trimEnd()
    if (line.trim() === '') {
      blankRun += 1
      if (blankRun > 1) continue
    } else {
      blankRun = 0
    }
    output.push(line)
  }
  return output.join('\n').trimEnd()
}

/** True when the line is only an "Options:" prefix plus the empty {options} var. */
function isEmptyOptionsLine(line: string, vars: RenderVars): boolean {
  if (!line.includes('{options}')) return false
  const value = vars.options
  if (value !== undefined && value !== '') return false
  const staticText = line.replace(/\{[A-Za-z0-9_]+\}/g, '').trim()
  return staticText === '' || staticText === 'Options:' || staticText === 'Options'
}

/**
 * True when the line consists only of a label prefix (one of `prefixes`) plus
 * a single empty variable from `rules`. A line carrying other placeholders or
 * a non-empty referenced variable is never dropped.
 */
function isDroppedVarLine(line: string, vars: RenderVars, rules: Record<string, readonly string[]>): boolean {
  const placeholders = line.match(/\{[A-Za-z0-9_]+\}/g) ?? []
  if (placeholders.length === 0) return false
  // The line must reference exactly one variable (the labelled one) — a line
  // mixing it with other placeholders is substantive and stays.
  const names = [...new Set(placeholders.map(token => token.slice(1, -1)))]
  if (names.length !== 1) return false
  const name = names[0]!
  const prefixes = rules[name]
  if (prefixes === undefined) return false
  const value = vars[name]
  if (value !== undefined && value !== '') return false
  const staticText = line.replace(/\{[A-Za-z0-9_]+\}/g, '').trim()
  return prefixes.includes(staticText)
}

/** One selectable option of an ask_user_question question. */
export interface RenderOption {
  label: string
  description?: string
}

/** Render options as an indented bullet list (empty string when none). */
export function renderOptions(options: readonly RenderOption[] | undefined): string {
  if (options === undefined || options.length === 0) return ''
  return options
    .map(option => `  · ${option.label}${option.description !== undefined && option.description !== '' ? ` — ${option.description}` : ''}`)
    .join('\n')
}
