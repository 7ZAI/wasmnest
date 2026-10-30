/**
 * 首页快捷卡片选择
 * -----------------------------------------------------------------------------
 * 应用贡献的卡片可能远多于首页轨道能承载的量（每张一拍屏），宿主按注册顺序
 * 取前 N 张并自动轮播；超出部分不展示，也不做「无限滚动」——轨道不是应用列表，
 * 用户找完整应用入口走下方宫格 / 应用管理页。
 *
 * 顺序口径：应用注册顺序（壳清单顺序）→ 应用内槽位 order（registry 已排序）。
 * 不按最近使用重排：卡片是应用自持内容的读数，位置漂移会让用户每次都要重新找。
 */
import type { Component } from 'vue'
import type { ShellApp } from './types'

/** 首页最多展示的快捷卡片数（一拍屏一张，5 张即一轮完整轮播） */
export const SHELL_SLOT_MAX_CARDS = 5

/** 首页轨道上的一张卡片视图 */
export interface ShellSlotCard {
  /** 稳定 key：appId + 槽位 id（同一应用可贡献多张） */
  key: string
  component: Component
  app: ShellApp
}

/** 按注册顺序摊平并截断到展示上限 */
export function selectSlotCards(
  apps: readonly ShellApp[],
  max: number = SHELL_SLOT_MAX_CARDS,
): ShellSlotCard[] {
  if (max <= 0) return []
  const cards: ShellSlotCard[] = []
  for (const app of apps) {
    for (const slot of app.contributions.slots ?? []) {
      if (cards.length >= max) return cards
      cards.push({ key: `${app.id}:${slot.id}`, component: slot.component, app })
    }
  }
  return cards
}