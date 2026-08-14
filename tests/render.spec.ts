import { describe, expect, it } from 'vitest'
import { renderOptions, renderTemplate } from '../src/render.js'

describe('renderTemplate', () => {
  it('replaces variables and leaves unknown placeholders empty', () => {
    const text = renderTemplate('Hello {name} {missing}', { name: 'DSH' })
    expect(text).toBe('Hello DSH')
  })

  it('renders numbers and undefined as empty strings', () => {
    expect(renderTemplate('t{turn} u{u}', { turn: 3, u: undefined })).toBe('t3 u')
  })

  it('trims trailing newlines and collapses blank runs', () => {
    const text = renderTemplate('a\n\n\n\nb\n', {})
    expect(text).toBe('a\n\nb')
  })

  it('drops an empty Options line when dropEmptyOptionsLine is set', () => {
    const template = '问题\nOptions: {options}\n→ 完'
    expect(renderTemplate(template, { options: '' }, { dropEmptyOptionsLine: true })).toBe('问题\n→ 完')
    expect(renderTemplate(template, { options: '  · A' }, { dropEmptyOptionsLine: true })).toBe('问题\nOptions:   · A\n→ 完')
  })

  it('keeps an empty Options line when dropEmptyOptionsLine is unset', () => {
    const template = '问题\nOptions: {options}'
    expect(renderTemplate(template, { options: '' })).toBe('问题\nOptions:')
  })

  it('does not drop a line with other static content', () => {
    const text = renderTemplate('{question}\nResult: {options}', { question: 'q?', options: '' }, { dropEmptyOptionsLine: true })
    expect(text).toBe('q?\nResult:')
  })
})

describe('renderOptions', () => {
  it('renders labels and descriptions as an indented bullet list', () => {
    const text = renderOptions([
      { label: 'Yes (Recommended)', description: 'go ahead' },
      { label: 'No' },
    ])
    expect(text).toBe('  · Yes (Recommended) — go ahead\n  · No')
  })

  it('returns empty for missing or empty options', () => {
    expect(renderOptions(undefined)).toBe('')
    expect(renderOptions([])).toBe('')
  })
})
