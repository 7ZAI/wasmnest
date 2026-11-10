/**
 * 穿透传输字面漂移锁（2026-11-10 收口）
 *
 * 背景：`/p2p-circuit` 是 libp2p multiaddr 的协议名，也是「这条地址是经中继转发的」
 * 唯一判据。能力仓用类型化组件（`Protocol::P2pCircuit`）表达，应用仓（wasm guest
 * 与前端）只能拿字符串判——于是同一字面被手抄到 14 个应用仓生产文件（BedCode 双端 /
 * file-transfer 双端 + rust core / 网络配置中心）。
 *
 * 漂移形态是静默的：某处写成 `/p2p-circuit/`、`p2p-circuit`（缺前导斜杠）或换一种
 * 分隔符，编译过、测试绿，只是那一路的「走中继」判定永远不命中。故本锁钉三件事：
 *
 * - L1 副本清单：应用仓生产源码里出现该标记的文件必须与清单逐项一致——新增副本
 *   / 删文件都会红（新增必须登记并确认字面，删文件必须同步删清单）；
 * - L2 声明一致：`*_MARKER` 常量取值、`MAX_RELAY_ADDRS` 上限、relay 端点形状判据
 *   在两处实现里同形；
 * - L3 能力侧真源未改：`wasmnest-p2p-engine` 仍用 `Protocol::P2pCircuit` 表达标记。
 *
 * 只读源文件、不编译应用仓；路径经 appPaths / libPaths resolver（缺仓 ENOENT 显性
 * 失败，不静默跳过）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { appPath, appsRepoRoot, projectPath } from './support/appPaths'
import { libPath } from './support/libPaths'

/** 传输形态标记的唯一字面（与能力仓 `Protocol::P2pCircuit` 同名协议） */
const CIRCUIT_MARKER = '/p2p-circuit'

/** relay 地址条数上限（`network.relay` schema v1；三处声明必须同值） */
const MAX_RELAY_ADDRS = 16

/**
 * 应用仓生产文件里的字面副本清单（唯一真源在能力仓，这些是「字符串判定」的落点）
 *
 * 新增副本时：先确认写法为 `/p2p-circuit`，再加进本清单；删文件时同步删除。
 * 测试文件（`__tests__/`）不参与扫描——它们只造 fixture。
 */
const PRODUCTION_MARKER_FILES = [
  appPath('bedcode', 'desktop', 'rust/src/tunnel.rs'),
  appPath('bedcode', 'mobile', 'rust/src/tunnel.rs'),
  appPath('file-transfer', 'desktop', 'src/composables/deviceState.ts'),
  appPath('file-transfer', 'desktop', 'src/utils/pairingLink.ts'),
  appPath('file-transfer', 'mobile', 'src/composables/deviceState.ts'),
  appPath('file-transfer', 'mobile', 'src/utils/pairingLink.ts'),
  appPath('file-transfer', 'rust/core/src/dial.rs'),
  appPath('file-transfer', 'rust/core/src/domain.rs'),
  appPath('file-transfer', 'rust/core/src/sessions.rs'),
  appPath('file-transfer', 'rust/plugin/src/peer.rs'),
  projectPath('servers', 'net-config', 'desktop', 'rust/src/model.rs'),
  projectPath('servers', 'net-config', 'desktop', 'src/i18n/en.ts'),
  projectPath('servers', 'net-config', 'desktop', 'src/i18n/zh-CN.ts'),
  projectPath('servers', 'net-config', 'desktop', 'src/relay/relayImport.ts'),
]

/** 声明标记常量的文件（L2 取值一致） */
const MARKER_CONST_FILES = [
  appPath('bedcode', 'mobile', 'rust/src/tunnel.rs'),
  appPath('file-transfer', 'desktop', 'src/composables/deviceState.ts'),
  appPath('file-transfer', 'mobile', 'src/composables/deviceState.ts'),
  appPath('file-transfer', 'rust/core/src/dial.rs'),
]

/** 声明 relay 地址上限的文件（L2 取值一致） */
const MAX_ADDR_FILES = [
  appPath('bedcode', 'desktop', 'rust/src/tunnel.rs'),
  projectPath('servers', 'net-config', 'desktop', 'rust/src/model.rs'),
  projectPath('servers', 'net-config', 'desktop', 'src/relay/relayImport.ts'),
]

/** relay 端点形状校验的两处实现（L2 判据同形） */
const ENDPOINT_SHAPE_FILES = [
  appPath('bedcode', 'desktop', 'rust/src/tunnel.rs'),
  projectPath('servers', 'net-config', 'desktop', 'rust/src/model.rs'),
]

/** 应用仓相对路径（失败信息可比对，避免刷绝对路径） */
function repoRelative(file: string): string {
  return relative(appsRepoRoot(), file).split('\\').join('/')
}

/** 应用仓生产源码（剔除测试 / 构建产物）。缺仓时 readdirSync 直接抛，不静默跳过 */
function productionSources(): string[] {
  const out: string[] = []
  const skip = new Set(['node_modules', 'dist', 'target', '__tests__'])
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx|vue|rs)$/.test(entry.name)) out.push(full)
    }
  }
  for (const group of ['apps', 'servers']) walk(join(appsRepoRoot(), group))
  return out
}

function read(file: string): string {
  return readFileSync(file, 'utf-8')
}

describe('穿透传输字面漂移锁', () => {
  it('L1 应用仓字面副本清单与登记一致（新增 / 删除都必须同步）', () => {
    const hits = productionSources()
      .filter((file) => read(file).includes('p2p-circuit'))
      .map(repoRelative)
      .sort()
    const declared = PRODUCTION_MARKER_FILES.map(repoRelative).sort()
    expect(
      hits,
      '穿透标记副本清单漂移：新增副本先确认字面为 /p2p-circuit 再登记；删文件同步删清单',
    ).toEqual(declared)
  })

  it('L1b 每处字面都带前导斜杠（防 `p2p-circuit` / `/p2pcircuit` 变体）', () => {
    const offenders: string[] = []
    for (const file of PRODUCTION_MARKER_FILES) {
      for (const [index, line] of read(file).split('\n').entries()) {
        const bare = line.split('p2p-circuit').length - 1
        if (bare === 0) continue
        const withSlash = line.split('/p2p-circuit').length - 1
        if (bare !== withSlash) {
          offenders.push(`${repoRelative(file)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, '标记字面必须统一为 /p2p-circuit（含前导斜杠）').toEqual([])
  })

  it('L2 标记常量与地址上限跨仓同值', () => {
    const markers: string[] = []
    for (const file of MARKER_CONST_FILES) {
      const source = read(file)
      for (const match of source.matchAll(
        /(?:WAN_ADDR_MARKER|RELAY_MARKER)\s*(?::\s*&str)?\s*=\s*(['"])([^'"]+)\1/g,
      )) {
        markers.push(match[2])
      }
    }
    expect(
      markers.length,
      '未提取到标记常量：常量改名 / 挪文件后本锁必须同步（防空转）',
    ).toBe(MARKER_CONST_FILES.length)
    expect(new Set(markers), '标记常量必须逐字等于 /p2p-circuit').toEqual(
      new Set([CIRCUIT_MARKER]),
    )

    const caps: number[] = []
    for (const file of MAX_ADDR_FILES) {
      const match = read(file).match(
        /const\s+MAX_RELAY_ADDRS(?:\s*:\s*usize)?\s*=\s*(\d+)/,
      )
      expect(match, `${repoRelative(file)} 未找到 MAX_RELAY_ADDRS 声明（改名后本锁需同步）`)
        .not.toBeNull()
      caps.push(Number(match![1]))
    }
    expect(caps, 'relay 地址上限必须跨仓同值').toEqual(
      MAX_ADDR_FILES.map(() => MAX_RELAY_ADDRS),
    )
  })

  it('L2b relay 端点形状判据同形（6 段 + host 协议集合）', () => {
    for (const file of ENDPOINT_SHAPE_FILES) {
      const code = read(file).replace(/\s+/g, ' ')
      expect(code, `${repoRelative(file)} 的段数判据已漂移`).toContain(
        'parts.len() != 6',
      )
      expect(code, `${repoRelative(file)} 的 host 协议集合已漂移`).toContain(
        'matches!(host_proto, "ip4" | "ip6" | "dns" | "dns4" | "dns6")',
      )
    }
  })

  it('L3 能力仓仍用类型化 Protocol::P2pCircuit 表达标记', () => {
    const source = read(libPath('wasmnest-p2p-engine/src/relay.rs'))
    expect(source, '能力侧标记改回字符串会让应用侧字面失去真源').toContain(
      'Protocol::P2pCircuit',
    )
    expect(source, '文档里的协议字面应与应用侧一致').toContain(CIRCUIT_MARKER)
  })
})
