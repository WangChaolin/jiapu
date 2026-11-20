import type { GenealogyDb } from './db.ts'
import type { ParentSubtype, SpouseSubtype } from '../shared/types'

interface Spec {
  key: string
  name: string
  gender: '男' | '女'
  gen: number
  birth?: string
  death?: string
  branch?: string
  bio?: string
  order?: number
}

const SPECS: Spec[] = [
  { key: 'guodong', name: '张国栋', gender: '男', gen: 1, birth: '1850-03-12', death: '1921-11-02', bio: '始祖，清咸丰年间迁居本地，耕读传家。', order: 1 },
  { key: 'shuzhen', name: '王淑贞', gender: '女', gen: 1, birth: '1852-01-08', death: '1930-05-16' },
  { key: 'zhengren', name: '张正仁', gender: '男', gen: 2, birth: '1874-07-21', death: '1946-02-11', branch: 'chang', bio: '长房开基祖，经营茶庄。', order: 1 },
  { key: 'xiulan', name: '李秀兰', gender: '女', gen: 2, birth: '1876-09-03', death: '1950-12-20' },
  { key: 'zhengyi', name: '张正义', gender: '男', gen: 2, birth: '1877-04-15', death: '1952-08-09', branch: 'er', bio: '二房开基祖，执教私塾。', order: 2 },
  { key: 'chune', name: '赵春娥', gender: '女', gen: 2, birth: '1880-02-28', death: '1955-03-17' },
  { key: 'tiande', name: '张天德', gender: '男', gen: 3, birth: '1899-06-10', death: '1972-01-25', branch: 'chang1', order: 1 },
  { key: 'yumei', name: '陈玉梅', gender: '女', gen: 3, birth: '1902-11-11', death: '1980-07-04' },
  { key: 'tianyou', name: '张天佑', gender: '男', gen: 3, birth: '1902-03-19', death: '1977-09-28', branch: 'chang2', order: 2 },
  { key: 'guixiang', name: '周桂香', gender: '女', gen: 3, birth: '1905-05-05', death: '1982-10-12' },
  { key: 'tianci', name: '张天赐', gender: '男', gen: 3, birth: '1905-12-01', death: '1983-04-22', branch: 'er1', order: 1 },
  { key: 'yuzhen', name: '孙玉珍', gender: '女', gen: 3, birth: '1908-08-18', death: '1985-06-30' },
  { key: 'tianlu', name: '张天禄', gender: '男', gen: 3, birth: '1908-02-14', death: '1960-11-11', branch: 'er2', order: 2 },
  { key: 'xinyuan', name: '张心远', gender: '男', gen: 4, birth: '1924-05-20', death: '2003-03-08', branch: 'chang1', bio: '抗战时从军，后回乡务农。', order: 1 },
  { key: 'huimin', name: '刘慧敏', gender: '女', gen: 4, birth: '1926-09-09', death: '2011-12-01' },
  { key: 'xinming', name: '张心明', gender: '男', gen: 4, birth: '1927-07-07', death: '2010-10-10', branch: 'chang1', bio: '兼祧天佑公，承两房香火。', order: 2 },
  { key: 'xiuying', name: '吴秀英', gender: '女', gen: 4, birth: '1930-01-22', death: '2015-05-05' },
  { key: 'xinlan', name: '张心兰', gender: '女', gen: 4, birth: '1930-11-30', death: '2018-08-19', branch: 'chang1', bio: '女，延续世系，招婿入赘。', order: 3 },
  { key: 'jianguo', name: '陈建国', gender: '男', gen: 4, birth: '1928-10-01', death: '2000-02-14' },
  { key: 'xincheng', name: '张心诚', gender: '男', gen: 4, birth: '1932-04-04', death: '2015-09-09', branch: 'er1', order: 1 },
  { key: 'shuhua', name: '郑淑华', gender: '女', gen: 4, birth: '1935-06-16' },
  { key: 'shunzhi', name: '张顺治', gender: '男', gen: 5, birth: '1951-07-12', branch: 'chang1', bio: '执教乡里三十载。', order: 1 },
  { key: 'yaqin', name: '王雅琴', gender: '女', gen: 5, birth: '1953-03-03' },
  { key: 'shunda', name: '张顺达', gender: '男', gen: 5, birth: '1954-08-08', branch: 'chang1', order: 2 },
  { key: 'shunping', name: '张顺平', gender: '男', gen: 5, birth: '1953-05-05', branch: 'chang2', order: 1 },
  { key: 'zhiqiang', name: '陈志强', gender: '男', gen: 5, birth: '1955-10-10', branch: 'chang1', bio: '随母系，外姓入谱。', order: 1 },
  { key: 'shunchang', name: '张顺昌', gender: '男', gen: 5, birth: '1958-12-12', branch: 'er1', order: 1 },
  { key: 'linjing', name: '林静', gender: '女', gen: 5, birth: '1960-04-04' },
  { key: 'guanqing', name: '张官清', gender: '男', gen: 6, birth: '1980-02-02', branch: 'chang1', order: 1 },
  { key: 'qinghe', name: '张清和', gender: '男', gen: 7, birth: '2005-06-06', branch: 'chang1', order: 1 },
  { key: 'qingyuan', name: '张清源', gender: '男', gen: 7, birth: '2008-09-09', branch: 'chang1', order: 2 },
]

const PARENTS: Record<string, [string, ParentSubtype, boolean?][]> = {
  zhengren: [['guodong', '生父'], ['shuzhen', '生母']],
  zhengyi: [['guodong', '生父'], ['shuzhen', '生母']],
  tiande: [['zhengren', '生父'], ['xiulan', '生母']],
  tianyou: [['zhengren', '生父'], ['xiulan', '生母']],
  tianci: [['zhengyi', '生父'], ['chune', '生母']],
  tianlu: [['zhengyi', '生父'], ['chune', '生母']],
  xinyuan: [['tiande', '生父'], ['yumei', '生母']],
  xinming: [['tiande', '生父'], ['yumei', '生母'], ['tianyou', '兼祧父', false]],
  xinlan: [['tiande', '生父'], ['yumei', '生母']],
  xincheng: [['tianci', '生父'], ['yuzhen', '生母']],
  shunzhi: [['xinyuan', '生父'], ['huimin', '生母']],
  shunda: [['xinyuan', '生父'], ['huimin', '生母']],
  shunping: [['xinming', '生父'], ['xiuying', '生母']],
  zhiqiang: [['xinlan', '生母'], ['jianguo', '生父']],
  shunchang: [['xincheng', '生父'], ['shuhua', '生母']],
  guanqing: [['shunzhi', '生父'], ['yaqin', '生母']],
  qinghe: [['guanqing', '生父']],
  qingyuan: [['guanqing', '生父']],
}

const SPOUSES: Record<string, [string, SpouseSubtype][]> = {
  guodong: [['shuzhen', '原配']],
  zhengren: [['xiulan', '原配']],
  zhengyi: [['chune', '原配']],
  tiande: [['yumei', '原配']],
  tianyou: [['guixiang', '原配']],
  tianci: [['yuzhen', '原配']],
  xinyuan: [['huimin', '原配']],
  xinming: [['xiuying', '原配']],
  xinlan: [['jianguo', '原配']],
  xincheng: [['shuhua', '原配']],
  shunzhi: [['yaqin', '原配']],
  shunchang: [['linjing', '原配']],
}

export function seedDemo(db: GenealogyDb): void {
  const chang = db.createBranch('长房', null, null, '正仁公开基')
  const chang1 = db.createBranch('长房长支', chang.id, null, '天德公支')
  const chang2 = db.createBranch('长房次支', chang.id, null, '天佑公支')
  const er = db.createBranch('二房', null, null, '正义公开基')
  const er1 = db.createBranch('二房长支', er.id, null, '天赐公支')
  const er2 = db.createBranch('二房次支', er.id, null, '天禄公支')
  const branchMap: Record<string, string> = { chang: chang.id, chang1: chang1.id, chang2: chang2.id, er: er.id, er1: er1.id, er2: er2.id }

  const ids: Record<string, string> = {}
  for (const s of SPECS) {
    const m = db.createMember({
      name: s.name, gender: s.gender, generation: s.gen,
      branchId: s.branch ? branchMap[s.branch] : null,
      birthDate: s.birth ?? '', deathDate: s.death ?? '', alive: !s.death,
      birthOrder: s.order ?? 1, biography: s.bio ?? '',
    })
    ids[s.key] = m.id
  }
  db.updateBranch(chang.id, '长房', null, ids.zhengren, '正仁公开基')
  db.updateBranch(chang1.id, '长房长支', chang.id, ids.tiande, '天德公支')
  db.updateBranch(chang2.id, '长房次支', chang.id, ids.tianyou, '天佑公支')
  db.updateBranch(er.id, '二房', null, ids.zhengyi, '正义公开基')
  db.updateBranch(er1.id, '二房长支', er.id, ids.tianci, '天赐公支')
  db.updateBranch(er2.id, '二房次支', er.id, ids.tianlu, '天禄公支')

  for (const s of SPECS) {
    const detail = db.getMember(ids[s.key])!
    const parents = (PARENTS[s.key] ?? []).map(([k, sub, primary]) => ({ otherId: ids[k], subtype: sub, isPrimary: primary !== false }))
    const spouses = (SPOUSES[s.key] ?? []).map(([k, sub]) => ({ otherId: ids[k], subtype: sub }))
    if (parents.length || spouses.length) {
      db.updateMember(ids[s.key], { ...detail, parents, spouses })
    }
  }
  db.setPoem(null, '国正天心顺，官清民自安')
  db.setPoem(er.id, '国正天应允，家和万事兴')
}