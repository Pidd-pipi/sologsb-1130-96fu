/**
 * 拍摄批次计算：按 180 秒容量分批，同一道具区间不能拆开。
 * 批次是帧序列的分组，用于指导拍摄排期。
 * 纯函数，无副作用。
 */
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';

/** 批次容量（秒） */
export const BATCH_CAPACITY_SEC = 180;

export interface ShootBatch {
  /** 批次序号（从 1 开始） */
  batchNo: number;
  /** 本批次包含的帧稳定身份（按帧序排列） */
  frameUids: string[];
  /** 本批次实际容量（秒） */
  capacitySec: number;
  /** 本批次涉及的道具区间 id */
  propIds: number[];
  /** 批次状态：未拍 / 已拍 / 部分 */
  status: 'pending' | 'shot' | 'partial';
}

/** 单帧容量消耗（秒）：1/拍摄张数 */
export function frameCost(frame: FrameEntry): number {
  return 1 / (frame.shotCount || 1);
}

/**
 * 计算每个帧的「必须与下一帧同批」标记。
 * 若相邻两帧被同一道具区间覆盖，则它们不能被拆开。
 */
export function computeMustStay(frames: FrameEntry[], props: PropState[]): boolean[] {
  const n = frames.length;
  const mustStay = new Array<boolean>(n).fill(false);
  for (const prop of props) {
    if (typeof prop.id !== 'number' || !prop.fromUid || !prop.toUid) continue;
    const fromIdx = frames.findIndex((f) => f.uid === prop.fromUid);
    const toIdx = frames.findIndex((f) => f.uid === prop.toUid);
    if (fromIdx < 0 || toIdx < 0) continue;
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    for (let i = lo; i < hi; i++) {
      mustStay[i] = true;
    }
  }
  return mustStay;
}

/**
 * 拍摄批次计算：贪心分批。
 * 遍历帧序列，累加容量；当加入下一帧会超过容量且存在合法边界时，关闭当前批次。
 * 道具区间是硬约束：同一区间的帧绝不拆开（即使超过容量）。
 */
export function computeBatches(
  frames: FrameEntry[],
  props: PropState[],
  capacitySec: number = BATCH_CAPACITY_SEC,
): ShootBatch[] {
  const mustStay = computeMustStay(frames, props);
  const batches: ShootBatch[] = [];
  let currentUids: string[] = [];
  let currentCapacity = 0;
  const currentPropIds = new Set<number>();

  const flush = () => {
    if (currentUids.length === 0) return;
    const batchFrames = frames.filter((f) => currentUids.includes(f.uid));
    const shotCount = batchFrames.filter((f) => f.shot).length;
    let status: ShootBatch['status'] = 'pending';
    if (shotCount === batchFrames.length) status = 'shot';
    else if (shotCount > 0) status = 'partial';
    batches.push({
      batchNo: batches.length + 1,
      frameUids: [...currentUids],
      capacitySec: Math.round(currentCapacity * 1000) / 1000,
      propIds: [...currentPropIds],
      status,
    });
    currentUids = [];
    currentCapacity = 0;
    currentPropIds.clear();
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const cost = frameCost(frame);
    const wouldExceed = currentCapacity + cost > capacitySec;
    // 合法边界：当前帧不是道具区间的中间帧（即 i-1 与 i 不必同批）
    const canClose = currentUids.length > 0 && !mustStay[i - 1];

    if (wouldExceed && canClose) {
      flush();
    }

    currentUids.push(frame.uid);
    currentCapacity += cost;
    for (const prop of props) {
      if (typeof prop.id === 'number' && frame.propIds.includes(prop.id)) {
        currentPropIds.add(prop.id);
      }
    }
  }

  flush();
  return batches;
}

/**
 * 待复核检查：帧序变化后，检查已拍帧是否消失或离开原区间。
 * 返回 uid → 原因 的映射。
 */
export function checkReview(
  prevFrames: FrameEntry[],
  nextFrames: FrameEntry[],
): Map<string, string> {
  const reviewMap = new Map<string, string>();
  const nextUids = new Set(nextFrames.map((f) => f.uid));

  for (const prev of prevFrames) {
    if (!prev.shot) continue;
    // 原帧消失
    if (!nextUids.has(prev.uid)) {
      reviewMap.set(prev.uid, '原帧已删除');
      continue;
    }
    // 原帧离开原区间
    const next = nextFrames.find((f) => f.uid === prev.uid);
    if (!next) continue;
    const prevPropIds = new Set(prev.propIds);
    const nextPropIds = new Set(next.propIds);
    let left = false;
    for (const id of prevPropIds) {
      if (!nextPropIds.has(id)) {
        left = true;
        break;
      }
    }
    if (left) {
      reviewMap.set(prev.uid, '离开原道具区间');
    }
  }

  return reviewMap;
}

/**
 * 计算每个帧的道具区间 id 列表（基于当前帧序列与道具区间）。
 * 返回 uid → propIds 的映射。
 */
export function computeFramePropIds(
  frames: FrameEntry[],
  props: PropState[],
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const frame of frames) {
    result.set(frame.uid, []);
  }
  for (const prop of props) {
    if (typeof prop.id !== 'number' || !prop.fromUid || !prop.toUid) continue;
    const fromIdx = frames.findIndex((f) => f.uid === prop.fromUid);
    const toIdx = frames.findIndex((f) => f.uid === prop.toUid);
    if (fromIdx < 0 || toIdx < 0) continue;
    const lo = Math.min(fromIdx, toIdx);
    const hi = Math.max(fromIdx, toIdx);
    for (let i = lo; i <= hi; i++) {
      const uid = frames[i].uid;
      const list = result.get(uid) ?? [];
      list.push(prop.id);
      result.set(uid, list);
    }
  }
  return result;
}

/**
 * 由道具区间的 fromUid/toUid 推导显示用的 fromFrame/toFrame。
 * 若 uid 找不到对应帧，回退到 prop 上存储的原始值。
 */
export function propDisplayRange(
  prop: PropState,
  frames: FrameEntry[],
): { fromFrame: number; toFrame: number } {
  const fromIdx = frames.findIndex((f) => f.uid === prop.fromUid);
  const toIdx = frames.findIndex((f) => f.uid === prop.toUid);
  if (fromIdx < 0 || toIdx < 0) {
    return { fromFrame: prop.fromFrame, toFrame: prop.toFrame };
  }
  return { fromFrame: frames[fromIdx].frameNo, toFrame: frames[toIdx].frameNo };
}
