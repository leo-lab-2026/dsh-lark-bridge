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
}

/** Replace `{var}` placeholders; unknown names become empty strings. */
export function renderTemplate(template: string, vars: RenderVars, options: RenderOptions = {}): string {
  const lines = template.split('\n')
  const output: string[] = []
  let blankRun = 0
  for (const raw of lines) {
    // Decide on the RAW line: placeholder replacement happens below.
    if (options.dropEmptyOptionsLine === true && isEmptyOptionsLine(raw, vars)) continue
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
