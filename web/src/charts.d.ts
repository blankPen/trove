/** charts.js 的类型声明(源文件是随包附带的 IIFE,运行时挂在 window.Charts 上)。 */

export interface ChartFormat {
  (value: number): string;
}

export interface BarsOptions {
  labels: string[];
  values: number[];
  format?: ChartFormat;
  tickFormat?: ChartFormat | null;
  height?: number;
  highlight?: number | number[] | null;
  dim?: number[];
  colour?: string;
  mutedColour?: string;
  xAt?: number[] | null;
}

export interface BarListRow {
  label: string;
  value: number;
  sub?: string;
}

export interface BarListOptions {
  format?: ChartFormat;
  thin?: boolean;
  labelWidth?: number;
}

export interface LineOptions {
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  format?: ChartFormat;
  height?: number;
  xAt?: number[] | null;
}

export interface ChartHelpers {
  bars(el: HTMLElement, options: BarsOptions): void;
  line(el: HTMLElement, options: LineOptions): void;
  barList(el: HTMLElement, rows: BarListRow[], options?: BarListOptions): void;
  fmt: {
    int(value: number): string;
    dec(decimals: number): ChartFormat;
    pct(decimals?: number): ChartFormat;
    compact(value: number): string;
    ms(value: number): string;
    signed(format?: ChartFormat): ChartFormat;
    clock(minutes: number): string;
  };
}

declare const Charts: ChartHelpers;
export default Charts;
