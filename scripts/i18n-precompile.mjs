/**
 * i18n 消息预编译 Vite 插件（宿主前端）
 *
 * 背景（安全审查 #50 / P2-3）：`script-src` 里的 `'unsafe-eval'` 是为了让
 * vue-i18n 在运行期编译消息（`new Function('return ' + code)`）。消息一旦在构建期
 * 预编译成 `(ctx) => string` 函数，运行时就不再需要消息编译器，`'unsafe-eval'` 才能撤。
 *
 * 与应用仓 `wasmnest-apps/scripts/lib/i18n-precompile.mjs` 同源：两仓独立构建、
 * 禁止反向引用，故实现各持一份；改代码生成逻辑时两侧必须同步（本文件供宿主
 * `wasmnest-desktop` / `wasmnest-mobile` 的 vite 配置使用）。
 *
 * 为什么不用 `@intlify/unplugin-vue-i18n`：该插件的资源预编译走 acorn，只认
 * `export default { ... }` 字面量（bundle-utils 的 `generateJavaScript`），带类型注解
 * 或具名导出的语言模块会被直接拒绝。本仓宿主文案虽是字面量导出，但为与 apps 仓
 * 保持同一套行为（类型化消息模块 + 具名导出），这里复用其底层引擎
 * `@intlify/bundle-utils`（与 unplugin 同一套 message-compiler 代码生成），只把
 * 「取消息对象」这一步换成 TS 求值。
 *
 * 工作方式（仅构建期，产物里没有求值代码）：
 * 1. 命中 `include` 的消息模块 → TypeScript 转 CJS → 在 Node 里求值拿到纯数据对象；
 * 2. 每个导出对象交给 `generateJSON` 逐条编译成 `(ctx) => ...`（与 vue-i18n 运行期
 *    `compile` 完全同构，支持 `{name}` 插值 / `|` 复数 / 嵌套 key）；
 * 3. 用预编译结果替换模块内容，导出名保持不变。
 *
 * 失败一律 fail-visible：命中文件里出现非纯数据导出、或消息存在编译错误（未闭合插值、
 * 非法复数分支等）直接让构建失败并指出文件，禁止静默退回运行期编译。
 *
 * **覆盖范围边界（2026-11-03 补齐）**：本插件只处理 `include` 清单里的**宿主文案**
 * （桌面 2 个 / 移动 8 个 locale 文件）。它**管不到插件运行期注册的文案**——
 * 各 wasm 应用在 activate 期经 `context.i18n.registerMessages(locale, messages)`
 * 把消息塞进宿主 i18n，那批消息的形态由应用仓自己的构建决定。
 *
 * 由于两端已切到 runtime-only 构建（编译器不在产物里），未经预编译的字符串消息
 * 会退化：默认 locale 仍能取到原串，但**非默认 locale 返回 key 字面量、插值不替换**。
 * 所以各应用仓必须自己跑同一个预编译（`wasmnest-apps/scripts/lib/i18n-precompile.mjs`，
 * 与本文件同源），把 `messages` 导出成消息函数。宿主侧的 fail-visible 兜底在
 * `wasmnest-mobile/src/plugin/context.ts` 的 `warnIfUncompiled`。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { generateJSON } from '@intlify/bundle-utils'

const PLUGIN_NAME = 'wasmnest-i18n-precompile'

/** 去掉 Vite 的 query（`?import` / `?t=` 等），只留文件路径 */
function stripQuery(id) {
  return id.split('?')[0]
}

/**
 * 把 TS 消息模块求值成纯数据
 *
 * 语言文件是「数据模块」：只有字面量对象与 `import type`，不含运行期逻辑。
 * 因此这里用 TypeScript 官方 transpile 去类型 + `vm` 执行，比引入额外打包器稳定；
 * 相对导入（如 `./mechanism`）递归求值，裸模块导入直接报错——消息模块不允许依赖
 * 运行期库，出现即说明 include 清单选错了文件。
 */
function loadMessageModule(filename, cache) {
  const cached = cache.get(filename)
  if (cached) return cached.exports

  const source = fs.readFileSync(filename, 'utf8')
  const js = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText

  const mod = { exports: {} }
  cache.set(filename, mod)

  const localRequire = (specifier) => {
    if (!specifier.startsWith('.')) {
      throw new Error(
        `[${PLUGIN_NAME}] ${path.relative(process.cwd(), filename)} 引用了非相对模块 "${specifier}"。\n` +
          '消息模块必须是纯数据（只允许相对导入），否则无法在构建期求值预编译。',
      )
    }
    const resolved = resolveTsFile(path.resolve(path.dirname(filename), specifier))
    return loadMessageModule(resolved, cache)
  }

  const wrapper = `(function (exports, require, module, __filename, __dirname) {${js}\n})`
  const fn = vm.runInThisContext(wrapper, { filename })
  fn(mod.exports, localRequire, mod, filename, path.dirname(filename))
  return mod.exports
}

/** `./mechanism` → `./mechanism.ts` / `./mechanism/index.ts` */
function resolveTsFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.mts`, path.join(base, 'index.ts')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`[${PLUGIN_NAME}] 无法解析消息模块导入：${base}`)
}

/** 判断导出值是否是「消息表」：非空纯对象，叶子全为字符串 */
function isMessageTable(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  if (entries.length === 0) return false
  return entries.every(([, child]) => {
    if (typeof child === 'string') return true
    return isMessageTable(child)
  })
}

/** 单个消息表 → 预编译代码（`{ key: (ctx) => ... }`） */
function compileTable(table, filename, env, keyPath) {
  let generated
  try {
    generated = generateJSON(JSON.stringify(table), {
      type: 'bare',
      filename,
      env,
      strictMessage: false,
    })
  } catch (error) {
    throw new Error(
      `[${PLUGIN_NAME}] 消息预编译失败：${path.relative(process.cwd(), filename)}${keyPath ? ` (${keyPath})` : ''}\n${error.message}`,
    )
  }
  return typeof generated === 'string' ? generated : generated.code
}

/** 导出值 → 预编译后的源码片段 */
function renderExport(name, value, filename, env) {
  if (isMessageTable(value)) return compileTable(value, filename, env, name)
  if (typeof value === 'string') return JSON.stringify(value)
  throw new Error(
    `[${PLUGIN_NAME}] ${path.relative(process.cwd(), filename)} 的导出 "${name}" 不是消息表或字符串，` +
      '无法预编译。请把它移出 include 清单，或改成纯数据导出。',
  )
}

/** 消息模块求值结果 → 预编译模块源码（导出名保持不变） */
function renderModule(exportsObject, filename, env) {
  const parts = [
    `/* 由 ${PLUGIN_NAME} 在构建期生成（源文件 ${path.basename(filename)}），请勿手改 */`,
  ]
  const names = Object.keys(exportsObject).filter((name) => name !== '__esModule' && name !== 'default')
  for (const name of names) {
    parts.push(`export const ${name} = ${renderExport(name, exportsObject[name], filename, env)}`)
  }
  if (Object.prototype.hasOwnProperty.call(exportsObject, 'default')) {
    parts.push(`export default ${renderExport('default', exportsObject.default, filename, env)}`)
  }
  if (names.length === 0 && !Object.prototype.hasOwnProperty.call(exportsObject, 'default')) {
    throw new Error(
      `[${PLUGIN_NAME}] ${path.relative(process.cwd(), filename)} 没有可预编译的导出。`,
    )
  }
  return `${parts.join('\n\n')}\n`
}

/**
 * @param {{ include: string[] }} options
 *   `include`：相对 app 工程根（vite `root`）的消息模块路径清单。
 *   显式列举而不是 glob：新增语言文件必须进清单，漏了会在运行期暴露（runtime-only
 *   构建对字符串消息直接报错），不会静默退回 eval。
 */
export function i18nPrecompile(options) {
  const includeList = options.include
  let included = new Set(includeList.map((item) => path.normalize(item)))
  let root = process.cwd()
  let env = 'production'
  const moduleCache = new Map()

  return {
    name: PLUGIN_NAME,
    enforce: 'pre',

    configResolved(config) {
      root = config.root
      included = new Set(includeList.map((item) => path.normalize(path.resolve(root, item))))
      env = config.command === 'build' ? 'production' : 'development'
    },

    transform(code, id) {
      const abs = path.normalize(path.resolve(stripQuery(id)))
      if (!included.has(abs)) return null

      // 源码变了要重新求值（dev 下语言文件会热更新）
      const cached = moduleCache.get(abs)
      if (cached && cached.code === code) return { code: cached.output, map: null }

      const exportsObject = loadMessageModule(abs, new Map())
      const output = renderModule(exportsObject, abs, env)
      moduleCache.set(abs, { code, output })
      return { code: output, map: null }
    },
  }
}

export default i18nPrecompile
