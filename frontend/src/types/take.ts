/** 复核状态：帧序改动后，实拍记录与帧 / 道具区间的对应可能失效 */
export type ReviewStatus = '正常' | '待复核';

/** 一条实拍登记记录（可按镜头 + 日期汇总，也可逐帧登记） */
export interface TakeLog {
  id?: number;
  /** 稳定身份（升级回填），便于外部引用与去重 */
  uid: string;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /**
   * 逐帧实拍时关联的帧 uid（FrameEntry.uid）。
   * 旧的按日汇总记录没有该字段（undefined），仍参与镜头级进度汇总。
   */
  frameUid?: string;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  /**
   * 登记时帧所属的道具区间签名（各道具区间 名称[起-止] 用 | 拼接）。
   * 帧序改动后若该帧已离开原区间，则进入待复核。
   */
  originPropsKey?: string;
  /** 登记时归属的拍摄批次 id（由成员帧 uid 哈希得出） */
  batchId?: string;
  /** 复核状态，正常 / 待复核 */
  reviewStatus: ReviewStatus;
  /** 复核结论备注（如「原帧已删除」「已离开原道具区间」） */
  reviewNote?: string;
  /** 软删除：复核弃用时置 false，默认 true；汇总与清单只统计有效记录 */
  active: boolean;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  uid: '',
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  reviewStatus: '正常',
  active: true,
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
