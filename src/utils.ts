import type { Branch, ZibeiPoem } from '@shared/types'

export function branchName(branches: Branch[], id: string | null): string {
  if (!id) return '—'
  return branches.find((b) => b.id === id)?.name ?? '—'
}

export function makeZibeiResolver(poems: ZibeiPoem[], branches: Branch[]): (gen: number, branchId: string | null) => string | null {
  const byBranch = new Map<string | null, Map<number, string>>()
  for (const p of poems) {
    const m = new Map<number, string>()
    for (const e of p.entries) m.set(e.generation, e.char)
    byBranch.set(p.branchId, m)
  }
  const parentOf = new Map(branches.map((b) => [b.id, b.parentId]))
  return (gen, branchId) => {
    let cur: string | null = branchId
    while (cur) {
      const c = byBranch.get(cur)?.get(gen)
      if (c) return c
      cur = parentOf.get(cur) ?? null
    }
    return byBranch.get(null)?.get(gen) ?? null
  }
}

export function zibeiMatch(name: string, surname: string, expected: string | null): 'match' | 'mismatch' | 'exempt' | 'none' {
  if (!expected) return 'none'
  if (surname && name && !name.startsWith(surname)) return 'exempt'
  const given = surname && name.startsWith(surname) ? name.slice(surname.length) : name
  const ch = given.charAt(0)
  if (!ch) return 'none'
  return ch === expected ? 'match' : 'mismatch'
}

export function buildBranchTree(branches: Branch[]): { branch: Branch; children: unknown[] }[] {
  const byParent = new Map<string | null, Branch[]>()
  for (const b of branches) {
    if (!byParent.has(b.parentId)) byParent.set(b.parentId, [])
    byParent.get(b.parentId)!.push(b)
  }
  const build = (parentId: string | null): { branch: Branch; children: unknown[] }[] =>
    (byParent.get(parentId) ?? []).map((branch) => ({ branch, children: build(branch.id) }))
  return build(null)
}