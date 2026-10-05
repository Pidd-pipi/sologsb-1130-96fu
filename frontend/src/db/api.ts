/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import { newFrameUid } from '../utils/identity';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

/** 读取一镜的全部帧，按帧号排序；顺手为缺失 uid 的历史帧补身份 */
export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  const missing = rows.filter((r) => typeof r.uid !== 'string' || !r.uid);
  if (missing.length) {
    for (const row of missing) {
      row.uid = newFrameUid();
      await db.frames.update(row.id as number, { uid: row.uid });
    }
  }
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain({ ...frame, uid: frame.uid || newFrameUid() }));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain({ ...f, uid: f.uid || newFrameUid() })));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

/**
 * 按稳定身份 uid 差量同步一镜的帧序（替代旧的整表删除重建）：
 * uid 相同即更新（保留实拍记录的 frameUid 关联），新 uid 插入，缺失 uid 删除。
 * 返回按帧号排序的落库结果。
 */
export async function syncShotFrames(shotId: number, frames: FrameEntry[]): Promise<FrameEntry[]> {
  const plain = frames.map((f) =>
    toPlain({ ...f, uid: f.uid || newFrameUid(), shotId, updatedAt: Date.now() }),
  );
  let result: FrameEntry[] = [];
  await db.transaction('rw', db.frames, async () => {
    const existing = await db.frames.where('shotId').equals(shotId).toArray();
    const byUid = new Map<string, FrameEntry>();
    for (const row of existing) {
      if (row.uid) byUid.set(row.uid, row);
    }
    const keepUids = new Set<string>();
    const toAdd: FrameEntry[] = [];
    for (const frame of plain) {
      keepUids.add(frame.uid);
      const old = byUid.get(frame.uid);
      if (old && typeof old.id === 'number') {
        const { id: _id, ...rest } = frame;
        await db.frames.update(old.id, rest);
      } else {
        toAdd.push(frame);
      }
    }
    if (toAdd.length) await db.frames.bulkAdd(toAdd);
    for (const row of existing) {
      if (row.uid && !keepUids.has(row.uid)) await db.frames.delete(row.id as number);
    }
    result = await db.frames.where('shotId').equals(shotId).toArray();
  });
  return result.sort((a, b) => a.frameNo - b.frameNo);
}

/** 兼容旧调用方：整段帧序落库（内部走 uid 差量同步） */
export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  await syncShotFrames(shotId, frames);
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

/** 有效实拍记录（复核弃用的软删除记录不在清单中展示），按日期倒序 */
export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows
    .filter((t) => t.active !== false)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

/** 含已弃用记录在内的全部记录，供对账使用 */
export async function listAllTakes(): Promise<TakeLog[]> {
  return db.takes.toArray();
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  return rows.filter((t) => t.active !== false);
}

export async function addTake(take: TakeLog): Promise<number> {
  const uid = take.uid || `take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { uid: _omit, ...rest } = take;
  return db.takes.add(toPlain({ ...rest, uid }));
}

export async function patchTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}
