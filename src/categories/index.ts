/**
 * Category registry: the ordered list the engine dispatches to. Adding a
 * category (retry, stall, …) means adding one module + listing it here.
 * @module dsh-lark-bridge/categories/index
 */

export { errorCategory } from './error.js'
export { permissionCategory } from './permission.js'
export { questionCategory } from './question.js'
export type { Category, CategoryEngine, SessionRef } from './types.js'
