/**
 * 稳定身份工具：
 * - 帧（FrameEntry）的 uid 在插入时生成、终生不变，帧序重排后仍能追踪到同一帧；
 * - 旧数据升级时没有 uid，则按镜头 + 当时帧号回填 legacy uid；
 * - 批次 id 由成员 uid 稳定哈希得出：未拍批次随帧序变化立即失效重算，
 *   而已拍批次（含相同成员）的 id 保持一致，便于核对。
 */

/** 生成一个新的稳定 uid（时间戳 + 随机后缀，冲突概率可忽略） */
export function newFrameUid(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `f-${Date.now().toString(36)}-${rand}`;
}

/** 旧数据升级时按主键回填的稳定 uid */
export function legacyFrameUid(rowId: number | undefined): string {
  return `legacy-${rowId ?? `x-${Math.random().toString(36).slice(2, 8)}`}`;
}

/** 旧实拍记录升级时按主键回填的稳定 uid */
export function legacyTakeUid(rowId: number | undefined): string {
  return `take-legacy-${rowId ?? `x-${Math.random().toString(36).slice(2, 8)}`}`;
}

/** 32 位非负字符串哈希（FNV-1a 风格，纯确定性，用于生成批次 id） */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 转成无符号 36 进制，紧凑且稳定
  return (h >>> 0).toString(36);
}
