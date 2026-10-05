/**
 * 拍摄批次算法：
 * 把一镜的帧序按 180 秒容量（逐帧「张数 × 曝光时间」累加）切成可追踪的拍摄批次，
 * 硬约束：同一道具区间不能被批次边界拆开——
 *   - 先按「该帧当前覆盖到的道具区间签名」把帧序分段；
 *   - 同一段尽量整体装进当前批次，装不下就整体顺延到下一批；
 *   - 仅当一个道具区间本身超过 180 秒（不拆就拍不了）才强制拆段，并标记道具区间溢出。
 * 批次 id 由成员帧 uid 的哈希得出：帧序一改，未拍批次因成员变化立即得到新 id（旧批次失效），
 * 而已拍批次仍能凭相同成员 / 实拍记录追踪原帧。
 */
import { hashString } from './identity';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { ReviewStatus, TakeLog } from '../types/take';

/** 单批次容量（秒）：180 秒 */
export const BATCH_CAPACITY_SEC = 180;

export interface BatchFrame {
  uid: string;
  frameNo: number;
  shotCount: number;
  exposureSec: number;
}

export interface BatchView {
  /** 稳定批次 id：成员帧 uid 列表的哈希 */
  id: string;
  /** 展示序号（按帧序从 1 开始） */
  index: number;
  /** 成员帧（按帧序） */
  frames: BatchFrame[];
  /** 成员 uid 列表，便于快速匹配实拍记录 */
  frameUids: string[];
  /** 占用容量（秒）= Σ 张数 × 曝光时间 */
  usedSec: number;
  /** 容量上限（秒） */
  capacitySec: number;
  /** 占用百分比 0-100+ */
  capacityPercent: number;
  /** 计划实拍张数（Σ shotCount） */
  plannedShots: number;
  /** 覆盖的道具区间标签（去重保序） */
  propLabels: string[];
  /** 道具区间被迫跨批拆开 */
  propOverflow: boolean;
  /** 单帧 / 单段本身超过 180 秒容量 */
  capacityOverflow: boolean;
}

/** 单帧占用机时（秒）：拍 shotCount 张，每张曝光 exposureSec 秒 */
export function frameLoadSec(frame: { shotCount: number; exposureSec: number }): number {
  const count = Number.isFinite(frame.shotCount) && frame.shotCount > 0 ? frame.shotCount : 1;
  const exposure = Number.isFinite(frame.exposureSec) && frame.exposureSec > 0 ? frame.exposureSec : 0;
  return Math.round(count * exposure * 1000) / 1000;
}

/** 道具区间在签名 / 标签中的统一写法 */
function propToken(p: Pick<PropState, 'name' | 'fromFrame' | 'toFrame'>): string {
  return `${p.name}[${p.fromFrame}-${p.toFrame}]`;
}

/**
 * 某帧号当前覆盖到的道具区间签名：
 * 覆盖到的道具区间（名称[起-止]）按名称排序后用 | 拼接；无道具时为空串。
 * 签名变化即代表帧离开了登记批次时的道具区间。
 */
export function propsKeyAtFrame(frameNo: number, props: PropState[]): string {
  return props
    .filter((p) => frameNo >= p.fromFrame && frameNo <= p.toFrame)
    .map(propToken)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .join('|');
}

function propsKeyLabels(key: string): string[] {
  if (!key) return ['无道具区间'];
  return key.split('|').filter(Boolean);
}

interface Run {
  sig: string;
  items: BatchFrame[];
}

/** 同一段道具区间按容量切片；切出多片即意味着该区间被迫拆开 */
function splitRunByCapacity(items: BatchFrame[]): { pieces: BatchFrame[][]; split: boolean } {
  const pieces: BatchFrame[][] = [];
  let current: BatchFrame[] = [];
  let used = 0;
  for (const item of items) {
    const load = frameLoadSec(item);
    if (current.length && used + load > BATCH_CAPACITY_SEC) {
      pieces.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used = Math.round((used + load) * 1000) / 1000;
  }
  if (current.length) pieces.push(current);
  return { pieces, split: pieces.length > 1 };
}

/**
 * 由帧序与道具区间构建拍摄批次。
 * frames 允许乱序传入，内部按 frameNo 排序；空帧序返回空数组。
 */
export function buildBatches(frames: FrameEntry[], props: PropState[]): BatchView[] {
  const ordered = frames
    .filter((f) => !!f.uid)
    .slice()
    .sort((a, b) => a.frameNo - b.frameNo)
    .map<BatchFrame>((f) => ({ uid: f.uid, frameNo: f.frameNo, shotCount: f.shotCount, exposureSec: f.exposureSec }));
  if (!ordered.length) return [];

  // 1) 按道具区间签名分段（相邻且签名相同的帧属于同一段）
  const runs: Run[] = [];
  for (const frame of ordered) {
    const sig = propsKeyAtFrame(frame.frameNo, props);
    const last = runs[runs.length - 1];
    if (last && last.sig === sig) last.items.push(frame);
    else runs.push({ sig, items: [frame] });
  }

  // 2) 每段在容量内切片；未超容量的段保持完整（区间不拆）
  interface Block {
    sig: string;
    items: BatchFrame[];
    intervalSplit: boolean;
  }
  const blocks: Block[] = [];
  for (const run of runs) {
    const { pieces, split } = splitRunByCapacity(run.items);
    for (const piece of pieces) blocks.push({ sig: run.sig, items: piece, intervalSplit: split });
  }

  // 3) 贪心装批：整块能装进当前批次就并入，装不下整体顺延下一批
  interface BatchBuild {
    blocks: Block[];
  }
  const builds: BatchBuild[] = [];
  const loadOf = (b: BatchBuild) =>
    Math.round(b.blocks.reduce((sum, blk) => sum + blk.items.reduce((s, f) => s + frameLoadSec(f), 0), 0) * 1000) / 1000;

  for (const block of blocks) {
    const blockLoad = block.items.reduce((s, f) => s + frameLoadSec(f), 0);
    const last = builds[builds.length - 1];
    if (last && loadOf(last) + blockLoad <= BATCH_CAPACITY_SEC + 1e-6) {
      last.blocks.push(block);
    } else {
      builds.push({ blocks: [block] });
    }
  }

  // 4) 映射为视图，批次 id 只取决于成员帧 uid
  return builds.map((build, idx) => {
    const batchFrames = build.blocks.flatMap((b) => b.items);
    const usedSec = loadOf(build);
    const labels: string[] = [];
    for (const block of build.blocks) {
      for (const label of propsKeyLabels(block.sig)) {
        if (!labels.includes(label)) labels.push(label);
      }
    }
    return {
      id: `b-${hashString(batchFrames.map((f) => f.uid).join('~'))}`,
      index: idx + 1,
      frames: batchFrames,
      frameUids: batchFrames.map((f) => f.uid),
      usedSec,
      capacitySec: BATCH_CAPACITY_SEC,
      capacityPercent: Math.round((usedSec / BATCH_CAPACITY_SEC) * 1000) / 10,
      plannedShots: batchFrames.reduce((s, f) => s + (f.shotCount || 1), 0),
      propLabels: labels,
      propOverflow: build.blocks.some((b) => b.intervalSplit),
      capacityOverflow: usedSec > BATCH_CAPACITY_SEC + 1e-6,
    };
  });
}

/* ---------------- 实拍记录与帧 / 道具区间的对账 ---------------- */

export interface ReconcilePatch {
  reviewStatus: ReviewStatus;
  reviewNote?: string;
}

export interface ReconcileResult {
  /** 需要落库的变更（take 主键 → 新复核状态），不含与现状一致的记录 */
  patches: Map<number, ReconcilePatch>;
  /** 当前待复核数（有效帧级记录中） */
  reviewCount: number;
  /** 其中原帧已消失的孤儿记录数 */
  orphanCount: number;
}

/**
 * 帧序 / 道具区间变化后的对账（纯函数）：
 * - 旧的按日汇总记录（无 frameUid）与已弃用记录不参与复核；
 * - 找不到原帧 → 待复核（原帧已删除）；
 * - 原帧还在，但当前道具区间签名与登记时不一致 → 待复核（已离开原道具区间）；
 * - 其余恢复正常。
 */
export function reconcileTakes(takes: TakeLog[], frames: FrameEntry[], props: PropState[]): ReconcileResult {
  const byUid = new Map<string, FrameEntry>();
  for (const f of frames) byUid.set(f.uid, f);

  const patches = new Map<number, ReconcilePatch>();
  let reviewCount = 0;
  let orphanCount = 0;

  for (const take of takes) {
    if (take.active === false || !take.frameUid || typeof take.id !== 'number') continue;
    const frame = byUid.get(take.frameUid);
    let status: ReviewStatus = '正常';
    let note: string | undefined;
    if (!frame) {
      status = '待复核';
      note = '原帧已删除';
      orphanCount += 1;
    } else {
      const currentKey = propsKeyAtFrame(frame.frameNo, props);
      if ((take.originPropsKey ?? '') !== currentKey) {
        status = '待复核';
        note = '已离开原道具区间';
      }
    }
    if (status === '待复核') reviewCount += 1;
    if (take.reviewStatus !== status || take.reviewNote !== note) {
      patches.set(take.id, { reviewStatus: status, reviewNote: note });
    }
  }
  return { patches, reviewCount, orphanCount };
}

/** 镜头批次汇总（总览页用）：批次数、容量占用、待复核数 */
export interface ShotBatchSummary {
  batchCount: number;
  /** 已拍批次数（批次内存在有效帧级实拍记录） */
  shotBatchCount: number;
  /** 全部批次占用容量合计（秒） */
  usedSec: number;
  capacitySec: number;
  /** 容量 / 道具区间溢出批次数 */
  overflowCount: number;
  reviewCount: number;
}

export function summarizeShotBatches(frames: FrameEntry[], props: PropState[], takes: TakeLog[]): ShotBatchSummary {
  const batches = buildBatches(frames, props);
  const frameTakes = takes.filter((t) => t.active !== false && !!t.frameUid);
  const shotUidSet = new Set(frameTakes.map((t) => t.frameUid));
  const { reviewCount } = reconcileTakes(takes, frames, props);
  return {
    batchCount: batches.length,
    shotBatchCount: batches.filter((b) => b.frameUids.some((uid) => shotUidSet.has(uid))).length,
    usedSec: Math.round(batches.reduce((s, b) => s + b.usedSec, 0) * 1000) / 1000,
    capacitySec: batches.length * BATCH_CAPACITY_SEC,
    overflowCount: batches.filter((b) => b.capacityOverflow || b.propOverflow).length,
    reviewCount,
  };
}
