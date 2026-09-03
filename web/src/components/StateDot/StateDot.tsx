// 状态点(照搬 deepseek-harness ui-primitives/StateDot):
// done/warning/error = 10px 同色光环(10% 透明度) + 6px 实心核;
// ongoing = 3x3 像素矩阵的 8 个外圈单元顺时针追光(阶梯残影)。
import './StateDot.scss';

const MATRIX_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
];

export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error';

export function StateDot({ state, size = 10, className }: {
  state: StateDotState;
  size?: number;
  className?: string;
}) {
  if (state === 'ongoing') {
    return (
      <svg
        className={`dsh-dot-matrix ${className || ''}`}
        data-state="ongoing"
        width={size}
        height={size}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {MATRIX_CELLS.map(([x, y], index) => (
          <rect
            key={`${x}-${y}`}
            className="dsh-dot-cell"
            x={x}
            y={y}
            width="2"
            height="2"
            style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}
          />
        ))}
      </svg>
    );
  }
  return (
    <span
      className={`dsh-dot ${className || ''}`}
      data-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}