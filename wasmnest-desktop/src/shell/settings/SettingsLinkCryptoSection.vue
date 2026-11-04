<template>
  <!-- ==================== LINK CRYPTO（只读审计，security 面） ====================
       策略属于应用（2026-11-04 裁决）：每个应用在自己的设置页决定 off / preferred /
       required，覆盖该应用全部 HTTP / WS 端点。宿主不设整机下限、没有开关，只执行
       应用的决定并在这里展示当前执行事实。 -->
  <section>
    <h3 class="wb-section-title">{{ t('settings.linkCrypto.title') }}</h3>
    <div class="shell-panel divide-y divide-[var(--border)]">
      <!-- 归属说明：唯一写入口在应用设置页，宿主设置页没有写控件 -->
      <p
        data-testid="link-crypto-app-owned-hint"
        class="px-5 py-3 text-xs leading-relaxed text-[var(--text-tertiary)]"
      >
        {{ t('settings.linkCrypto.appOwnedHint') }}
      </p>
      <p
        v-if="capable && !wsSession"
        data-testid="link-crypto-ws-gap"
        class="px-5 py-3 text-xs leading-relaxed text-[var(--text-tertiary)]"
      >
        {{ t('settings.linkCrypto.wsNotEncrypted') }}
      </p>

      <!-- 本机指纹：供双端人工核对（移动端 pin 展示比对） -->
      <div class="px-5 py-3.5 flex items-center justify-between gap-4">
        <div class="min-w-0">
          <span class="text-[calc(13px*var(--ui-scale))] text-[var(--text-primary)]">{{
            t('settings.linkCrypto.fingerprint')
          }}</span>
          <p class="text-xs text-[var(--text-tertiary)] mt-0.5">
            {{ t('settings.linkCrypto.fingerprintDesc') }}
          </p>
        </div>
        <span
          data-testid="link-crypto-fingerprint"
          class="wb-mono text-[calc(12px*var(--ui-scale))] text-[var(--text-secondary)] flex-shrink-0 truncate"
        >
          {{ fingerprint ?? '—' }}
        </span>
      </div>

      <!-- 应用策略（只读审计）：明文暴露面必须可见，但不提供任何写入口 -->
      <div class="px-5 py-3.5">
        <span class="text-[calc(13px*var(--ui-scale))] text-[var(--text-primary)]">{{
          t('settings.linkCrypto.apps')
        }}</span>

        <p
          v-if="loadError"
          data-testid="link-crypto-load-error"
          class="text-xs text-[var(--color-danger-ink)] mt-1"
        >
          {{ t('settings.linkCrypto.loadFailed') }}
        </p>
        <p
          v-else-if="!capable"
          data-testid="link-crypto-unsupported"
          class="text-xs text-[var(--color-danger-ink)] mt-1"
        >
          {{ t('settings.linkCrypto.capabilityMissing') }}
        </p>
        <p
          v-else-if="!records.length"
          data-testid="link-crypto-empty"
          class="text-xs text-[var(--text-tertiary)] mt-1"
        >
          {{ t('settings.linkCrypto.appsEmpty') }}
        </p>
        <ul v-else data-testid="link-crypto-apps" class="mt-2 space-y-1.5">
          <li
            v-for="record in records"
            :key="record.owner"
            data-testid="link-crypto-app-row"
            class="flex items-center justify-between gap-3"
          >
            <div class="min-w-0">
              <span
                class="wb-mono text-[calc(11px*var(--ui-scale))] text-[var(--text-secondary)] truncate block"
                :title="record.owner"
              >
                {{ record.owner }}
              </span>
              <span
                class="block mt-0.5 text-[calc(10px*var(--ui-scale))] text-[var(--text-tertiary)]"
              >
                {{ t('settings.linkCrypto.endpointCount', { count: record.endpointCount }) }}
              </span>
            </div>
            <span
              class="flex-shrink-0 px-1.5 py-0.5 rounded text-[calc(11px*var(--ui-scale))] font-medium"
              :class="policyClass(record.policy)"
            >
              {{ policyLabel(record.policy) }}
            </span>
          </li>
        </ul>

        <!-- 未设置策略 = 明文（应用显式开启才会加密），不是「跟随某个宿主下限」 -->
        <p
          v-if="capable && records.length"
          data-testid="link-crypto-default-hint"
          class="text-xs text-[var(--text-tertiary)] mt-2"
        >
          {{ t('settings.linkCrypto.defaultHint') }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * SettingsLinkCryptoSection — 设置页「链路加密」分组（宿主只读审计）
 *
 * 归属（2026-11-04 用户裁决，修正 2026-11-02 的宿主下限方案）：
 * - 策略属于应用：每个 plugin id 一个值（off / preferred / required），覆盖该应用
 *   全部 HTTP / WS 端点；应用在自己的设置页决定，经 app 通道令牌写入；
 * - 宿主不设下限、不提供开关：本分组只展示当前执行事实与本机指纹，**没有写控件**；
 * - 未设置策略 = 不要求加密（默认 off；客户端自愿加密时 HTTP 仍会加密）。
 *
 * 数据源（全只读）：
 * - `get_link_crypto_capabilities`：能力 + 身份指纹；
 * - `get_link_crypto_app_policies`：应用策略 + 端点计数（明文暴露面可见）。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { invoke } from '@/utils/invoke'
import { logger } from '@/utils/frontendLogger'

/** 与能力仓 `link_crypto::EncryptionPolicy` 的 wire 字面量一致（小写） */
type EncryptionPolicy = 'off' | 'preferred' | 'required'

/** 镜像 `link_crypto::LinkCryptoCapabilities`（serde camelCase） */
interface LinkCryptoCapabilities {
  appScopedPolicy: boolean
  policies: string[]
  identityFingerprint: string | null
  keyModels: string[]
  wsSession: boolean
}

/** 镜像宿主 `AppLinkCryptoAudit`（serde camelCase） */
interface AppLinkCryptoAudit {
  owner: string
  policy: EncryptionPolicy
  endpointCount: number
}

const { t } = useI18n()

const capable = ref(true)
const fingerprint = ref<string | null>(null)
const wsSession = ref(true)
const records = ref<AppLinkCryptoAudit[]>([])
const loadError = ref(false)

function policyLabel(policy: EncryptionPolicy): string {
  switch (policy) {
    case 'required':
      return t('settings.linkCrypto.policyRequired')
    case 'preferred':
      return t('settings.linkCrypto.policyPreferred')
    default:
      return t('settings.linkCrypto.policyOff')
  }
}

function policyClass(policy: EncryptionPolicy): string {
  switch (policy) {
    case 'required':
      return 'tone-success'
    case 'preferred':
      return 'tone-info'
    default:
      return 'tone-warning'
  }
}

async function load(): Promise<void> {
  try {
    const [capabilities, apps] = await Promise.all([
      invoke<LinkCryptoCapabilities>('get_link_crypto_capabilities'),
      invoke<AppLinkCryptoAudit[]>('get_link_crypto_app_policies'),
    ])
    // 旧宿主 / 夹具缺字段：显性提示能力缺失，不假装有策略面
    capable.value = capabilities?.appScopedPolicy === true
    fingerprint.value = capabilities?.identityFingerprint ?? null
    wsSession.value = capabilities?.wsSession === true
    records.value = Array.isArray(apps) ? apps : []
  } catch (error) {
    // 读失败不阻断设置页其余分组：显示显性错误行，不展示过期数据
    loadError.value = true
    logger.error('[SettingsLinkCrypto] load failed:', error)
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
/* 徽标底色走全局 tone-* 工具类（与宿主其它审计行同源） */
</style>
