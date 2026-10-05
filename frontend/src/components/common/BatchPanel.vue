<script setup lang="ts">
/**
 * 拍摄批次面板：按 180 秒容量展示批次划分、道具区间归属、容量占用与拍摄状态。
 * 可交互模式（镜头详情）支持整批登记实拍；只读模式（帧序编排台）只做展示。
 */
import { ref } from 'vue';
import { today } from '../../utils/format';
import type { BatchView } from '../../utils/batchMath';

export type BatchCardData = BatchView & {
  status: '已拍' | '部分已拍' | '未拍';
  shotFrames: number;
  totalFrames: number;
  takenShots: number;
  reviewFrames: number;
};

interface Props {
  batches: BatchCardData[];
  /** 全部批次占用容量合计（秒） */
  usedSec?: number;
  capacitySec?: number;
  capacityLimit?: number;
  overflowCount?: number;
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  usedSec: 0,
  capacitySec: 0,
  capacityLimit: 180,
  overflowCount: 0,
  readonly: false,
});

const emit = defineEmits<{
  (e: 'shoot', batch: BatchCardData, date: string): void;
}>();

const openBatchId = ref<string | null>(null);
const shootDate = ref(today());

function toggle(batch: BatchCardData) {
  openBatchId.value = openBatchId.value === batch.id ? null : batch.id;
}

async function confirm(batch: BatchCardData) {
  emit('shoot', batch, shootDate.value || today());
  openBatchId.value = null;
}

function statusClass(status: BatchCardData['status']): string {
  if (status === '已拍') return 'done';
  if (status === '部分已拍') return 'partial';
  return 'pending';
}
</script>

<template>
  <div class="batch-panel" data-testid="batch-panel">
    <div class="summary">
      <span>共 <strong>{{ batches.length }}</strong> 个批次</span>
      <span>容量 {{ Math.round(usedSec) }} / {{ capacitySec }} 秒（每批 {{ capacityLimit }} 秒）</span>
      <span v-if="overflowCount" class="warn">⚠ {{ overflowCount }} 批容量 / 道具区间溢出</span>
      <span v-if="readonly" class="muted">只读预览 · 改动帧序后未拍批次立即失效重算</span>
    </div>

    <p v-if="!batches.length" class="muted empty">该镜头还没有帧，先在帧序中插入帧。</p>

    <div v-else class="grid">
      <article
        v-for="batch in batches"
        :key="batch.id"
        class="card"
        :class="[statusClass(batch.status), { open: openBatchId === batch.id }]"
        :data-testid="`batch-card-${batch.index}`"
      >
        <header class="card-head">
          <span class="no">批次 {{ batch.index }}</span>
          <span class="tag">{{ batch.status }}</span>
          <span v-if="batch.reviewFrames" class="tag review">待复核 {{ batch.reviewFrames }}</span>
        </header>
        <div class="range mono">
          帧 {{ batch.frames[0]?.frameNo }} – {{ batch.frames[batch.frames.length - 1]?.frameNo }}
          · {{ batch.frames.length }} 帧
        </div>
        <div class="capacity">
          <div class="cap-bar">
            <div
              class="cap-fill"
              :class="{ over: batch.capacityOverflow }"
              :style="{ width: Math.min(100, batch.capacityPercent) + '%' }"
            ></div>
          </div>
          <span class="cap-text" :class="{ over: batch.capacityOverflow }">
            {{ batch.usedSec.toFixed(1) }} / {{ batch.capacitySec }} 秒
          </span>
        </div>
        <div class="meta">
          <span>计划 {{ batch.plannedShots }} 张</span>
          <span v-if="batch.shotFrames">已拍 {{ batch.shotFrames }} 帧 / {{ batch.takenShots }} 张</span>
        </div>
        <div class="props" :title="batch.propLabels.join('、')">
          <span v-for="label in batch.propLabels.slice(0, 3)" :key="label" class="prop-chip">{{ label }}</span>
          <span v-if="batch.propLabels.length > 3" class="prop-chip">+{{ batch.propLabels.length - 3 }}</span>
        </div>
        <p v-if="batch.propOverflow" class="warn tiny">同一道具区间超过 {{ capacityLimit }} 秒，已被迫跨批拆开</p>
        <p v-else-if="batch.capacityOverflow" class="warn tiny">本批超出 {{ capacityLimit }} 秒容量上限</p>

        <div v-if="!readonly" class="actions">
          <button type="button" class="btn tiny" @click="toggle(batch)">
            {{ openBatchId === batch.id ? '收起' : batch.status === '已拍' ? '查看 / 补拍' : '整批登记实拍' }}
          </button>
        </div>
        <div v-if="!readonly && openBatchId === batch.id" class="shoot-form" @click.stop>
          <label class="field">
            <span>拍摄日期</span>
            <input v-model="shootDate" type="date" :data-testid="`batch-date-${batch.index}`" />
          </label>
          <button type="button" class="btn tiny primary" :data-testid="`batch-shoot-${batch.index}`" @click="confirm(batch)">
            为 {{ batch.frames.length - batch.shotFrames }} 个未拍帧登记实拍
          </button>
          <span class="muted tiny">已拍帧保留原实拍张数，不重复登记</span>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.batch-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #3d4757;
}
.summary strong {
  color: #1f2d3d;
  font-size: 15px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.tiny {
  font-size: 12px;
}
.warn {
  color: #c47f17;
  font-size: 12px;
  font-weight: 600;
}
.empty {
  margin: 4px 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 12px;
}
.card {
  border: 1px solid #e2e7ef;
  border-left-width: 4px;
  border-radius: 10px;
  padding: 12px;
  background: #fbfcfe;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card.pending {
  border-left-color: #b9c2d0;
}
.card.partial {
  border-left-color: #d99b2b;
}
.card.done {
  border-left-color: #3aa675;
  background: #f7fdfa;
}
.card.open {
  box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.15);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.no {
  font-weight: 700;
  font-size: 14px;
  color: #1f2d3d;
}
.tag {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #eef1f6;
  color: #5a6472;
}
.card.partial .tag {
  background: #fdf0d8;
  color: #9a6a12;
}
.card.done .tag {
  background: #def3e8;
  color: #2c7c55;
}
.tag.review {
  margin-left: 0;
  background: #fdeaea;
  color: #c45656;
}
.range {
  font-size: 12px;
  color: #5a6472;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.capacity {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cap-bar {
  flex: 1;
  height: 8px;
  border-radius: 6px;
  background: #edf0f5;
  overflow: hidden;
}
.cap-fill {
  height: 100%;
  background: #2f6fed;
  border-radius: 6px;
}
.cap-fill.over {
  background: #c45656;
}
.cap-text {
  font-size: 11px;
  color: #5a6472;
  white-space: nowrap;
}
.cap-text.over {
  color: #c45656;
  font-weight: 600;
}
.meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #5a6472;
}
.props {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.prop-chip {
  font-size: 11px;
  background: #f0f4ff;
  border: 1px solid #dbe6ff;
  color: #34538f;
  border-radius: 999px;
  padding: 1px 8px;
}
.actions {
  margin-top: auto;
}
.shoot-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  border-top: 1px dashed #d8dee9;
  padding-top: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: #5a6472;
}
.field input {
  height: 26px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 6px;
  font-size: 12px;
  background: #fff;
}
.btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 12px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
</style>
