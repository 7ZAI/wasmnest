#!/usr/bin/env node
/**
 * `sdk-package-contents` 的解析与断言锁（纯 Node，不依赖系统 tar）
 *
 * 背景：`scripts/package-sdks.mjs` 的发布内容断言如果只能靠 `tar -tzf` 验证，CI 与
 * 本地三平台的行为差异会把「漏文件」藏进噪声里。这里用**独立构造**的 tar 字节
 * （按 POSIX ustar 规范手写头部，不复用实现里的写法）验证解析器与 fail-fast 行为：
 *  1. 普通条目与 ustar `prefix` 条目都能解析成完整路径；
 *  2. gzip 包裹的 tarball 走同一条解析；
 *  3. 必需条目齐全时通过，缺一个就抛错并点名（禁止只打印警告）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  assertEntriesPresent,
  assertPrefixesPresent,
  assertTarballContains,
  listTarEntries,
  listTarballEntries,
} from './sdk-package-contents.mjs'

const BLOCK = 512

/** 按 POSIX ustar 写一个 512 字节头（校验和按规范以空格填空后计算） */
function tarHeader({ name, prefix = '', size = 0 }) {
  const header = Buffer.alloc(BLOCK)
  const writeStr = (value, offset, length) => {
    Buffer.from(value, 'utf-8').copy(header, offset, 0, length)
  }
  const writeOctal = (value, offset, length) => {
    writeStr(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
  }
  writeStr(name, 0, 100)
  writeOctal(0o644, 100, 8)
  writeOctal(0, 108, 8)
  writeOctal(0, 116, 8)
  writeOctal(size, 124, 12)
  writeOctal(0, 136, 12)
  header.fill(0x20, 148, 156) // 校验和字段先填空格
  writeStr('0', 156, 1)
  writeStr('ustar\0', 257, 6)
  writeStr('00', 263, 2)
  writeStr(prefix, 345, 155)

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeStr(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}

/** 构造 tar：条目内容为固定短串，按块补齐，两个零块收尾 */
function buildTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(`${entry.name} content`)
    blocks.push(tarHeader({ ...entry, size: data.length }), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(blocks)
}

test('listTarEntries 解析普通条目与 ustar prefix 条目', () => {
  const tar = buildTar([
    { name: 'package/dist/index.js' },
    { name: 'plugin-watch.js', prefix: 'package/bin' },
  ])

  assert.deepEqual(listTarEntries(tar), [
    'package/dist/index.js',
    'package/bin/plugin-watch.js',
  ])
})

test('listTarballEntries 对 gzip tarball 走同一解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-contents-'))
  try {
    const file = join(dir, 'fixture.tgz')
    writeFileSync(
      file,
      gzipSync(
        buildTar([
          { name: 'package/bin/plugin-watch.js' },
          { name: 'package/tools/componentize/Cargo.toml' },
        ]),
      ),
    )

    assert.deepEqual(listTarballEntries(file), [
      'package/bin/plugin-watch.js',
      'package/tools/componentize/Cargo.toml',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assertTarballContains：齐全通过，缺条目抛错并点名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-contents-'))
  try {
    const file = join(dir, 'fixture.tgz')
    writeFileSync(file, gzipSync(buildTar([{ name: 'package/bin/plugin-watch.js' }])))

    assert.doesNotThrow(() =>
      assertTarballContains(file, ['package/bin/plugin-watch.js'], 'fixture'),
    )
    assert.throws(
      () => assertTarballContains(file, ['package/bin/wasm-hash.js'], 'fixture'),
      /fixture 内容不完整：缺少 package\/bin\/wasm-hash\.js/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assertEntriesPresent：空条目表不许当成通过', () => {
  assert.throws(() => assertEntriesPresent([], ['wit/'], 'crate'), /缺少 wit\//)
  assert.doesNotThrow(() => assertEntriesPresent(['wit/core.wit'], [], 'crate'))
})

test('assertPrefixesPresent：按目录前缀判定 WIT 是否随包（--list 不输出目录条目）', () => {
  const entries = ['Cargo.toml', 'wit/core.wit', 'wit-src/core.wit', 'src/lib.rs']
  assert.doesNotThrow(() => assertPrefixesPresent(entries, ['wit/', 'wit-src/'], 'crate'))
  const noWitSrc = entries.filter((entry) => !entry.startsWith('wit-src/'))
  assert.throws(
    () => assertPrefixesPresent(noWitSrc, ['wit/', 'wit-src/'], 'crate'),
    /crate 内容不完整：缺少 wit-src\//,
  )
})
