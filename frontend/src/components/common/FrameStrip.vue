<script setup lang="ts">
/**
 * 帧序横向条带：按曝光时间 / 道具位移量着色，支持点击选中与拖拽换序。
 * 选中帧后可在条带内就地修改张数、曝光参数与道具位移量。
 * 仅渲染色块与文字标注，不涉及任何图像处理与成片输出。
 */
import { computed, ref } from 'vue';
import type { FrameEntry, ShotCount } from '../../types/frame';
import { SHOT_COUNT_OPTIONS } from '../../types/frame';
import { frameColor, type FrameColorInput } from '../../utils/frameMath';
import type { FrameTakeState } from '../../hooks/useShotBatches';

interface Props {
  frames: FrameEntry[];
  selected?: number | null;
  readonly?: boolean;
  colorBy?: 'offset' | 'exposure';
  /** frameUid → 实拍状态（已拍角标 / 待复核角标），缺省时不渲染 */
  takeStates?: Record<string, FrameTakeState>;
}

const props = withDefaults(defineProps<Props>(), {
  selected: null,
  readonly: false,
  colorBy: 'offset',
  takeStates: () => ({}),
});

const emit = defineEmits<{
  (e: 'update:selected', frameNo: number | null): void;
  (e: 'reorder', from: number, to: number): void;
  (e: 'patch', frameNo: number, patch: Partial<FrameEntry>): void;
}>();

const dragFrom = ref<number | null>(null);

function colorOf(frame: FrameEntry): string {
  const input: FrameColorInput = {
    propOffsetMm: props.colorBy === 'offset' ? frame.propOffsetMm : 0,
    exposureSec: props.colorBy === 'exposure' ? frame.exposureSec : 0.25,
  };
  return frameColor(input);
}

function onSelect(frameNo: number) {
  emit('update:selected', props.selected === frameNo ? null : frameNo);
}

function onDragStart(index: number, ev: DragEvent) {
  if (props.readonly) return;
  dragFrom.value = index;
  ev.dataTransfer?.setData('text/plain', String(index));
}

function onDrop(index: number) {
  if (props.readonly) return;
  const from = dragFrom.value;
  dragFrom.value = null;
  if (from === null || from === index) return;
  emit('reorder', from, index);
}

function patchSelected(patch: Partial<FrameEntry>) {
  if (props.selected === null || props.selected === undefined) return;
  emit('patch', props.selected, patch);
}

const selectedFrame = computed(() => props.frames.find((f) => f.frameNo === props.selected) ?? null);

const totalOffset = computed(() =>
  Math.round(props.frames.reduce((sum, f) => sum + (f.propOffsetMm || 0), 0) * 100) / 100,
);

const shotCountOptions = SHOT_COUNT_OPTIONS;

function takeStateOf(frame: FrameEntry): FrameTakeState | undefined {
  return props.takeStates[frame.uid];
}

const takenFramesCount = computed(() =>
  props.frames.reduce((sum, f) => sum + (props.takeStates[f.uid]?.takenFrames ?? 0), 0),
);
const reviewFramesCount = computed(
  () => props.frames.filter((f) => props.takeStates[f.uid]?.reviewStatus === '待复核').length,
);
</script>

<template>
  <div class="frame-strip" data-testid="frame-strip">
    <div class="strip-meta">
      <span>帧序条带：{{ frames.length }} 帧</span>
      <span>位移合计 {{ totalOffset }} mm</span>
      <span v-if="takenFramesCount" class="shot-meta">已拍 {{ takenFramesCount }} 张</span>
      <span v-if="reviewFramesCount" class="review-meta">待复核 {{ reviewFramesCount }} 帧</span>
      <span v-if="!readonly" class="hint">点击选中 · 拖拽换序</span>
    </div>

    <div class="strip-track">
      <div
        v-for="(frame, index) in frames"
        :key="frame.uid ?? frame.frameNo"
        class="strip-cell"
        :class="{
          active: frame.frameNo === selected,
          readonly,
          shot: !!takeStateOf(frame),
          review: takeStateOf(frame)?.reviewStatus === '待复核',
        }"
        :style="{ background: colorOf(frame) }"
        :draggable="!readonly"
        :data-testid="`strip-cell-${frame.frameNo}`"
        :title="`第 ${frame.frameNo} 帧 · ${frame.shotCount} 张 · ${frame.exposureSec}s · f/${frame.aperture} · ISO${frame.iso} · 位移 ${frame.propOffsetMm}mm${takeStateOf(frame) ? ` · 已拍 ${takeStateOf(frame)?.takenFrames} 张${takeStateOf(frame)?.reviewStatus === '待复核' ? '（待复核）' : ''}` : ''}`"
        @click="onSelect(frame.frameNo)"
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <span
          v-if="takeStateOf(frame)"
          class="cell-badge"
          :class="{ review: takeStateOf(frame)?.reviewStatus === '待复核' }"
          :title="takeStateOf(frame)?.reviewStatus === '待复核' ? `待复核：${takeStateOf(frame)?.reviewNote ?? ''}` : `${takeStateOf(frame)?.date} 实拍`"
        >
          {{ takeStateOf(frame)?.reviewStatus === '待复核' ? '⚠' : '✓' }}{{ takeStateOf(frame)?.takenFrames }}
        </span>
        <span class="cell-no">{{ frame.frameNo }}</span>
        <span class="cell-sub">{{ frame.shotCount }}张</span>
        <span class="cell-sub">{{ frame.propOffsetMm }}mm</span>
      </div>
      <div v-if="!frames.length" class="strip-empty">当前镜头还没有帧条目，请先插入一帧</div>
    </div>

    <div v-if="selectedFrame && !readonly" class="strip-editor" data-testid="strip-editor">
      <div class="editor-title">第 {{ selectedFrame.frameNo }} 帧参数</div>
      <div class="editor-grid">
        <label class="field">
          <span>拍摄张数</span>
          <select
            :value="selectedFrame.shotCount"
            :data-testid="`strip-shotcount-${selectedFrame.frameNo}`"
            @change="patchSelected({ shotCount: Number(($event.target as HTMLSelectElement).value) as ShotCount })"
          >
            <option v-for="opt in shotCountOptions" :key="opt" :value="opt">{{ opt }} 张</option>
          </select>
        </label>
        <label class="field">
          <span>曝光时间 s</span>
          <input
            type="number"
            min="0.008"
            max="8"
            step="0.008"
            :value="selectedFrame.exposureSec"
            @change="patchSelected({ exposureSec: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>光圈 f</span>
          <input
            type="number"
            min="1.4"
            max="22"
            step="0.1"
            :value="selectedFrame.aperture"
            @change="patchSelected({ aperture: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>ISO</span>
          <input
            type="number"
            min="100"
            max="3200"
            step="100"
            :value="selectedFrame.iso"
            @change="patchSelected({ iso: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>快门角度 °</span>
          <input
            type="number"
            min="45"
            max="360"
            step="1"
            :value="selectedFrame.shutterAngle"
            @change="patchSelected({ shutterAngle: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>道具位移 mm</span>
          <input
            type="number"
            min="-200"
            max="200"
            step="0.5"
            :value="selectedFrame.propOffsetMm"
            :data-testid="`strip-offset-${selectedFrame.frameNo}`"
            @change="patchSelected({ propOffsetMm: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame-strip {
  border: 1px solid #d8dee9;
  border-radius: 10px;
  padding: 12px;
  background: #fbfcfe;
}
.strip-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #5a6472;
  margin-bottom: 10px;
}
.strip-meta .hint {
  color: #8a94a6;
}
.strip-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.strip-cell {
  position: relative;
  min-width: 54px;
  height: 74px;
  border-radius: 8px;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  border: 2px solid transparent;
  flex: 0 0 auto;
  transition: transform 0.12s ease;
}
.strip-cell:hover {
  transform: translateY(-2px);
}
.strip-cell.active {
  border-color: #1f2d3d;
  box-shadow: 0 0 0 2px rgba(31, 45, 61, 0.18);
}
.strip-cell.shot {
  box-shadow: inset 0 0 0 2px rgba(58, 166, 117, 0.85);
}
.strip-cell.review {
  box-shadow: inset 0 0 0 2px rgba(196, 86, 86, 0.9);
}
.cell-badge {
  position: absolute;
  top: 2px;
  right: 3px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(58, 166, 117, 0.95);
  color: #fff;
}
.cell-badge.review {
  background: rgba(196, 86, 86, 0.95);
}
.shot-meta {
  color: #2c7c55;
  font-weight: 600;
}
.review-meta {
  color: #c45656;
  font-weight: 600;
}
.strip-cell.readonly {
  cursor: default;
}
.cell-no {
  font-weight: 700;
  font-size: 14px;
}
.cell-sub {
  font-size: 11px;
  opacity: 0.92;
}
.strip-empty {
  color: #8a94a6;
  font-size: 13px;
  padding: 18px 4px;
}
.strip-editor {
  margin-top: 12px;
  border-top: 1px dashed #d8dee9;
  padding-top: 10px;
}
.editor-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
</style>
