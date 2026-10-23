/** 进度上报:阶段 + 单项进度;CLI/TUI 各自实现,编排层只依赖此接口。 */
export interface Progress {
  phase(name: string, detail?: string): void;
  item(label: string, current: number, total: number, bytes?: number): void;
}

/** 测试/daemon 静默模式。 */
export const silentProgress: Progress = {
  phase() {},
  item() {},
};
