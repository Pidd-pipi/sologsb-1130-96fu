/**
 * 拍摄批次编排：把帧序 / 道具区间 / 帧级实拍记录接成可追踪的拍摄批次。
 *
 * 规则（对应需求）：
 * - 按 180 秒容量分批，同一道具区间不拆（见 utils/batchMath）；
 * - 帧序一改，未拍批次立即失效重算（批次 id 由成员帧 uid 决定，成员变化即换新 id）；
 * - 已拍帧与其实拍张数凭 frameUid 继续跟着原帧；
 * - 原帧消失（孤儿）或帧离开登记时的道具区间 → 实拍记录进入待复核；
 * - 登记整批实拍时逐帧写入实拍记录（一帧一条，张数 = 该帧计划张数）。
 *
 * frames 既可以由调用方传入响应式数组（如 frameStore.frames），也可以内部自行读取。
 */
import { computed, ref, toValue, type MaybeRefOrGetter } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import {
  BATCH_CAPACITY_SEC,
  buildBatches,
  frameLoadSec,
  propsKeyAtFrame,
  reconcileTakes,
  type BatchView,
} from '../utils/batchMath';
import { newFrameUid } from '../utils/identity';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';

/** 帧的实拍状态（由帧级实拍记录对账得出） */
export interface FrameTakeState {
  frameUid: string;
  takenFrames: number;
  wastedFrames: number;
  date: string;
  reviewStatus: TakeLog['reviewStatus'];
  reviewNote?: string;
}

/** 待复核队列项（含找不到原帧的孤儿实拍记录） */
export interface ReviewItem {
  take: TakeLog;
  frame?: FrameEntry;
  currentPropsKey: string;
  orphan: boolean;
}

function takeUidKey(take: TakeLog): string {
  return take.uid || (typeof take.id === 'number' ? `id-${take.id}` : `tmp-${take.date}-${take.takenFrames}`);
}

export function useShotBatches(
  shotIdSource: MaybeRefOrGetter<number | null>,
  options?: { frames?: MaybeRefOrGetter<FrameEntry[]> },
) {
  const shotStore = useShotStore();
  const propsRows = ref<PropState[]>([]);
  const takesRows = ref<TakeLog[]>([]);
  const internalFrames = ref<FrameEntry[]>([]);
  const loaded = ref(false);
  /** 最近一次帧序改动导致失效重算的未拍批次数（供页面提示，提示后清零） */
  const invalidatedCount = ref(0);
  let prevUnshotKey = '';
  let prevShotId: number | null = null;

  const shotId = computed(() => toValue(shotIdSource));
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const frames = computed<FrameEntry[]>(() =>
    options?.frames ? toValue(options.frames) : internalFrames.value,
  );

  /** 有效帧级实拍记录（旧的按日汇总记录与弃用记录不参与批次追踪） */
  const frameTakes = computed(() => takesRows.value.filter((t) => t.active !== false && !!t.frameUid));

  /** 当前帧序 × 道具区间算出的全部批次（未拍计划即此派生结果，天然「一改即重算」） */
  const batches = computed<BatchView[]>(() => buildBatches(frames.value, propsRows.value));

  /** frameUid → 帧级实拍记录 */
  const takeByFrameUid = computed(() => {
    const map = new Map<string, TakeLog>();
    for (const t of frameTakes.value) map.set(t.frameUid as string, t);
    return map;
  });

  const shotBatchCount = computed(
    () => batches.value.filter((b) => b.frameUids.some((uid) => takeByFrameUid.value.has(uid))).length,
  );

  function frameState(frameUid: string): FrameTakeState | undefined {
    const t = takeByFrameUid.value.get(frameUid);
    if (!t) return undefined;
    return {
      frameUid,
      takenFrames: t.takenFrames,
      wastedFrames: t.wastedFrames,
      date: t.date,
      reviewStatus: t.reviewStatus,
      reviewNote: t.reviewNote,
    };
  }

  function batchOf(frameUid: string): BatchView | undefined {
    return batches.value.find((b) => b.frameUids.includes(frameUid));
  }

  /** 批次视图附加拍摄进度：已拍帧数 / 张数、整体状态 */
  const batchViews = computed(() =>
    batches.value.map((b) => {
      const states = b.frameUids
        .map((uid) => takeByFrameUid.value.get(uid))
        .filter((t): t is TakeLog => !!t);
      const shotFrames = states.length;
      const takenShots = states.reduce((s, t) => s + (t.takenFrames || 0), 0);
      const reviewFrames = states.filter((t) => t.reviewStatus === '待复核').length;
      let status: '已拍' | '部分已拍' | '未拍';
      if (shotFrames >= b.frames.length) status = '已拍';
      else if (shotFrames > 0) status = '部分已拍';
      else status = '未拍';
      return {
        ...b,
        status,
        shotFrames,
        totalFrames: b.frames.length,
        takenShots,
        reviewFrames,
      };
    }),
  );

  /** 待复核队列：待复核的帧级记录 + 原帧已消失的孤儿记录 */
  const reviewItems = computed<ReviewItem[]>(() => {
    const byUid = new Map<string, FrameEntry>();
    for (const f of frames.value) byUid.set(f.uid, f);
    const items: ReviewItem[] = [];
    for (const t of frameTakes.value) {
      if (t.reviewStatus !== '待复核') continue;
      const frame = byUid.get(t.frameUid as string);
      items.push({
        take: t,
        frame,
        currentPropsKey: frame ? propsKeyAtFrame(frame.frameNo, propsRows.value) : '',
        orphan: !frame,
      });
    }
    return items.sort((a, b) => (a.orphan === b.orphan ? 0 : a.orphan ? -1 : 1));
  });

  const reviewCount = computed(() => reviewItems.value.length);

  const capacitySec = computed(() => batches.value.length * BATCH_CAPACITY_SEC);
  const usedSec = computed(() =>
    Math.round(batches.value.reduce((s, b) => s + b.usedSec, 0) * 1000) / 1000,
  );
  const overflowCount = computed(
    () => batches.value.filter((b) => b.capacityOverflow || b.propOverflow).length,
  );

  /**
   * 对账并落库：原帧消失 / 离开原道具区间 → 待复核。
   * 同时比对未拍批次快照，统计帧序改动导致失效重算的批次数。
   */
  async function reconcile(): Promise<number> {
    // 先确保每一帧都有 uid（防御历史数据）
    const ensured: FrameEntry[] = [];
    let changed = false;
    for (const f of frames.value) {
      if (!f.uid) {
        ensured.push({ ...f, uid: newFrameUid() });
        changed = true;
      } else {
        ensured.push(f);
      }
    }
    if (changed && options?.frames && shotId.value !== null) {
      // 外部数组缺 uid（极少见），落库补齐
      await api.updateFrames(ensured);
    }

    const result = reconcileTakes(takesRows.value, ensured, propsRows.value);
    if (result.patches.size) {
      for (const [id, patch] of result.patches) await api.patchTake(id, patch);
      takesRows.value = takesRows.value.map((t) =>
        typeof t.id === 'number' && result.patches.has(t.id)
          ? { ...t, ...result.patches.get(t.id) }
          : t,
      );
    }

    // 未拍批次失效统计：取所有未拍成员帧 uid 拼成签名，与上一轮比对
    const shotUidSet = new Set(
      takesRows.value.filter((t) => t.active !== false && t.frameUid).map((t) => t.frameUid),
    );
    const unshotKey = batches.value
      .map((b) => b.frameUids.filter((uid) => !shotUidSet.has(uid)).join(','))
      .filter((s) => s.length)
      .join('|');
    if (loaded.value && shotId.value === prevShotId && unshotKey !== prevUnshotKey) {
      invalidatedCount.value = batches.value.filter((b) =>
        b.frameUids.some((uid) => !shotUidSet.has(uid)),
      ).length;
    }
    prevUnshotKey = unshotKey;
    return result.reviewCount;
  }

  /** 载入 / 刷新一镜的道具区间与实拍记录，并做一次对账 */
  async function load() {
    const id = shotId.value;
    if (id === null) return;
    propsRows.value = await api.listProps(id);
    takesRows.value = await api.listTakesByShot(id);
    if (!options?.frames) internalFrames.value = await api.listFrames(id);
    loaded.value = true;
    prevShotId = id;
    await reconcile();
  }

  function clearInvalidationNotice() {
    invalidatedCount.value = 0;
  }

  /**
   * 登记整批实拍：对批次内尚无有效实拍记录的帧逐帧写入一条 TakeLog，
   * 张数 = 该帧计划张数；已拍帧不重复登记（跟着原帧保留）。
   */
  async function registerBatch(batch: BatchView, date: string): Promise<{ added: number }> {
    const id = shotId.value;
    const current = shot.value;
    if (id === null || !current) return { added: 0 };
    const originPropsKeyByUid = new Map<string, string>();
    for (const f of frames.value) originPropsKeyByUid.set(f.uid, propsKeyAtFrame(f.frameNo, propsRows.value));

    const added: TakeLog[] = [];
    for (const bf of batch.frames) {
      if (takeByFrameUid.value.has(bf.uid)) continue;
      added.push({
        uid: `take-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        date,
        shotCode: current.code,
        shotId: id,
        frameUid: bf.uid,
        takenFrames: bf.shotCount || 1,
        wastedFrames: 0,
        remainingFrames: 0,
        percent: 0,
        originPropsKey: originPropsKeyByUid.get(bf.uid) ?? '',
        batchId: batch.id,
        reviewStatus: '正常',
        active: true,
        updatedAt: Date.now(),
      });
    }
    if (!added.length) return { added: 0 };

    const saved: TakeLog[] = [];
    for (const row of added) {
      const newId = await api.addTake(row);
      saved.push({ ...row, id: newId });
    }
    takesRows.value = [...saved, ...takesRows.value];

    // 登记时快照本镜完成度
    const planned = Math.max(1, frames.value.length);
    const takenUid = new Set([...frameTakes.value, ...saved].map((t) => t.frameUid));
    const percent = Math.min(100, Math.round((takenUid.size / planned) * 100));
    await shotStore.syncProgress(id, percent);
    prevUnshotKey = ''; // 刚拍完，未拍计划必然变化，不把自身算作「失效」
    await reconcile();
    return { added: saved.length };
  }

  /** 复核确认：记录仍有效，恢复正常状态 */
  async function resolveReview(take: TakeLog) {
    if (typeof take.id !== 'number') return;
    const frame = frames.value.find((f) => f.uid === take.frameUid);
    const patch = {
      reviewStatus: '正常' as const,
      reviewNote: frame ? '已复核确认' : '原帧已删除，确认保留',
      // 帧仍在则以当前道具区间为新的归属基准
      ...(frame ? { originPropsKey: propsKeyAtFrame(frame.frameNo, propsRows.value) } : {}),
    };
    await api.patchTake(take.id, patch);
    takesRows.value = takesRows.value.map((t) => (t.id === take.id ? { ...t, ...patch } : t));
  }

  /** 复核弃用：软删除，不计入实拍汇总与待复核数 */
  async function discardReview(take: TakeLog) {
    if (typeof take.id !== 'number') return;
    await api.patchTake(take.id, { active: false, reviewStatus: '正常', reviewNote: '复核弃用' });
    takesRows.value = takesRows.value.filter((t) => t.id !== take.id);
  }

  return {
    // 状态
    frames,
    props: propsRows,
    takes: takesRows,
    loaded,
    invalidatedCount,
    capacityLimit: BATCH_CAPACITY_SEC,
    // 派生
    batches,
    batchViews,
    reviewItems,
    reviewCount,
    shotBatchCount,
    capacitySec,
    usedSec,
    overflowCount,
    frameLoadSec,
    // 动作
    load,
    reconcile,
    clearInvalidationNotice,
    frameState,
    batchOf,
    registerBatch,
    resolveReview,
    discardReview,
    takeKey: takeUidKey,
  };
}
