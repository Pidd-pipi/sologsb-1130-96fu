<script setup lang="ts">
/**
 * 待复核队列：帧序改动后实拍记录与帧 / 道具区间对不上的条目。
 * - 原帧已删除（孤儿实拍）：确认保留（仅保留在按日汇总口径）或复核弃用（不计入张数）；
 * - 帧离开登记时的道具区间：确认新归属或弃用。
 */
import type { FrameEntry } from '../../types/frame';
import type { TakeLog } from '../../types/take';

export interface ReviewRow {
  take: TakeLog;
  frame?: FrameEntry;
  currentPropsKey: string;
  orphan: boolean;
}

interface Props {
  items: ReviewRow[];
}

defineProps<Props>();

const emit = defineEmits<{
  (e: 'resolve', take: TakeLog): void;
  (e: 'discard', take: TakeLog): void;
}>();

function formatProps(key: string): string {
  return key ? key.split('|').join('、') : '无道具区间';
}
</script>

<template>
  <div class="review-queue" data-testid="review-queue">
    <p v-if="!items.length" class="muted">没有待复核记录：已拍帧都跟着原帧，且仍在登记时的道具区间内。</p>
    <table v-else class="table" data-testid="review-table">
      <thead>
        <tr>
          <th>拍摄日期</th>
          <th>当前帧号</th>
          <th>实拍张数</th>
          <th>问题</th>
          <th>登记时道具区间</th>
          <th>当前道具区间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="item.take.id ?? item.take.uid" :class="{ orphan: item.orphan }">
          <td class="mono">{{ item.take.date }}</td>
          <td class="mono">{{ item.frame ? `第 ${item.frame.frameNo} 帧` : '—' }}</td>
          <td>{{ item.take.takenFrames }} 张<span v-if="item.take.wastedFrames"> · 废 {{ item.take.wastedFrames }}</span></td>
          <td>
            <span class="badge">{{ item.take.reviewNote ?? (item.orphan ? '原帧已删除' : '区间错位') }}</span>
          </td>
          <td class="props">{{ formatProps(item.take.originPropsKey ?? '') }}</td>
          <td class="props">{{ item.orphan ? '—' : formatProps(item.currentPropsKey) }}</td>
          <td class="row-actions">
            <button type="button" class="btn tiny" :data-testid="`review-resolve-${item.take.id}`" @click="emit('resolve', item.take)">
              {{ item.orphan ? '确认保留' : '确认新归属' }}
            </button>
            <button type="button" class="btn tiny danger" :data-testid="`review-discard-${item.take.id}`" @click="emit('discard', item.take)">
              弃用
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
  vertical-align: middle;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
tr.orphan {
  background: #fdf6f6;
}
.props {
  font-size: 12px;
  color: #5a6472;
}
.badge {
  background: #fdeaea;
  color: #c45656;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  white-space: nowrap;
}
.row-actions {
  display: flex;
  gap: 6px;
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
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
</style>
