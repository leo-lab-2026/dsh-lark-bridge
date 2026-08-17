/**
 * permission category: notifies when an approval question is pending on the
 * answerer chain. Durable facts from the user-approval seam: `approval/asked`
 * opens the pause (with the audit id), `approval/decided` with the same id
 * closes it. Machine-answered requests (ACP, policy rejections) settle
 * within the engine's grace window and never notify.
 * @module dsh-lark-bridge/categories/permission
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { renderTemplate, WORKSPACE_DROP_RULE } from '../render.js'
import { makeIdempotencyKey } from '../transport/lark-cli.js'
import type { Category, CategoryEngine, SessionRef } from './types.js'

export const permissionCategory: Category = {
  id: 'permission',

  handle(session: SessionRef, event: SessionEvent, engine: CategoryEngine): void {
    if (event.type === 'approval/asked') {
      const asked = event.data
      const id = String(asked.id)
      engine.beginPause(session, 'permission', `approval:${id}`, () => ({
        text: renderTemplate(engine.templateFor('permission'), {
          ...engine.commonVars(session),
          tool: asked.toolName,
          reason: asked.reason ?? '',
        }, { dropEmptyVarLine: WORKSPACE_DROP_RULE }),
        idempotencyKey: makeIdempotencyKey(['permission', String(session.id), id]),
      }))
      return
    }
    if (event.type === 'approval/decided') {
      engine.settlePause(`approval:${String(event.data.id)}`)
    }
  },
}
