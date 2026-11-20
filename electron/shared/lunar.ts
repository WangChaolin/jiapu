import { Lunar, Solar } from 'lunar-typescript'
import type { LunarInfo } from './types'

const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/

export function parseDate(s: string): [number, number, number] | null {
  const m = DATE_RE.exec(s.trim())
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

function infoFromLunar(l: Lunar): LunarInfo {
  return {
    solar: l.getSolar().toYmd(),
    lunar: `${l.getYearInChinese()}年${l.getMonthInChinese()}月${l.getDayInChinese()}`,
    yearGanZhi: l.getYearInGanZhi(),
    animal: l.getYearShengXiao(),
  }
}

export function solarToLunar(solar: string): LunarInfo | null {
  const p = parseDate(solar)
  if (!p) return null
  try { return infoFromLunar(Solar.fromYmd(p[0], p[1], p[2]).getLunar()) } catch { return null }
}

export interface LunarParts { year: number; month: number; day: number; leap: boolean }

export function solarToLunarParts(solar: string): LunarParts | null {
  const p = parseDate(solar)
  if (!p) return null
  try {
    const l = Solar.fromYmd(p[0], p[1], p[2]).getLunar()
    return { year: l.getYear(), month: Math.abs(l.getMonth()), day: l.getDay(), leap: l.getMonth() < 0 }
  } catch { return null }
}

export function lunarPartsToSolar(year: number, month: number, day: number, leap: boolean): string | null {
  try { return Lunar.fromYmd(year, leap ? -month : month, day).getSolar().toYmd() } catch { return null }
}

export function lunarToSolar(lunar: string, leapMonth = false): LunarInfo | null {
  const p = parseDate(lunar)
  if (!p) return null
  try { return infoFromLunar(Lunar.fromYmd(p[0], leapMonth ? -p[1] : p[1], p[2])) } catch { return null }
}

export function describeDate(solar: string, preferLunar: boolean): { primary: string; secondary: string; valid: boolean } {
  if (!solar) return { primary: '—', secondary: '', valid: true }
  const info = solarToLunar(solar)
  if (!info) return { primary: solar, secondary: '日期无效', valid: false }
  const gz = `${info.yearGanZhi}年（${info.animal}）`
  if (preferLunar) return { primary: `农历 ${info.lunar}`, secondary: `公历 ${info.solar} · ${gz}`, valid: true }
  return { primary: `公历 ${info.solar}`, secondary: `农历 ${info.lunar} · ${gz}`, valid: true }
}

export function yearOf(date: string): number | null {
  const p = parseDate(date)
  return p ? p[0] : null
}

export function todaySolar(): string {
  return Solar.fromDate(new Date()).toYmd()
}

export function isValidSolar(date: string): boolean {
  if (!date) return true
  return solarToLunar(date) !== null
}