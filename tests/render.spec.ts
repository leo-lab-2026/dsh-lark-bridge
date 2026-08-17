import { describe, expect, it } from 'vitest'
import { renderOptions, renderTemplate, WORKSPACE_DROP_RULE } from '../src/render.js'

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

describe('renderTemplate dropEmptyVarLine', () => {
  it('drops a label-only workspace line when workspace is empty', () => {
    const template = '🔔 标题\n工作区: {workspace}\n会话: {sessionTitle}'
    const text = renderTemplate(template, { workspace: '', sessionTitle: 's1' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })
    expect(text).toBe('🔔 标题\n会话: s1')
  })

  it('keeps the workspace line when a value is present', () => {
    const template = '🔔 标题\n工作区: {workspace}\n会话: {sessionTitle}'
    const text = renderTemplate(template, { workspace: 'my-project', sessionTitle: 's1' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })
    expect(text).toBe('🔔 标题\n工作区: my-project\n会话: s1')
  })

  it('drops full-width and English label variants', () => {
    expect(renderTemplate('工作区：{workspace}', { workspace: '' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })).toBe('')
    expect(renderTemplate('Workspace: {workspace}', { workspace: '' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })).toBe('')
    expect(renderTemplate('Project: {workspace}', { workspace: '' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })).toBe('')
  })

  it('keeps a line that mixes the workspace var with other content', () => {
    const template = '项目 {workspace} 编号 42'
    expect(renderTemplate(template, { workspace: '' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })).toBe('项目  编号 42')
  })

  it('keeps a line whose label is not in the accepted prefixes', () => {
    const template = '上下文: {workspace}'
    expect(renderTemplate(template, { workspace: '' }, { dropEmptyVarLine: WORKSPACE_DROP_RULE })).toBe('上下文:')
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
