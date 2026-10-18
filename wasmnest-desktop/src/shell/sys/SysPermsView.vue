<template>
  <!--
    系统页「权限与授权」：直接复用宿主唯一的授权管理视图（AuthorizationView）——
    安全闸门的呈现必须单一口径（spec §9.2 四分区互斥完备），数据通道
    （utils/appCommands authOverview 等）也只有这一份实现，壳不再另写查询。
    以 embedded 形态嵌入：页头 / tabs 由 ShellCardScreen 提供，本页不再自绘页头
    （否则系统页里会出现第二条状态栏，且其「返回」会把用户甩进应用设置）。
  -->
  <AuthorizationView embedded />
</template>

<script setup lang="ts">
/**
 * SysPermsView — 系统页「权限与授权」（壳内承载）
 *
 * 2026-10-17 壳恢复后：包装宿主 AuthorizationView（embedded），分区口径 / 排序 /
 * 撤销语义单一真源（utils/authPolicy.ts + utils/appCommands），壳只提供系统页卡
 * 容器与 tabs 互切（ShellCardScreen）+ 常驻标题栏（ShellHost）。
 */
import AuthorizationView from '@/views/AuthorizationView.vue'
</script>
