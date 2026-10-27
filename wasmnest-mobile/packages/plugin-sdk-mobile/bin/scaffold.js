/**
 * wasmnest-plugin 脚手架与校验命令：create / manifest / validate（自 cli.js 拆出）
 */
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { generateManifest } from "./manifest-gen.js"
import { SDK_ROOT, TEMPLATE_DIR, readJson, walk, fillPlaceholders, toPosix } from "./lib.js"

// ==================== 命令：create ====================

function cmdCreate(positional, flags) {
  const [id, name] = positional
  if (!id || !name) {
    console.error('用法: wasmnest-plugin create <id> <name> [--author <author>] [--dir <dir>]')
    console.error('示例: wasmnest-plugin create com.example.my-plugin "My Plugin" --author "me"')
    process.exit(1)
  }
  if (!/^[a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*$/.test(id)) {
    console.error(`非法插件 id: "${id}" — 使用反域名风格，如 com.example.my-plugin`)
    process.exit(1)
  }
  if (!id.includes('.')) {
    console.error(`插件 id 应包含域名段（反域名风格）: "${id}"`)
    process.exit(1)
  }

  const author = flags.author || ''
  const last = id.split('.').pop()
  const outDir = resolve(process.cwd(), flags.dir || last)
  if (existsSync(outDir)) {
    console.error(`目标目录已存在: ${outDir}`)
    process.exit(1)
  }

  // 派生身份：crate 名 / 结构体名 / npm 包名
  const crate = `wasmnest_plugin_${last.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '')}`
  const struct = `${last
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('')}Plugin`
  const pkgName = `@wasmnest/plugin-${last}`

  // 插件类型：默认 wasm（前端 + WASM 后端）；--ts-only 生成纯前端插件
  const tsOnly = flags['ts-only'] === true
  const pluginType = tsOnly ? 'ts-only' : 'wasm'
  // 注意：值内直接嵌入实际 crate 名（fillPlaceholders 按序替换，不能引用占位符本身）
  const rustLibraryLine = tsOnly ? '' : `  "rustLibrary": "${crate}",\n`

  // SDK 依赖标识：--registry 引用已发布版本（npm + crates.io），默认引用本地 SDK 相对路径
  const sdkPkg = readJson(join(SDK_ROOT, 'package.json'), 'SDK package.json')
  const sdkJs =
    flags.registry === true ? `^${sdkPkg.version}` : `file:${toPosix(relative(outDir, SDK_ROOT))}`
  const sdkRust =
    flags.registry === true
      ? `"${sdkPkg.version}"`
      : `{ path = "${toPosix(relative(join(outDir, 'rust'), join(SDK_ROOT, 'rust')))}" }`

  // 复制模板并填充占位符
  cpSync(TEMPLATE_DIR, outDir, { recursive: true })
  if (tsOnly) {
    rmSync(join(outDir, 'rust'), { recursive: true, force: true })
  }
  fillPlaceholders(walk(outDir), {
    '{{ID}}': id,
    '{{NAME}}': name,
    '{{AUTHOR}}': author,
    '{{CRATE}}': crate,
    '{{STRUCT}}': struct,
    '{{PKG_NAME}}': pkgName,
    '{{SDK_JS}}': sdkJs,
    '{{SDK_RUST}}': sdkRust,
    '{{PLUGIN_TYPE}}': pluginType,
    '{{RUST_LIBRARY_LINE}}': rustLibraryLine,
  })

  console.log(`\n[wasmnest-plugin] 已生成插件工程: ${outDir}`)
  console.log(`  id:         ${id}`)
  console.log(`  name:       ${name}`)
  console.log(`  pluginType: ${pluginType}${tsOnly ? '' : ` (crate: ${crate})`}`)
  console.log(`\n下一步：`)
  console.log(`  cd ${toPosix(relative(process.cwd(), outDir)) || '.'}`)
  console.log(`  pnpm install`)
  console.log(`  pnpm run dev            # 浏览器开发环境（HMR，无需真机）`)
  console.log(`  pnpm run build        # 构建（vite + WASM）`)
  console.log(`  pnpm run package      # 打包 dist/${id}.zip 插件包`)
}


// ==================== 命令：manifest（自动填充） ====================

function cmdManifest(flags) {
  const cwd = process.cwd()
  const check = flags.check === true
  try {
    const { changed, report } = generateManifest(cwd, { check })
    if (!changed) {
      console.log('[wasmnest-plugin] plugin.json 已是最新，无需更新')
      return
    }
    for (const line of report) console.log(`[wasmnest-plugin]   ${line}`)
    if (check) {
      console.log('[wasmnest-plugin] --check 模式：plugin.json 与源码不一致（未写入）')
      process.exit(1)
    }
    console.log('[wasmnest-plugin] plugin.json 已根据源码自动填充')
  } catch (e) {
    console.error(`[wasmnest-plugin] manifest 生成失败: ${e.message}`)
    process.exit(1)
  }
}

/** 从目录向上查找 vite 可执行文件（兼容 npm workspace 依赖 hoist 到仓库根的场景） */

// ==================== 命令：validate（清单校验） ====================

/** 合法权限列表（与宿主 src/plugin/permission.ts 权限映射键同步） */
const VALID_PERMISSIONS = new Set([
  'terminal:output',
  'session:read',
  'ui:settings',
  'ui:route',
  'ui:dialog',
  'ui:back',
  'network:http',
  'storage',
  'fs:read',
  'fs:write',
  'bus',
  'system:open',
  'peer',
  'mdns',
  'ws:client',
  'auth',
  'notify',
  'metrics:read',
])

const VALID_PLUGIN_TYPES = new Set(['wasm', 'ts-only', 'rust', 'rust-ts'])
// 装配角色（manifest `type`，ADR 0032）：真源 = wasm-core `PluginKind`。
// `system` / `application` 是历史拼写，宿主反序列化仍按别名接受，这里只告警。
const VALID_PLUGIN_KINDS = new Set(['basic-service', 'internal-business', 'business-app'])
const LEGACY_PLUGIN_KINDS = new Map([
  ['system', 'basic-service'],
  ['application', 'business-app'],
])
const WASM_HASH_RE = /^sha256-[0-9a-f]{64}$/i

// 适配平台取值域（manifest `platform`，必填，与 id/name/version 同档）。
// 真源是 SDK rust/src/types.rs::PluginPlatform（serde rename_all = "lowercase"）；
// 宿主加载 / 安装期按本端校验：移动拒 desktop、桌面拒 mobile，both 两端均可。
const VALID_PLATFORMS = new Set(['desktop', 'mobile', 'both'])

function cmdValidate(flags) {
  const dir = resolve(process.cwd(), flags.dir || '.')
  const manifestPath = join(dir, 'plugin.json')
  const errors = []
  const warnings = []

  if (!existsSync(manifestPath)) {
    console.error(`[wasmnest-plugin] 缺少 plugin.json: ${dir}`)
    process.exit(1)
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    console.error(`[wasmnest-plugin] plugin.json 不是合法 JSON: ${e.message}`)
    process.exit(1)
  }

  // id：反域名风格
  if (
    typeof manifest.id !== 'string' ||
    !/^[a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*$/.test(manifest.id) ||
    !manifest.id.includes('.')
  ) {
    errors.push(`id 非法: "${manifest.id}" — 使用反域名风格，如 com.example.my-plugin`)
  }

  // 必填字段（platform 与 id/name/version 同档：宿主反序列化无缺省，缺失即拒装）
  for (const field of ['name', 'version', 'platform', 'main', 'pluginType', 'permissions', 'contributes']) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      errors.push(`缺少必填字段: ${field}`)
    }
  }

  // platform 取值域（拼写与宿主端门禁词汇同源；未知取值在宿主反序列化即拒）
  if (manifest.platform && !VALID_PLATFORMS.has(manifest.platform)) {
    errors.push(
      `platform 非法: "${manifest.platform}"（允许: ${[...VALID_PLATFORMS].join(' / ')}）`,
    )
  }

  // pluginType / rustLibrary / wasmHash
  if (manifest.pluginType && !VALID_PLUGIN_TYPES.has(manifest.pluginType)) {
    errors.push(
      `pluginType 非法: "${manifest.pluginType}"（允许: ${[...VALID_PLUGIN_TYPES].join(' / ')}）`,
    )
  }
  // type（装配角色）：非法取值构建期拒；历史拼写只告警（宿主仍按别名接受）
  if (manifest.type !== undefined && manifest.type !== null && manifest.type !== '') {
    if (!VALID_PLUGIN_KINDS.has(manifest.type) && !LEGACY_PLUGIN_KINDS.has(manifest.type)) {
      errors.push(
        `type 非法: "${manifest.type}"（允许: ${[...VALID_PLUGIN_KINDS].join(' / ')}）`,
      )
    } else if (LEGACY_PLUGIN_KINDS.has(manifest.type)) {
      warnings.push(
        `type="${manifest.type}" 是历史拼写，改写为 "${LEGACY_PLUGIN_KINDS.get(manifest.type)}"`,
      )
    }
  }
  if (manifest.pluginType === 'wasm' && !manifest.rustLibrary) {
    errors.push('pluginType=wasm 时必须提供 rustLibrary（与 Cargo.toml 包名一致）')
  }
  if (manifest.wasmHash !== undefined && !WASM_HASH_RE.test(manifest.wasmHash)) {
    errors.push(`wasmHash 格式非法: "${manifest.wasmHash}"（应为 sha256-<64位hex>）`)
  }

  // 权限
  if (Array.isArray(manifest.permissions)) {
    const unknown = manifest.permissions.filter((p) => !VALID_PERMISSIONS.has(p))
    if (unknown.length) {
      errors.push(`未知权限: ${unknown.join(', ')}（合法列表见宿主 permission.ts）`)
    }
  }

  // main 产物存在性（未构建仅警告）
  const distMain = join(dir, 'dist', manifest.main || 'index.js')
  if (!existsSync(distMain)) {
    warnings.push(`dist/${manifest.main || 'index.js'} 不存在 — 尚未构建（pnpm run build）`)
  }

  // contributes 结构
  if (manifest.contributes && typeof manifest.contributes !== 'object') {
    errors.push('contributes 必须是对象')
  }

  // contributes.monitorPanels（monitor 统一壳的自定义面板注册元数据）
  // 只登记 id / title / order；面板实现住提供方应用工程（mountMonitorPanel），
  // 因此这里不校验组件路径。非法条目会让面板「列得出来、挂不上」，构建期判死。
  const monitorPanels = manifest.contributes?.monitorPanels
  if (monitorPanels !== undefined && monitorPanels !== null) {
    if (!Array.isArray(monitorPanels)) {
      errors.push('contributes.monitorPanels 必须是数组')
    } else {
      const panelIds = new Set()
      for (const entry of monitorPanels) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`contributes.monitorPanels 条目形态非法: ${JSON.stringify(entry)}`)
          continue
        }
        if (typeof entry.id !== 'string' || entry.id.trim() === '') {
          errors.push(`contributes.monitorPanels 条目缺非空 id: ${JSON.stringify(entry)}`)
        } else if (panelIds.has(entry.id)) {
          errors.push(`contributes.monitorPanels 重复 id: ${entry.id}`)
        } else {
          panelIds.add(entry.id)
        }
        if (typeof entry.title !== 'string' || entry.title.trim() === '') {
          errors.push(`contributes.monitorPanels 条目缺非空 title: ${JSON.stringify(entry)}`)
        }
        if (entry.order !== undefined && !Number.isFinite(entry.order)) {
          errors.push(`contributes.monitorPanels 条目 order 非法（须为数字）: ${JSON.stringify(entry)}`)
        }
      }
    }
  }


  for (const w of warnings) console.log(`  ⚠ ${w}`)
  for (const e of errors) console.error(`  ✗ ${e}`)

  if (errors.length) {
    console.error(`\n[wasmnest-plugin] validate 失败: ${errors.length} 个错误`)
    process.exit(1)
  }
  console.log(
    `\n[wasmnest-plugin] validate 通过${warnings.length ? `（${warnings.length} 个警告）` : ''}`,
  )
}


export { cmdCreate, cmdManifest, cmdValidate }
