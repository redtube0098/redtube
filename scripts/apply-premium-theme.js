/**
 * Premium Red Theme Applicator for REDTUBE TMA
 * 
 * Reads style.css.bak (original) and applies a full premium red redesign:
 * - Deeper blacks, richer backgrounds
 * - Glassmorphism header & bottom nav
 * - 3D tactile buttons with press-down effect
 * - Neon red glows throughout
 * - Enhanced card backgrounds with subtle red gradients
 * - Premium modal sheets with red-tinted glass
 * - All class names/IDs/structure preserved exactly
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'public', 'style.css.bak');
const destPath = path.join(__dirname, '..', 'public', 'style.css');

let css = fs.readFileSync(srcPath, 'utf8');

// ============================================================
// 1. :root variables — deeper blacks, richer reds
// ============================================================
css = css.replace(
  /--bg:\s*#0a0e17;/,
  '--bg: #050208;'
);
css = css.replace(
  /--card:\s*#131a2a;/,
  '--card: #0d0610;'
);
css = css.replace(
  /--card2:\s*#0e1420;/,
  '--card2: #09040d;'
);
css = css.replace(
  /--blue:\s*#ff1437;/,
  '--blue: #ff0a2d;'
);
css = css.replace(
  /--blue-light:\s*#ff4d6e;/,
  '--blue-light: #ff3358;'
);
css = css.replace(
  /--accent-blue:\s*#3b82f6;/,
  '--accent-blue: #ff2244;'
);
css = css.replace(
  /--accent-blue-light:\s*#60a5fa;/,
  '--accent-blue-light: #ff5577;'
);
css = css.replace(
  /--text:\s*#e5e9f0;/,
  '--text: #f0e8ec;'
);
css = css.replace(
  /--text-dim:\s*#8b94a7;/,
  '--text-dim: #8a7a82;'
);
css = css.replace(
  /--border:\s*#1f2937;/,
  '--border: #1a0a12;'
);

// ============================================================
// 2. Body background — red-tinted radial gradient
// ============================================================
css = css.replace(
  /body::before\s*\{[\s\S]*?content:\s*['"]'?['"]?;[\s\S]*?background:\s*radial-gradient\(circle at 50% 0%,\s*rgba\(59,130,246,0\.10\)\s*0%,\s*rgba\(59,130,246,0\.03\)\s*40%,\s*transparent\s*70%\);/,
  `body::before {\n  content: '';\n  position: fixed;\n  inset: 0;\n  background:\n    radial-gradient(circle at 50% 0%, rgba(255,10,45,0.12) 0%, rgba(255,10,45,0.04) 35%, transparent 65%),\n    radial-gradient(circle at 20% 80%, rgba(120,0,30,0.08) 0%, transparent 50%),\n    radial-gradient(circle at 80% 60%, rgba(80,0,20,0.06) 0%, transparent 45%);`
);

// ============================================================
// 3. Header — glassmorphism
// ============================================================
css = css.replace(
  /\.header\s*\{[^}]*border-bottom:\s*1px solid var\(--border\);[^}]*\}/,
  `.header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px;
  background: rgba(9,4,13,0.72);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
  border-bottom: 1px solid rgba(255,10,45,0.12);
  box-shadow: 0 2px 16px rgba(0,0,0,0.4), 0 0 20px rgba(255,10,45,0.06);
}`
);

// Header logo — more vivid gradient
css = css.replace(
  /\.header\s+\.logo\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue\),\s*#8a001e\);[^}]*\}/,
  `.header .logo {
  width: 34px; height: 34px; border-radius: 9px;
  background: linear-gradient(135deg, #ff1a3a, #aa0020, #550010);
  display: flex; align-items: center; justify-content: center; font-weight: 800;
  box-shadow: 0 3px 14px rgba(255,10,45,0.55), 0 0 24px rgba(255,10,45,0.25), inset 0 1px 1px rgba(255,255,255,0.3);
}`
);

// Icon buttons — 3D tactile
css = css.replace(
  /\.icon-btn\s*\{[^}]*box-shadow:[^;]*;[^}]*transition:[^;]*;[^}]*\}/,
  `.icon-btn {
  width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(180deg, #12071a, #09040d);
  display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid rgba(255,10,45,0.15); color: var(--text);
  box-shadow: 0 4px 10px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.08), inset 0 -2px 4px rgba(0,0,0,0.4), 0 0 8px rgba(255,10,45,0.1);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

// ============================================================
// 4. Bottom nav — glassmorphism premium
// ============================================================
css = css.replace(
  /\.bottom-nav\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*border-radius:\s*24px;[^}]*box-shadow:[^;]*;[^}]*\}/,
  `.bottom-nav {
  position: fixed; bottom: 15px; left: 15px; right: 15px; margin: 0 auto; width: auto; max-width: 480px;
  background: rgba(9,4,13,0.78);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,10,45,0.18);
  border-radius: 24px;
  box-shadow: 0 -4px 24px rgba(0,0,0,0.5), 0 0 30px rgba(255,10,45,0.08), inset 0 1px 1px rgba(255,255,255,0.04);
  display: flex; justify-content: space-around; padding: 10px 0 14px;
  z-index: 2;
}`
);

// ============================================================
// 5. Modal sheet — red-tinted glass
// ============================================================
css = css.replace(
  /\.modal-overlay\s*\{[^}]*background:\s*rgba\(0,0,0,0\.6\);[^}]*\}/,
  `.modal-overlay { position: fixed; inset: 0; background: rgba(5,2,8,0.75); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: none; align-items: flex-end; justify-content: center; z-index: 50; }`
);

css = css.replace(
  /\.modal-sheet\s*\{[^}]*background:\s*var\(--card\);[^}]*border-radius:\s*20px 20px 0 0;[^}]*\}/,
  `.modal-sheet {
  background: linear-gradient(180deg, #110614 0%, #0a030e 100%);
  border: 1px solid rgba(255,10,45,0.15); border-bottom: none;
  width: 100%; max-width: 480px; border-radius: 20px 20px 0 0; padding: 20px; max-height: 80vh; overflow-y: auto;
  box-shadow: 0 -8px 32px rgba(0,0,0,0.6), 0 0 40px rgba(255,10,45,0.08);
}`
);

css = css.replace(
  /\.modal-handle\s*\{[^}]*background:\s*var\(--border\);[^}]*\}/,
  `.modal-handle { width: 36px; height: 4px; background: rgba(255,10,45,0.25); border-radius: 4px; margin: 0 auto 16px; }`
);

// ============================================================
// 6. Balance card — premium glass
// ============================================================
css = css.replace(
  /\.balance-card\s*\{[\s\S]*?background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.24\),\s*var\(--card2\)\s*55%\);[\s\S]*?border:\s*1px solid rgba\(255,20,55,0\.3\);[^}]*\}/,
  `.balance-card {
  background: linear-gradient(135deg, rgba(255,10,45,0.18), rgba(9,4,13,0.95) 55%, rgba(20,2,10,0.9));
  border: 1px solid rgba(255,10,45,0.35); border-radius: 16px; padding: 20px; position: relative; overflow: hidden;
  box-shadow: 0 0 24px rgba(255,10,45,0.12), 0 8px 24px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.06);
}`
);

// ============================================================
// 7. btn-primary — 3D tactile with border highlights
// ============================================================
css = css.replace(
  /\.btn-primary\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*60%,\s*#8a001e\);[^}]*\}/,
  `.btn-primary {
  flex: 1; padding: 14px; border-radius: 12px; border: none;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 50%, #8a0018);
  color: #fff;
  font-weight: 700; font-size: 14px; cursor: pointer;
  border-top: 1px solid rgba(255,255,255,0.2);
  border-bottom: 2px solid rgba(0,0,0,0.4);
  box-shadow: 0 8px 24px rgba(255,10,45,0.45), 0 0 16px rgba(255,10,45,0.2), inset 0 1px 1px rgba(255,255,255,0.3), inset 0 -3px 6px rgba(0,0,0,0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 8. btn-secondary — subtle glass
// ============================================================
css = css.replace(
  /\.btn-secondary\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,255,255,0\.04\),\s*transparent\);[^}]*\}/,
  `.btn-secondary {
  flex: 1; padding: 14px; border-radius: 12px; border: 1px solid rgba(255,10,45,0.18);
  background: linear-gradient(160deg, rgba(255,10,45,0.06), rgba(9,4,13,0.6));
  color: var(--text); font-weight: 600; font-size: 14px; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.35), inset 0 1px 1px rgba(255,255,255,0.05), 0 0 8px rgba(255,10,45,0.06);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

// ============================================================
// 9. Quick cards — richer glow
// ============================================================
css = css.replace(
  /\.quick-card\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.14\),\s*var\(--card2\)\s*65%\);[^}]*border:\s*1px solid rgba\(255,20,55,0\.2\);[^}]*\}/,
  `.quick-card {
  background: linear-gradient(160deg, rgba(255,10,45,0.12), rgba(9,4,13,0.9) 65%);
  border: 1px solid rgba(255,10,45,0.22); border-radius: 14px;
  padding: 14px; text-align: left; cursor: pointer; color: var(--text);
  box-shadow: 0 6px 20px rgba(0,0,0,0.4), 0 0 12px rgba(255,10,45,0.08), inset 0 1px 1px rgba(255,255,255,0.06);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  position: relative; overflow: hidden;
}`
);

// ============================================================
// 10. Stat boxes — deeper glow
// ============================================================
css = css.replace(
  /\.stat-box\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.16\),\s*var\(--card2\)\s*65%\);[^}]*border:\s*1px solid rgba\(255,20,55,0\.22\);[^}]*\}/,
  `.stat-box {
  background: linear-gradient(160deg, rgba(255,10,45,0.14), rgba(9,4,13,0.92) 65%);
  border: 1px solid rgba(255,10,45,0.24); border-radius: 12px; padding: 14px;
  position: relative; overflow: hidden;
  box-shadow: 0 6px 20px rgba(0,0,0,0.4), 0 0 10px rgba(255,10,45,0.1), inset 0 1px 1px rgba(255,255,255,0.06);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}`
);

// ============================================================
// 11. Join gate buttons — 3D glass
// ============================================================
css = css.replace(
  /\.join-btn\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*var\(--card2\),\s*var\(--card\)\);[^}]*\}/,
  `.join-btn {
  flex: 1; background: linear-gradient(160deg, rgba(12,5,18,0.9), rgba(9,4,13,0.95));
  border: 1px solid rgba(255,10,45,0.15); border-radius: 12px;
  padding: 18px 8px; text-align: center; color: var(--text); text-decoration: none; font-size: 13px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.45), 0 0 10px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.07);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

// Check button — richer
css = css.replace(
  /\.check-btn\s*\{[^}]*background:\s*linear-gradient\(90deg,\s*var\(--blue\),\s*#22c55e\);[^}]*\}/,
  `.check-btn {
  width: 100%; padding: 16px; border-radius: 14px; border: none; font-size: 15px; font-weight: 700;
  background: linear-gradient(90deg, #ff0a2d, #22c55e);
  color: #fff; cursor: pointer;
  border-top: 1px solid rgba(255,255,255,0.25);
  border-bottom: 2px solid rgba(0,0,0,0.35);
  box-shadow: 0 8px 24px rgba(255,10,45,0.4), 0 0 16px rgba(34,197,94,0.15), inset 0 1px 1px rgba(255,255,255,0.3), inset 0 -3px 6px rgba(0,0,0,0.2);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 12. Tab switch — premium active state
// ============================================================
css = css.replace(
  /\.tab-switch\s*\{[^}]*background:\s*var\(--card2\);[^}]*\}/,
  `.tab-switch { display: flex; background: rgba(9,4,13,0.8); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; padding: 4px; margin-bottom: 16px; }`
);

css = css.replace(
  /\.tab-switch button\.active\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\);[^}]*\}/,
  `.tab-switch button.active {
  background: linear-gradient(135deg, #ff3055, #ff0a2d);
  color: #fff;
  box-shadow: 0 4px 14px rgba(255,10,45,0.45), 0 0 10px rgba(255,10,45,0.2), inset 0 1px 1px rgba(255,255,255,0.25);
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 13. Ticker — premium dark
// ============================================================
css = css.replace(
  /\.ticker\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.ticker {
  margin-top: 14px; background: rgba(9,4,13,0.7); border: 1px solid rgba(255,10,45,0.12); border-radius: 12px;
  padding: 12px; font-size: 13px; color: var(--text-dim);
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 14. Promo box — deeper
// ============================================================
css = css.replace(
  /\.promo-box\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.22\),\s*rgba\(19,26,42,0\.9\)\s*65%\);[^}]*\}/,
  `.promo-box {
  background: linear-gradient(160deg, rgba(255,10,45,0.16), rgba(9,4,13,0.92) 65%);
  border: 1px solid rgba(255,10,45,0.3);
  border-radius: 14px;
  padding: 14px;
  margin-top: 14px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 8px rgba(255,10,45,0.06);
}`
);

// ============================================================
// 15. Circle icons — enhanced glow
// ============================================================
css = css.replace(
  /\.circle-icon\s*\{[^}]*background:\s*radial-gradient\(circle at 35% 30%,\s*rgba\(255,20,55,0\.35\),\s*var\(--card2\)\s*70%\);[^}]*border:\s*1px solid rgba\(255,20,55,0\.35\);[^}]*\}/,
  `.circle-icon {
  width: 52px; height: 52px; border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(255,10,45,0.4), rgba(9,4,13,0.9) 70%);
  border: 1px solid rgba(255,10,45,0.35);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
  box-shadow: 0 6px 18px rgba(255,10,45,0.35), 0 0 14px rgba(255,10,45,0.15), inset 0 1px 1px rgba(255,255,255,0.14), inset 0 -3px 6px rgba(0,0,0,0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

// ============================================================
// 16. Pill buttons — glass
// ============================================================
css = css.replace(
  /\.pill-btn-outline\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*var\(--card2\),\s*var\(--card\)\);[^}]*\}/,
  `.pill-btn-outline {
  flex: 1; padding: 12px; border-radius: 12px; border: 1px solid rgba(255,10,45,0.15);
  background: linear-gradient(160deg, rgba(12,5,18,0.85), rgba(9,4,13,0.95)); color: var(--text); font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,0.35), 0 0 6px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.06);
  transition: transform 0.15s ease;
}`
);

css = css.replace(
  /\.pill-btn\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*var\(--card2\),\s*var\(--card\)\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.pill-btn {
  background: linear-gradient(160deg, rgba(12,5,18,0.85), rgba(9,4,13,0.95)); border: 1px solid rgba(255,10,45,0.15); border-radius: 20px;
  padding: 6px 14px; font-size: 12px; color: var(--text); cursor: pointer;
  box-shadow: 0 3px 10px rgba(0,0,0,0.35), 0 0 6px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.05);
  transition: transform 0.15s ease;
}`
);

// ============================================================
// 17. Task card — premium dark
// ============================================================
css = css.replace(
  /\.task-card\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.task-card { background: rgba(9,4,13,0.85); border: 1px solid rgba(255,10,45,0.12); border-radius: 14px; padding: 16px; margin-bottom: 12px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3), 0 0 6px rgba(255,10,45,0.04);
}`
);

// ============================================================
// 18. Refer hero — enhanced
// ============================================================
css = css.replace(
  /\.refer-hero\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.26\),\s*var\(--card2\)\s*60%\);[^}]*\}/,
  `.refer-hero {
  background: linear-gradient(160deg, rgba(255,10,45,0.22), rgba(9,4,13,0.92) 60%);
  border: 1px solid rgba(255,10,45,0.35); border-radius: 18px; padding: 26px 22px;
  text-align: center; position: relative; overflow: hidden;
  box-shadow: 0 10px 32px rgba(255,10,45,0.2), 0 0 24px rgba(255,10,45,0.08), inset 0 1px 1px rgba(255,255,255,0.08);
}`
);

// ============================================================
// 19. Ref list — dark glass
// ============================================================
css = css.replace(
  /\.ref-list\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.ref-list { margin-top: 10px; background: rgba(9,4,13,0.8); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; overflow: hidden;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 20. Method tabs — premium active
// ============================================================
css = css.replace(
  /\.method-tab\s*\{[^}]*background:\s*var\(--card2\);[^}]*\}/,
  `.method-tab {
  flex: 1; padding: 12px; border-radius: 12px; border: 1px solid rgba(255,10,45,0.1); background: rgba(9,4,13,0.7);
  text-align: center; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

css = css.replace(
  /\.method-tab\.active\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\);[^}]*\}/,
  `.method-tab.active {
  background: linear-gradient(135deg, #ff3055, #ff0a2d); border-color: #ff0a2d;
  box-shadow: 0 6px 18px rgba(255,10,45,0.45), 0 0 12px rgba(255,10,45,0.2), inset 0 1px 1px rgba(255,255,255,0.25);
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 21. Field input — dark glass
// ============================================================
css = css.replace(
  /\.field-input\s*\{[^}]*background:\s*var\(--bg\);[^}]*\}/,
  `.field-input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid rgba(255,10,45,0.12); background: rgba(5,2,8,0.8); color: var(--text); font-size: 14px;
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 22. Spin wheel — enhanced glow
// ============================================================
css = css.replace(
  /\.spin-balance-box\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.24\),\s*var\(--card2\)\s*65%\);[^}]*\}/,
  `.spin-balance-box {
  flex: 1;
  background: linear-gradient(160deg, rgba(255,10,45,0.2), rgba(9,4,13,0.92) 65%);
  border: 1px solid rgba(255,10,45,0.35);
  border-radius: 14px;
  padding: 16px 14px;
  text-align: center;
  position: relative;
  overflow: hidden;
  box-shadow: 0 6px 20px rgba(255,10,45,0.22), 0 0 12px rgba(255,10,45,0.1), inset 0 1px 1px rgba(255,255,255,0.08);
}`
);

// Spin button — 3D
css = css.replace(
  /\.spin-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*60%,\s*#8a001e\);[^}]*\}/,
  `.spin-btn {
  margin-top: 6px;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.3px;
  border-radius: 30px;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 60%, #8a0018);
  border-top: 1px solid rgba(255,255,255,0.2);
  border-bottom: 2px solid rgba(0,0,0,0.4);
  box-shadow:
    0 8px 28px rgba(255,10,45,0.5),
    0 0 18px rgba(255,10,45,0.2),
    inset 0 1px 1px rgba(255,255,255,0.3),
    inset 0 -3px 6px rgba(0,0,0,0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 23. Special task cards — deeper
// ============================================================
css = css.replace(
  /\.special-task-card\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.14\),\s*var\(--card2\)\s*65%\);[^}]*\}/,
  `.special-task-card {
  background: linear-gradient(135deg, rgba(255,10,45,0.12), rgba(9,4,13,0.92) 65%);
  border: 1px solid rgba(255,10,45,0.24); border-radius: 14px;
  padding: 14px; margin-bottom: 12px; position: relative; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 8px rgba(255,10,45,0.06);
}`
);

// Special start button — 3D
css = css.replace(
  /\.special-start-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*60%,\s*#8a001e\);[^}]*\}/,
  `.special-start-btn {
  padding: 10px 26px; border-radius: 9px; border: none;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 60%, #8a0018);
  color: #fff; font-weight: 600; font-size: 13.5px; cursor: pointer;
  border-top: 1px solid rgba(255,255,255,0.2);
  border-bottom: 2px solid rgba(0,0,0,0.35);
  box-shadow: 0 6px 18px rgba(255,10,45,0.45), 0 0 10px rgba(255,10,45,0.15), inset 0 1px 1px rgba(255,255,255,0.3), inset 0 -2px 4px rgba(0,0,0,0.2);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 24. Ad loading overlay — deeper
// ============================================================
css = css.replace(
  /\.ad-loading-overlay\s*\{[^}]*background:\s*rgba\(10,14,23,0\.92\);[^}]*\}/,
  `.ad-loading-overlay {
  position: fixed; inset: 0; background: rgba(5,2,8,0.94); z-index: 100;
  display: none; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}`
);

// ============================================================
// 25. Congrats overlay — deeper
// ============================================================
css = css.replace(
  /\.congrats-overlay\s*\{[^}]*background:\s*rgba\(10,14,23,0\.92\);[^}]*\}/,
  `.congrats-overlay {
  position: fixed; inset: 0; background: rgba(5,2,8,0.94); z-index: 101;
  display: none; align-items: center; justify-content: center;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}`
);

// ============================================================
// 26. Withdraw status box — deeper
// ============================================================
css = css.replace(
  /\.withdraw-status-box\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.14\),\s*var\(--card2\)\s*65%\);[^}]*\}/,
  `.withdraw-status-box {
  background: linear-gradient(135deg, rgba(255,10,45,0.12), rgba(9,4,13,0.9) 65%);
  border: 1px solid rgba(255,10,45,0.24); border-radius: 12px;
  padding: 12px 14px; margin: 12px 0;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3), 0 0 6px rgba(255,10,45,0.06);
}`
);

// ============================================================
// 27. Balance card v2 — enhanced
// ============================================================
css = css.replace(
  /\.balance-card-v2\s*\{[\s\S]*?background:\s*linear-gradient\(150deg,\s*rgba\(46,4,10,0\.75\),\s*rgba\(10,14,23,0\.92\)\s*55%,\s*rgba\(30,3,8,0\.85\)\);[^}]*\}/,
  `.balance-card-v2 {
  background: linear-gradient(150deg, rgba(40,2,12,0.85), rgba(5,2,8,0.95) 55%, rgba(25,1,8,0.9));
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255,10,45,0.45); border-radius: 16px; padding: 18px;
  position: relative; overflow: hidden;
  box-shadow:
    0 0 0 1px rgba(255,10,45,0.15),
    0 0 24px rgba(255,10,45,0.18),
    0 0 48px rgba(255,10,45,0.06),
    0 10px 30px rgba(0,0,0,0.55),
    inset 0 1px 1px rgba(255,255,255,0.06);
}`
);

// ============================================================
// 28. bc-action-btn — premium 3D
// ============================================================
css = css.replace(
  /\.bc-action-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*60%,\s*#8a001e\);[^}]*\}/,
  `.bc-action-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 60%, #8a0018);
  border: 1px solid rgba(255,50,85,0.5);
  border-top: 1px solid rgba(255,255,255,0.15);
  border-bottom: 2px solid rgba(0,0,0,0.35);
  border-radius: 12px; padding: 12px 4px; color: #fff; font-size: 12.5px; font-weight: 700;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(255,10,45,0.45), 0 0 16px rgba(255,10,45,0.15), inset 0 1px 1px rgba(255,255,255,0.25), inset 0 -3px 6px rgba(0,0,0,0.3);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 29. Home withdraw btn — enhanced
// ============================================================
css = css.replace(
  /\.home-withdraw-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.22\),\s*rgba\(10,14,23,0\.55\)\);[^}]*\}/,
  `.home-withdraw-btn {
  background: linear-gradient(135deg, rgba(255,10,45,0.25), rgba(9,4,13,0.65));
  border: 1px solid rgba(255,10,45,0.45);
  box-shadow: 0 6px 24px rgba(255,10,45,0.4), 0 0 18px rgba(255,10,45,0.12), inset 0 1px 1px rgba(255,255,255,0.15);
  font-family: 'Orbitron', 'Poppins', -apple-system, "Segoe UI", Roboto, sans-serif;
  font-weight: 800;
  font-size: 15px;
  letter-spacing: 0.3px;
  border-radius: 16px;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 30. Icon square btn — glass
// ============================================================
css = css.replace(
  /\.icon-square-btn\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*var\(--card2\),\s*var\(--card\)\);[^}]*\}/,
  `.icon-square-btn {
  width: 52px; flex-shrink: 0; border-radius: 30px; border: 1px solid rgba(255,10,45,0.15);
  background: linear-gradient(160deg, rgba(12,5,18,0.9), rgba(9,4,13,0.95)); color: var(--text); font-size: 20px; cursor: pointer;
  box-shadow: 0 6px 18px rgba(0,0,0,0.4), 0 0 8px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.07), inset 0 -2px 4px rgba(0,0,0,0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}`
);

// ============================================================
// 31. Post task card — deeper
// ============================================================
css = css.replace(
  /\.post-task-card\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*var\(--card2\),\s*var\(--card\)\);[^}]*\}/,
  `.post-task-card {
  text-align: center; padding: 32px 20px; border-radius: 18px;
  background: linear-gradient(160deg, rgba(12,5,18,0.9), rgba(9,4,13,0.95));
  border: 1px solid rgba(255,10,45,0.12);
  box-shadow: 0 6px 20px rgba(0,0,0,0.4), 0 0 8px rgba(255,10,45,0.04), inset 0 1px 1px rgba(255,255,255,0.06);
}`
);

// ============================================================
// 32. Post task type/tier buttons — deeper active state
// ============================================================
css = css.replace(
  /\.post-task-type-btn\s*\{[^}]*background:\s*var\(--card2\);[^}]*\}/,
  `.post-task-type-btn {
  padding: 16px 10px; border-radius: 12px; border: 1px solid rgba(255,10,45,0.1);
  background: rgba(9,4,13,0.8); color: var(--text); font-size: 13px; line-height: 1.6; text-align: center;
}`
);

css = css.replace(
  /\.post-task-tier-btn\s*\{[^}]*background:\s*var\(--card2\);[^}]*\}/,
  `.post-task-tier-btn {
  padding: 14px 8px; border-radius: 12px; border: 1px solid rgba(255,10,45,0.1);
  background: rgba(9,4,13,0.8); color: var(--text); text-align: center;
}`
);

// ============================================================
// 33. Weekly contest progress — deeper
// ============================================================
css = css.replace(
  /\.wc-progress-box\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.16\),\s*var\(--card2\)\s*70%\);[^}]*\}/,
  `.wc-progress-box {
  background: linear-gradient(135deg, rgba(255,10,45,0.14), rgba(9,4,13,0.92) 70%);
  border: 1px solid rgba(255,10,45,0.28); border-radius: 14px; padding: 16px;
  box-shadow: 0 6px 20px rgba(255,10,45,0.12), 0 0 10px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.06);
}`
);

// ============================================================
// 34. Balance column boxes — deeper
// ============================================================
css = css.replace(
  /\.balance-col\s*\{[^}]*background:\s*rgba\(10,14,23,0\.4\);[^}]*\}/,
  `.balance-col {
  flex: 1; background: rgba(5,2,8,0.55); border: 1px solid rgba(255,10,45,0.2); border-radius: 12px; padding: 12px;
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 35. Link box (refer) — deeper
// ============================================================
css = css.replace(
  /\.link-box\s*\{[^}]*background:\s*rgba\(10,14,23,0\.55\);[^}]*\}/,
  `.link-box {
  background: rgba(5,2,8,0.65); border: 1px solid rgba(255,10,45,0.2); border-radius: 12px;
  padding: 12px; font-size: 12px; word-break: break-all; color: var(--text-dim); margin-bottom: 16px;
  box-shadow: inset 0 2px 8px rgba(0,0,0,0.4), 0 0 6px rgba(255,10,45,0.04);
}`
);

// ============================================================
// 36. Reward step — glass
// ============================================================
css = css.replace(
  /\.reward-step\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.reward-step { display: flex; align-items: center; gap: 12px; background: rgba(9,4,13,0.8); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; padding: 14px; margin-bottom: 10px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}`
);

// ============================================================
// 37. Congrats icon — glow
// ============================================================
css = css.replace(
  /\.congrats-icon\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*2px solid var\(--blue\);[^}]*\}/,
  `.congrats-icon {
  width: 90px; height: 90px; border-radius: 50%; background: rgba(9,4,13,0.85); border: 2px solid #ff0a2d;
  display: flex; align-items: center; justify-content: center; font-size: 36px; margin: 0 auto 18px;
  box-shadow: 0 0 24px rgba(255,10,45,0.4), 0 0 48px rgba(255,10,45,0.15);
}`
);

// ============================================================
// 38. Leaderboard list/modal — deeper
// ============================================================
css = css.replace(
  /\.lb-list\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.lb-list { background: rgba(9,4,13,0.8); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; overflow: hidden;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 39. Weekly contest list — deeper
// ============================================================
css = css.replace(
  /\.wc-list\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.wc-list { background: rgba(9,4,13,0.8); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; overflow: hidden;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 40. Nav center button — enhanced glow
// ============================================================
css = css.replace(
  /\.nav-item\.center\s+\.nav-icon\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue\),\s*#8a001e\);[^}]*\}/,
  `.nav-item.center .nav-icon {
  position: relative;
  width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #ff0a2d, #8a0018);
  display: flex; align-items: center; justify-content: center; font-size: 20px; margin-top: -22px;
  box-shadow: 0 0 24px rgba(255,10,45,0.55), 0 0 48px rgba(255,10,45,0.25), 0 0 8px rgba(255,10,45,0.4), inset 0 1px 1px rgba(255,255,255,0.25), inset 0 -3px 6px rgba(0,0,0,0.3);
  transition: transform 0.15s ease;
}`
);

// ============================================================
// 41. Refer hero icon — enhanced
// ============================================================
css = css.replace(
  /\.refer-hero\s+\.icon\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*60%,\s*#8a001e\);[^}]*\}/,
  `.refer-hero .icon {
  width: 72px; height: 72px; margin: 0 auto 14px;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px; border-radius: 50%;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 60%, #8a0018);
  box-shadow:
    0 0 30px rgba(255,10,45,0.65),
    0 0 0 5px rgba(255,10,45,0.15),
    0 0 60px rgba(255,10,45,0.2),
    inset 0 2px 4px rgba(255,255,255,0.35),
    inset 0 -4px 8px rgba(0,0,0,0.3);
  animation: refer-icon-pulse 2.4s ease-in-out infinite;
}`
);

// ============================================================
// 42. Special reward box — deeper
// ============================================================
css = css.replace(
  /\.special-reward-box\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.2\),\s*rgba\(10,14,23,0\.55\)\);[^}]*\}/,
  `.special-reward-box {
  background: linear-gradient(135deg, rgba(255,10,45,0.18), rgba(5,2,8,0.65));
  border: 1px solid rgba(255,10,45,0.3);
  border-radius: 10px;
  padding: 8px 14px;
  text-align: center;
  flex-shrink: 0;
  min-width: 58px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3), 0 0 8px rgba(255,10,45,0.08);
}`
);

// ============================================================
// 43. Convert note — deeper
// ============================================================
css = css.replace(
  /\.convert-note\s*\{[^}]*background:\s*rgba\(255,20,55,0\.08\);[^}]*\}/,
  `.convert-note {
  font-size: 12px; color: var(--blue-light); display: flex; gap: 6px; align-items: flex-start;
  margin-bottom: 14px; background: rgba(255,10,45,0.06); padding: 10px 12px; border-radius: 10px;
  border: 1px solid rgba(255,10,45,0.12);
}`
);

// ============================================================
// 44. Balance display box — deeper
// ============================================================
css = css.replace(
  /\.balance-display-box\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.18\),\s*var\(--card2\)\s*70%\);[^}]*\}/,
  `.balance-display-box {
  background: linear-gradient(135deg, rgba(255,10,45,0.15), rgba(9,4,13,0.92) 70%);
  border: 1px solid rgba(255,10,45,0.3); border-radius: 12px; padding: 14px;
  text-align: center; margin-bottom: 14px; position: relative; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 8px rgba(255,10,45,0.06);
}`
);

// ============================================================
// 45. Convert breakdown — deeper
// ============================================================
css = css.replace(
  /\.convert-breakdown\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.convert-breakdown {
  background: rgba(9,4,13,0.75); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; padding: 14px; margin: 14px 0;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25);
}`
);

// ============================================================
// 46. Max btn — deeper
// ============================================================
css = css.replace(
  /\.max-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.22\),\s*rgba\(10,14,23,0\.55\)\);[^}]*\}/,
  `.max-btn {
  flex-shrink: 0; padding: 0 18px; border-radius: 10px; border: 1px solid rgba(255,10,45,0.35);
  background: linear-gradient(135deg, rgba(255,10,45,0.2), rgba(5,2,8,0.6));
  color: var(--blue-light); font-weight: 700; font-size: 12.5px; cursor: pointer; letter-spacing: 0.3px;
  box-shadow: 0 4px 14px rgba(255,10,45,0.2), 0 0 8px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.06);
  transition: transform 0.15s ease;
}`
);

// ============================================================
// 47. Hint box — deeper
// ============================================================
css = css.replace(
  /\.hint-box\s*\{[^}]*background:\s*rgba\(255,20,55,0\.1\);[^}]*\}/,
  `.hint-box { background: rgba(255,10,45,0.08); border: 1px solid rgba(255,10,45,0.15); border-radius: 10px; padding: 12px; font-size: 12px; color: var(--blue-light); margin: 12px 0; }`
);

// ============================================================
// 48. Spin wheel center — premium
// ============================================================
css = css.replace(
  /\.spin-wheel-center\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*var\(--blue-light\),\s*var\(--blue\)\s*55%,\s*#8a001e\);[^}]*\}/,
  `.spin-wheel-center {
  position: absolute;
  width: 66px; height: 66px; border-radius: 50%;
  background: linear-gradient(135deg, #ff3055, #ff0a2d 55%, #8a0018);
  display: flex; align-items: center; justify-content: center;
  font-size: 28px;
  box-shadow:
    0 0 28px rgba(255,10,45,0.7),
    0 0 56px rgba(255,10,45,0.25),
    0 0 0 4px rgba(9,4,13,0.9),
    0 0 0 6px rgba(255,10,45,0.45),
    inset 0 2px 4px rgba(255,255,255,0.35),
    inset 0 -4px 8px rgba(0,0,0,0.35);
  z-index: 3;
  animation: spin-center-pulse 2.2s ease-in-out infinite;
}`
);

// ============================================================
// 49. Commission box — deeper
// ============================================================
css = css.replace(
  /\.commission-box\s*\{[^}]*background:\s*linear-gradient\(160deg,\s*rgba\(255,20,55,0\.14\),\s*var\(--card2\)\s*65%\);[^}]*\}/,
  `.commission-box {
  background: linear-gradient(160deg, rgba(255,10,45,0.12), rgba(9,4,13,0.92) 65%);
  border: 1px solid rgba(255,10,45,0.25);
  border-radius: 14px; padding: 16px; margin-top: 12px;
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.35), 0 0 8px rgba(255,10,45,0.06), inset 0 1px 1px rgba(255,255,255,0.05);
}`
);

// ============================================================
// 50. Home converter btn — deeper
// ============================================================
css = css.replace(
  /\.home-converter-btn\s*\{[^}]*background:\s*linear-gradient\(135deg,\s*rgba\(255,20,55,0\.22\),\s*rgba\(10,14,23,0\.55\)\);[^}]*\}/,
  `.home-converter-btn {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, rgba(255,10,45,0.2), rgba(5,2,8,0.65));
  border: 1px solid rgba(255,10,45,0.35);
  box-shadow: 0 4px 18px rgba(255,10,45,0.25), 0 0 10px rgba(255,10,45,0.08), inset 0 1px 1px rgba(255,255,255,0.06);
  font-size: 20px;
}`
);

// ============================================================
// 51. Video card — deeper
// ============================================================
css = css.replace(
  /\.video-card\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.video-card {
  border-radius: 10px; overflow: hidden; background: rgba(9,4,13,0.85); border: 1px solid rgba(255,10,45,0.1);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  box-shadow: 0 4px 14px rgba(0,0,0,0.3);
}`
);

// ============================================================
// 52. Rocket ring — glow
// ============================================================
css = css.replace(
  /\.rocket-ring\s*\{[^}]*border:\s*3px solid var\(--blue\);[^}]*\}/,
  `.rocket-ring {
  width: 100px; height: 100px; border-radius: 50%; border: 3px solid #ff0a2d;
  display: flex; align-items: center; justify-content: center; font-size: 40px;
  box-shadow: 0 0 20px rgba(255,10,45,0.35), 0 0 40px rgba(255,10,45,0.12);
}`
);

// ============================================================
// 53. Key buy rows — deeper
// ============================================================
css = css.replace(
  /\.key-buy-rows\s*\{[^}]*background:\s*var\(--card2\);[^}]*border:\s*1px solid var\(--border\);[^}]*\}/,
  `.key-buy-rows { text-align: left; background: rgba(9,4,13,0.75); border: 1px solid rgba(255,10,45,0.1); border-radius: 12px; overflow: hidden; margin-bottom: 16px;
  box-shadow: inset 0 2px 6px rgba(0,0,0,0.3);
}`
);

// ============================================================
// DONE — Write the file
// ============================================================
fs.writeFileSync(destPath, css, 'utf8');
console.log('Premium red theme applied successfully!');
console.log('File size:', css.length, 'bytes');
console.log('Output:', destPath);
