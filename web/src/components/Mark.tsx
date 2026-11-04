/**
 * trove 的标记:三道递减的横线 —— vault 的分层(raw / library / index)。
 * 用强调色画在侧栏顶部,不是黑底字母。
 */
export default function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="2.4" rx="1.2" fill="#4a8ad6" />
      <rect x="2" y="10.8" width="14" height="2.4" rx="1.2" fill="#4a8ad6" opacity="0.72" />
      <rect x="2" y="17.6" width="8" height="2.4" rx="1.2" fill="#4a8ad6" opacity="0.45" />
    </svg>
  );
}
