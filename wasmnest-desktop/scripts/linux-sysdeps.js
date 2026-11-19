/**
 * Linux 原生依赖构建环境自举（非 root sysdeps，桌面端 dev / build 共用）
 *
 * 背景：wasmnest-audio-engine 的 backend-cpal 依赖 alsa-sys，构建脚本用 pkg-config
 * 找 alsa.pc；wasmnest-stt-engine 的 backend-whisper 依赖 bindgen（libclang）与 cmake。
 * 本机 sudo 需要密码、系统未装 libasound2-dev / libclang-16-dev，这些依赖由
 * apt download + dpkg -x 解包到用户目录，靠环境变量注入。
 *
 * 为什么不只依赖 shell 配置：`~/.bashrc` / `~/.profile` 只在交互式 / 登录 shell 生效，
 * IDE 内置终端、桌面启动器、CI 式非交互调用都拿不到；且历史版本把目录放在 /tmp
 *（tmpfs，重启即清空）。因此构建入口脚本必须自己探测并注入，任何终端跑
 * `pnpm tauri:dev` / `pnpm tauri:build` 都能成功。
 *
 * 注入判据先行：`pkg-config --exists alsa` 成功说明系统依赖已就绪（例如 apt 安装过），
 * 此时完全不改环境，保持零行为变化。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 解包目录内的 Debian 多架构库路径（amd64） */
const DEB_LIB = 'usr/lib/x86_64-linux-gnu'

/** ALSA 开发文件相对根目录的路径（判据：alsa.pc 存在即认为该根目录可用） */
const ALSA_PC_REL = join('alsa-root', DEB_LIB, 'pkgconfig', 'alsa.pc')

/**
 * 候选 sysdeps 根目录（按优先级）。
 *
 * WASMNEST_SYSDEPS 供自定义；持久位置是主路径；/tmp/wasmnest-sysdeps 是旧布局兼容
 *（历史会话遗留，重启后不存在，仅当用户升级前目录仍在时命中）。
 */
function candidateRoots() {
  const home = homedir()
  return [
    process.env.WASMNEST_SYSDEPS,
    join(home, '.local', 'share', 'wasmnest-sysdeps'),
    join(home, '.cache', 'wasmnest-sysdeps'),
    '/tmp/wasmnest-sysdeps',
  ].filter(Boolean)
}

/** pkg-config 是否能解析 alsa（返回 true 时说明无需注入） */
function hasAlsaPkgConfig() {
  const result = spawnSync('pkg-config', ['--exists', 'alsa'], { stdio: 'ignore' })
  return result.status === 0
}

/**
 * 修正解包 alsa.pc 的硬编码 prefix。
 *
 * `apt download` + `dpkg -x` 解包出的 alsa.pc 保留解包时的绝对路径；目录迁移后
 * pkg-config 会给出指向旧路径的 -I/-L（历史版本在 /tmp，重启即失效）。只在 prefix
 * 目录确实不存在时重写为当前根目录，避免误改有效配置或系统文件。
 */
function repairPkgConfigPrefix(root) {
  const pcPath = join(root, ALSA_PC_REL)
  let text
  try {
    text = readFileSync(pcPath, 'utf8')
  } catch {
    return
  }
  const current = text.match(/^prefix=(.*)$/m)?.[1]?.trim()
  if (!current || existsSync(current)) return

  const expected = join(root, 'alsa-root', 'usr')
  const repaired = text.replace(/^prefix=.*$/m, `prefix=${expected}`)
  try {
    writeFileSync(pcPath, repaired)
    console.log(`[linux-sysdeps] 已修正 alsa.pc 过期 prefix：${current} -> ${expected}`)
  } catch (err) {
    console.error(`[linux-sysdeps] ⚠ 无法修正 alsa.pc prefix（${err.message}）`)
  }
}

/**
 * 幂等地把值前置到环境变量的冒号分隔列表中（去重，避免重复 source / 多次调用叠加）。
 */
function prependPath(name, value) {
  const current = process.env[name] ?? ''
  const items = current ? current.split(':') : []
  if (items.includes(value)) return
  process.env[name] = current ? `${value}:${current}` : value
}

/**
 * 幂等地追加 RUSTFLAGS 的 -L native 项（rust-lld 不读 LIBRARY_PATH，
 * 链接 alsa 时需要显式 native 搜索路径）。
 */
function prependRustflags(value) {
  const flag = `-L native=${value}`
  const current = process.env.RUSTFLAGS ?? ''
  if (current.includes(flag)) return
  process.env.RUSTFLAGS = current ? `${flag} ${current}` : flag
}

/** fail-visible：找不到依赖时显式点名缺失项 + 给出两条路，禁止静默降级 */
function failMissing(rootHint) {
  const lines = [
    '[linux-sysdeps] ✗ 缺少 ALSA 开发文件 alsa.pc，桌面端无法构建',
    '  缺失项：libasound2-dev（alsa-sys / backend-cpal 构建必需）',
    rootHint
      ? `  已检测到 sysdeps 根目录但内容不完整：${rootHint}`
      : '  未找到任何可用的 sysdeps 解包目录',
    '  修复方式（二选一）：',
    '    1) 有 sudo：sudo apt install libasound2-dev libclang-16-dev cmake',
    '    2) 无 sudo：apt download 上述包后用 dpkg -x 解包到',
    `       ${join(homedir(), '.local', 'share', 'wasmnest-sysdeps')}/{alsa-root,clang-root,cmake-root}`,
    '       或用 WASMNEST_SYSDEPS=<目录> 指向已有解包根目录',
  ]
  console.error(lines.join('\n'))
  process.exit(1)
}

/**
 * 注入解包依赖的环境变量；非 Linux 或系统依赖已就绪时直接返回。
 *
 * 注入项与 WasmNest 构建链的真实需求一一对应：
 *   PKG_CONFIG_PATH / LIBRARY_PATH：alsa-sys 找头文件与链接库
 *   RUSTFLAGS：rust-lld 的 -lasound 搜索路径
 *   LIBCLANG_PATH / LD_LIBRARY_PATH：bindgen dlopen libclang（其依赖 libLLVM 仍需
 *     动态加载器搜索路径）
 *   BINDGEN_EXTRA_CLANG_ARGS：clang 内置头文件（stdint.h 等）
 *   PATH：cmake（whisper.cpp 构建）
 */
export function ensureLinuxSysdeps() {
  if (process.platform !== 'linux') return
  if (hasAlsaPkgConfig()) return

  const roots = candidateRoots()
  const root = roots.find((dir) => existsSync(join(dir, ALSA_PC_REL)))
  if (!root) failMissing(roots.find((dir) => existsSync(dir)))

  // pc 文件可能带着解包时的旧绝对路径（迁移 / 重启后失效），注入前先自愈
  repairPkgConfigPrefix(root)

  const alsaLib = join(root, 'alsa-root', DEB_LIB)
  prependPath('PKG_CONFIG_PATH', join(alsaLib, 'pkgconfig'))
  prependPath('LIBRARY_PATH', alsaLib)
  prependRustflags(alsaLib)

  const clangRoot = join(root, 'clang-root')
  if (existsSync(join(clangRoot, DEB_LIB))) {
    const clangLib = join(clangRoot, DEB_LIB)
    process.env.LIBCLANG_PATH = clangLib
    prependPath('LD_LIBRARY_PATH', join(root, 'cmake-root', DEB_LIB))
    prependPath('LD_LIBRARY_PATH', clangLib)

    const clangInc = join(clangRoot, 'usr/lib/llvm-16/lib/clang/16/include')
    if (existsSync(clangInc)) {
      const extra = process.env.BINDGEN_EXTRA_CLANG_ARGS ?? ''
      if (!extra.includes(`-I${clangInc}`)) {
        process.env.BINDGEN_EXTRA_CLANG_ARGS = extra
          ? `-I${clangInc} ${extra}`
          : `-I${clangInc}`
      }
    }
  }

  const cmakeBin = join(root, 'cmake-root', 'usr', 'bin')
  if (existsSync(cmakeBin)) prependPath('PATH', cmakeBin)

  console.log(`[linux-sysdeps] 已注入非 root 解包依赖环境：${root}`)
  if (!hasAlsaPkgConfig()) {
    console.error('[linux-sysdeps] ✗ 注入后 pkg-config 仍找不到 alsa，请检查解包内容是否完整')
    process.exit(1)
  }
}