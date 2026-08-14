import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { installUserSettings } from '../src/settings.js'
import { createLogger, MemorySettingsProvider, testConfig } from './helpers.js'

async function createRuntime(config = testConfig()) {
  const ctx = new Context()
  const logger = createLogger()
  await ctx.plugin(MemorySettingsProvider)
  const installed = installUserSettings(ctx, config, logger)
  // Let the inject callback bind the scope.
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, logger, installed }
}

describe('installUserSettings', () => {
  it('registers the namespace and resolves config as the base layer', async () => {
    const { installed } = await createRuntime(testConfig({ target: { chatId: 'oc_base', userId: '' }, dryRun: true }))
    expect(installed.scope).toBeDefined()
    expect(installed.current()).toEqual({
      target: { chatId: 'oc_base', userId: '' },
      dryRun: true,
    })
  })

  it('user-layer updates win over the base and apply live (no restart)', async () => {
    const { installed } = await createRuntime(testConfig({ target: { chatId: 'oc_base', userId: '' } }))
    await installed.scope!.update({ chatId: 'oc_user' })
    expect(installed.current()).toEqual({
      target: { chatId: 'oc_user', userId: '' },
      dryRun: false,
    })
    await installed.scope!.update({ dryRun: true })
    expect(installed.current().dryRun).toBe(true)
  })

  it('degrades to config-only behavior without a settings provider', async () => {
    const ctx = new Context()
    const logger = createLogger()
    const config = testConfig({ target: { chatId: 'oc_only', userId: '' } })
    const installed = installUserSettings(ctx, config, logger)
    expect(installed.scope).toBeUndefined()
    expect(installed.current()).toEqual({
      target: { chatId: 'oc_only', userId: '' },
      dryRun: false,
    })
  })
})
