import { useId } from "react";

// The ECLYPS wordmark. The drawing is docs/brand/eclyps-wordmark.svg: E, L, Y and P are hairline
// strokes, the C a contrast letter with flat-cut ends, the S drawn point-symmetric with its top end
// optically shortened. Keep the two in step.
const E = "M332 242.75 H452 M332 318 H433 M332 395.25 H452";
const L = "M831.75 238.0 V395.25 H933";
const Y = "M1025.46 228 L1103.5 323.0 L1181.54 228 M1103.5 323.0 V400.0";
const P = "M1293 242.75 H1374.88 A45.38 45.38 0 0 1 1374.88 333.5 H1297.75 V400.0";
const C = "M698.0 269.00 A85.0 85.0 0 1 0 698.0 371.00 L698.0 360.40 A74.0 74.0 0 1 1 698.0 279.60 Z";
const S =
  "M1647.71 250.85 L1641.05 246.21 L1635.77 243.00 L1629.98 240.10 L1624.17 237.79 L1618.76 236.14 L1611.59 234.67 L1605.10 233.99 L1597.49 233.93 L1587.54 234.60 L1578.37 235.86 L1569.98 237.70 L1562.87 239.96 L1555.90 243.05 L1550.60 246.27 L1545.71 250.29 L1542.45 253.89 L1540.53 256.59 L1538.87 259.53 L1536.95 264.36 L1536.11 267.83 L1535.65 271.45 L1535.69 277.52 L1536.75 284.32 L1538.91 290.71 L1542.12 296.59 L1546.26 301.90 L1551.21 306.64 L1555.69 310.07 L1561.88 313.99 L1568.71 317.56 L1576.16 320.88 L1582.56 323.38 L1606.55 331.43 L1615.51 334.83 L1623.34 338.34 L1630.99 342.59 L1635.43 345.72 L1638.38 348.28 L1640.80 350.87 L1642.74 353.51 L1644.24 356.23 L1645.33 359.10 L1646.16 363.03 L1646.38 366.50 L1646.19 369.49 L1645.69 372.17 L1644.86 374.73 L1643.68 377.25 L1642.13 379.77 L1640.19 382.28 L1637.86 384.75 L1635.17 387.14 L1628.93 391.57 L1620.71 395.89 L1612.25 399.10 L1604.34 401.10 L1598.64 401.83 L1590.71 401.68 L1581.76 400.74 L1574.84 399.47 L1566.02 397.17 L1557.27 394.09 L1548.56 390.18 L1539.81 385.37 L1539.25 386.44 L1546.92 391.43 L1553.33 395.10 L1559.27 397.99 L1567.40 401.18 L1575.34 403.50 L1582.61 404.97 L1590.43 405.88 L1597.91 406.12 L1608.45 405.63 L1617.55 404.59 L1625.99 403.01 L1634.64 400.57 L1641.72 397.66 L1647.14 394.61 L1652.17 390.79 L1656.59 386.07 L1658.49 383.35 L1660.13 380.40 L1661.99 375.54 L1662.79 372.06 L1663.20 368.43 L1663.06 362.32 L1661.86 355.52 L1659.57 349.15 L1656.25 343.31 L1652.03 338.04 L1648.08 334.22 L1642.51 329.90 L1636.29 326.00 L1629.44 322.43 L1623.51 319.76 L1615.56 316.62 L1593.17 309.13 L1584.04 305.74 L1574.83 301.67 L1568.23 298.04 L1564.53 295.56 L1561.37 293.05 L1558.76 290.50 L1556.66 287.91 L1555.03 285.27 L1553.81 282.51 L1552.97 279.54 L1552.52 276.28 L1552.67 270.62 L1553.22 267.92 L1554.09 265.33 L1555.30 262.78 L1556.89 260.24 L1558.85 257.72 L1561.19 255.24 L1566.82 250.56 L1573.40 246.45 L1581.64 242.59 L1589.72 239.89 L1595.95 238.56 L1600.98 238.12 L1608.62 238.48 L1615.66 239.45 L1623.12 241.16 L1632.27 244.26 L1639.48 247.55 L1647.13 251.90Z";

/**
 * The name, in `currentColor`. Size it with CSS (its width follows its height). `hairline` (px)
 * holds the straight letters' strokes at that width whatever the size: below about 200 px wide the
 * drawing's own hairline would turn grey.
 */
export function Wordmark({ className, hairline }: { className?: string; hairline?: number }) {
  const clip = `wm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // vector-effect is not inherited: it goes on each path.
  const line = hairline ? { strokeWidth: hairline, vectorEffect: "non-scaling-stroke" as const } : { strokeWidth: 9.5 };
  return (
    <svg viewBox="322 224 1348 192" className={className} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <rect x="322" y="238.0" width="1348" height="162.0" />
        </clipPath>
      </defs>
      <g fill="none" stroke="currentColor" strokeLinecap="butt" strokeLinejoin="miter">
        <path d={E} {...line} />
        <path d={L} {...line} />
        <path d={Y} {...line} clipPath={`url(#${clip})`} />
        <path d={P} {...line} />
      </g>
      <g fill="currentColor">
        <path d={C} />
        <path d={S} />
      </g>
    </svg>
  );
}
