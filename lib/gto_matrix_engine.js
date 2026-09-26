// 翻前极化静态 GTO 矩阵运行时查询引擎 (Phase 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 性能目标：内存占用 < 2MB, 单次查询时延 < 0.05ms, 支持非均匀深度线性插值

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let _matrixData = null;

export function loadGtoMatrix(customPath) {
  if (_matrixData) return _matrixData;
  let p = customPath;
  if (!p) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    p = join(__dirname, 'preflop_gto_matrix.json');
  }
  if (existsSync(p)) {
    _matrixData = JSON.parse(readFileSync(p, 'utf8'));
  }
  return _matrixData;
}

/**
 * 线性插值混合两个四元动作向量
 * vector: [Fold, Call, Raise, Jam]
 */
function interpolateFrequencies(vLo, vHi, weight) {
  // weight: 0.0 (靠近 lo) ~ 1.0 (靠近 hi)
  const f = vLo[0] * (1 - weight) + vHi[0] * weight;
  const c = vLo[1] * (1 - weight) + vHi[1] * weight;
  const r = vLo[2] * (1 - weight) + vHi[2] * weight;
  const j = vLo[3] * (1 - weight) + vHi[3] * weight;

  const fN = Math.round(f);
  const cN = Math.round(c);
  const rN = Math.round(r);
  const jN = 100 - fN - cN - rN;
  return [fN, cN, rN, jN];
}

/**
 * 核心查表 API
 * @param {string} heroPos - 玩家位置 (UTG, MP, LJ, HJ, CO, BTN, SB, BB)
 * @param {string} vsPos - 对手位置或动作 (UTG, MP, RFI, vs_UTG_RFI 等)
 * @param {number} effStack - 有效筹码深度 (BB)
 * @param {string} hand - 169 手牌之一 (如 'AA', 'AJo', 'QTs', '72o')
 * @param {string} actionSeq - 行动类型 (RFI, vs_RFI, SQUEEZE)
 * @returns {Array<number>} [Fold%, Call%, Raise%, Jam%]
 */
export function queryGtoPreflop(heroPos, vsPos, effStack, hand, actionSeq = 'vs_RFI') {
  const matrix = loadGtoMatrix();
  if (!matrix || !matrix.nodes) {
    return [100, 0, 0, 0]; // 降级兜底
  }

  // 1. 构建场景键前缀
  let seqKey = actionSeq;
  if (actionSeq === 'vs_RFI') {
    seqKey = `vs_${vsPos}_RFI`;
  }

  const depths = matrix.depths || [10, 15, 20, 25, 30, 40, 60];

  // 2. 定位相邻深度锚点
  let loDepth = depths[0], hiDepth = depths[depths.length - 1];
  for (let i = 0; i < depths.length; i++) {
    if (depths[i] <= effStack) loDepth = depths[i];
    if (depths[i] >= effStack) { hiDepth = depths[i]; break; }
  }

  const keyLo = `${loDepth}_${heroPos}_${seqKey}`;
  const keyHi = `${hiDepth}_${heroPos}_${seqKey}`;

  const nodeLo = matrix.nodes[keyLo] || {};
  const nodeHi = matrix.nodes[keyHi] || {};

  // 缺省即为 [100, 0, 0, 0] (100% Fold)
  const vecLo = nodeLo[hand] || [100, 0, 0, 0];
  const vecHi = nodeHi[hand] || [100, 0, 0, 0];

  if (loDepth === hiDepth) {
    return vecLo;
  }

  // 3. 执行平滑线性插值
  const weight = (effStack - loDepth) / (hiDepth - loDepth);
  return interpolateFrequencies(vecLo, vecHi, weight);
}
