#!/usr/bin/env node
/**
 * SDK 发布包内容锁（`scripts/package-sdks.mjs` 的断言实现）
 *
 * 为什么不用 `tar -tzf`：GNU tar / bsdtar 在 Windows、macOS、Linux 上的输出与退出码
 * 差异太大（尤其是 `--wildcards`、pax 头、路径分隔符），而发布脚本要在三平台 CI 与
 * 本地都跑。这里用 Node 原生 `zlib` 解 gzip + 极简 tar 头解析，只取条目名，跨平台一致。
 *
 * 判据：`assertTarballContains` 缺失任一条目即**抛错**（调用方 fail-fast），不是打印警告。
 *
 * 支持：ustar（`prefix` 字段）/ GNU tar 头 / 跳过 pax 扩展头（只按头部名比较，足够锁
 * 住 npm tarball 的 `package/**` 与 cargo `.crate` 的 `crate-name-version/**` 路径）。
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const BLOCK = 512

/** 读 tar 头里的字符串字段（NUL 截断） */
function readString(block, offset, length) {
  const raw = block.subarray(offset, offset + length)
  const nul = raw.indexOf(0)
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString('utf-8')
}

/** 读 tar 头里的八进制数值字段（允许前导空格 / 结尾 NUL / 空格） */
function readOctal(block, offset, length) {
  const text = readString(block, offset, length).trim()
  return text ? parseInt(text, 8) : 0
}

/**
 * 列出 tar 归档内的条目名（含目录条目）。
 *
 * @param {Buffer} buf 未压缩的 tar 字节
 * @returns {string[]} 条目名（保留 tar 内的原始相对路径）
 */
export function listTarEntries(buf) {
  const names = []
  let offset = 0
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK)
    // 全零块 = 归档结束（标准 tar 以两个零块收尾）
    if (header.every((byte) => byte === 0)) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156])

    // pax 扩展头（x/g）与 GNU 长名（L/K）的块本身不是文件；其内容随后续头部生效。
    // 这里只关心条目名，直接按 size 跳过即可（我们的目标路径都很短，不会走 pax path）。
    if (type !== 'x' && type !== 'g' && type !== 'L' && type !== 'K') {
      const full = prefix ? `${prefix}/${name}` : name
      if (full) names.push(full)
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
  return names
}

/** 读 gzip 压缩的 tarball（npm `.tgz` / cargo `.crate`）并列出条目 */
export function listTarballEntries(file) {
  return listTarEntries(gunzipSync(readFileSync(file)))
}

/** 校验条目集合包含全部必需项；缺失即抛错并点名（fail-fast） */
export function assertEntriesPresent(entries, required, label) {
  const present = new Set(entries)
  const missing = required.filter((entry) => !present.has(entry))
  if (missing.length > 0) {
    throw new Error(
      `${label} 内容不完整：缺少 ${missing.join(', ')}（实际 ${entries.length} 个条目）。` +
        '发布包漏文件 = 应用侧安装后构建断链，禁止带病发布。',
    )
  }
}

/** 校验 tarball 包含全部必需条目；缺失即抛错 */
export function assertTarballContains(file, required, label) {
  assertEntriesPresent(listTarballEntries(file), required, label)
}

/**
 * 校验目录前缀下有内容（`cargo package --list` 不输出目录条目本身，只列文件）。
 *
 * @param {string[]} entries `cargo package --list` 的路径行
 * @param {string[]} prefixes 目录前缀（如 `wit/`、`wit-src/`）
 * @param {string} label 报错时的对象名
 */
export function assertPrefixesPresent(entries, prefixes, label) {
  const missing = prefixes.filter(
    (prefix) => !entries.some((entry) => entry.startsWith(prefix)),
  )
  if (missing.length > 0) {
    throw new Error(
      `${label} 内容不完整：缺少 ${missing.join(', ')} 下的文件（实际 ${entries.length} 个条目）。` +
        'Rust SDK 依赖随包的 WIT 契约，漏打即应用侧构建失败。',
    )
  }
}
