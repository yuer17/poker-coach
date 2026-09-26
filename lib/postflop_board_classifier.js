// 翻后公牌几何特征向量化分类器 (Phase 3 - Module 1)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 目标：将 1,755 种 Flop 牌面降维映射为 4 维标准向量 [HighCard, Connectedness, Suitedness, Pairedness]

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
};

/**
 * 分类公牌面特征
 * @param {Array<string>} boardCards - 公共牌数组，如 ['5d', '5h', '3c'] 或 ['As', 'Kh', '7d']
 * @returns {Object} 4维结构向量与特征摘要
 */
export function classifyBoardTexture(boardCards) {
  if (!boardCards || boardCards.length < 3) {
    return {
      highCard: 'UNKNOWN',
      connectedness: 'UNKNOWN',
      suitedness: 'UNKNOWN',
      pairedness: 'UNKNOWN',
      clusterKey: 'UNKNOWN'
    };
  }

  // 1. 提取 Rank 点数与 Suit 花色
  const ranks = [];
  const suits = {};
  const rankCounts = {};

  for (const c of boardCards) {
    if (!c) continue;
    const rChar = c[0];
    const sChar = c[1] || 's';
    const rVal = RANK_VALUES[rChar] || 0;
    ranks.push(rVal);
    suits[sChar] = (suits[sChar] || 0) + 1;
    rankCounts[rVal] = (rankCounts[rVal] || 0) + 1;
  }

  ranks.sort((a, b) => b - a); // 降序

  // 2. HighCard 顶牌高度判定
  const maxRank = ranks[0];
  let highCard = 'LOW';
  if (maxRank === 14) highCard = 'A_HIGH';
  else if (maxRank >= 12) highCard = 'BROADWAY_HIGH'; // K or Q
  else if (maxRank >= 10) highCard = 'MID_HIGH';      // J or T
  else highCard = 'LOW';                              // 9 or below

  // 3. Pairedness 成对度判定
  const maxRankFreq = Math.max(...Object.values(rankCounts));
  let pairedness = 'UNPAIRED';
  if (maxRankFreq >= 3) pairedness = 'TRIPPED';
  else if (maxRankFreq === 2) pairedness = 'PAIRED';
  else pairedness = 'UNPAIRED';

  // 4. Suitedness 花色聚焦度判定
  const maxSuitFreq = Math.max(...Object.values(suits));
  let suitedness = 'RAINBOW';
  if (maxSuitFreq >= 3) suitedness = 'MONOTONE';
  else if (maxSuitFreq === 2) suitedness = 'TWO_TONE';
  else suitedness = 'RAINBOW';

  // 5. Connectedness 顺子连张度判定
  const uniqueRanks = [...new Set(ranks)];
  let connectedness = 'DISCONNECTED';
  if (uniqueRanks.length >= 3) {
    const span = uniqueRanks[0] - uniqueRanks[uniqueRanks.length - 1];
    // 检查是否有 A 作为 low card (A-2-3-4-5) 的 wheel 潜力
    const hasWheel = uniqueRanks.includes(14) && uniqueRanks.some(r => r <= 5);
    
    if (span <= 3 || (span === 4 && uniqueRanks.length === 3)) {
      connectedness = 'CONNECTED'; // 如 9-8-7 (span 2), 9-8-6 (span 3), 9-7-5 (span 4)
    } else if (span <= 5 || hasWheel) {
      connectedness = 'SEMI_CONNECTED'; // 如 J-9-7 (span 4), T-8-5 (span 5)
    } else {
      connectedness = 'DISCONNECTED';
    }
  } else {
    // 对子面 (如 5-5-3)
    connectedness = 'DISCONNECTED';
  }

  // 6. 构造标准聚类键 (Cluster Key)
  const clusterKey = `${highCard}_${connectedness}_${suitedness}_${pairedness}`;

  return {
    highCard,
    connectedness,
    suitedness,
    pairedness,
    isDry: suitedness === 'RAINBOW' && (connectedness === 'DISCONNECTED' || pairedness === 'PAIRED'),
    isWet: suitedness === 'MONOTONE' || connectedness === 'CONNECTED',
    clusterKey
  };
}
