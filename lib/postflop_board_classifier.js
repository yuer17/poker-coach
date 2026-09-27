// 翻后公牌几何特征向量化与 28 牌面簇分类器 (Phase 4 - Module 1)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-036 架构裁决：28 解释性翻牌种子簇分类器与组合快速寻址映射

(function(global) {
  const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
  };

  const SUIT_ORDER = { 'c': 0, 'd': 1, 'h': 2, 's': 3, 'C': 0, 'D': 1, 'H': 2, 'S': 3 };

  /**
   * 28 个解释性种子簇定义 (Astra 规范)
   */
  const POSTFLOP_CLUSTERS_28 = [
    // 0-15: 非配对、非单色 (4 HighCard x 2 Conn x 2 Suit)
    { id: 0, key: 'A_HIGH_DISCONNECTED_RAINBOW_UNPAIRED', name: 'A高-彩虹-疏离干燥面' },
    { id: 1, key: 'A_HIGH_DISCONNECTED_TWO_TONE_UNPAIRED', name: 'A高-双色-疏离面' },
    { id: 2, key: 'A_HIGH_CONNECTED_RAINBOW_UNPAIRED', name: 'A高-彩虹-动态连张面' },
    { id: 3, key: 'A_HIGH_CONNECTED_TWO_TONE_UNPAIRED', name: 'A高-双色-动态连张面' },
    { id: 4, key: 'KQ_HIGH_DISCONNECTED_RAINBOW_UNPAIRED', name: 'KQ高-彩虹-疏离干燥面' },
    { id: 5, key: 'KQ_HIGH_DISCONNECTED_TWO_TONE_UNPAIRED', name: 'KQ高-双色-疏离面' },
    { id: 6, key: 'KQ_HIGH_CONNECTED_RAINBOW_UNPAIRED', name: 'KQ高-彩虹-动态连张面' },
    { id: 7, key: 'KQ_HIGH_CONNECTED_TWO_TONE_UNPAIRED', name: 'KQ高-双色-动态连张面' },
    { id: 8, key: 'JT_HIGH_DISCONNECTED_RAINBOW_UNPAIRED', name: 'JT高-彩虹-疏离面' },
    { id: 9, key: 'JT_HIGH_DISCONNECTED_TWO_TONE_UNPAIRED', name: 'JT高-双色-疏离面' },
    { id: 10, key: 'JT_HIGH_CONNECTED_RAINBOW_UNPAIRED', name: 'JT高-彩虹-动态连张面' },
    { id: 11, key: 'JT_HIGH_CONNECTED_TWO_TONE_UNPAIRED', name: 'JT高-双色-动态连张面' },
    { id: 12, key: 'LOW_DISCONNECTED_RAINBOW_UNPAIRED', name: '低牌-彩虹-疏离干燥面' },
    { id: 13, key: 'LOW_DISCONNECTED_TWO_TONE_UNPAIRED', name: '低牌-双色-疏离面' },
    { id: 14, key: 'LOW_CONNECTED_RAINBOW_UNPAIRED', name: '低牌-彩虹-动态连张面' },
    { id: 15, key: 'LOW_CONNECTED_TWO_TONE_UNPAIRED', name: '低牌-双色-动态连张面' },

    // 16-21: 一对牌面 (3 PairRank x 2 Suit)
    { id: 16, key: 'HIGH_PAIR_RAINBOW_PAIRED', name: '高对子-彩虹成对面 (TT+)' },
    { id: 17, key: 'HIGH_PAIR_TWO_TONE_PAIRED', name: '高对子-双色成对面 (TT+)' },
    { id: 18, key: 'MID_PAIR_RAINBOW_PAIRED', name: '中对子-彩虹成对面 (66-99)' },
    { id: 19, key: 'MID_PAIR_TWO_TONE_PAIRED', name: '中对子-双色成对面 (66-99)' },
    { id: 20, key: 'LOW_PAIR_RAINBOW_PAIRED', name: '低对子-彩虹成对面 (22-55)' },
    { id: 21, key: 'LOW_PAIR_TWO_TONE_PAIRED', name: '低对子-双色成对面 (22-55)' },

    // 22-25: 单色牌面 (2 HighCard x 2 Conn)
    { id: 22, key: 'HIGH_MONOTONE_LOW_CONN', name: '高牌-单色非连张同花面' },
    { id: 23, key: 'HIGH_MONOTONE_HIGH_CONN', name: '高牌-单色动态连张同花面' },
    { id: 24, key: 'LOW_MONOTONE_LOW_CONN', name: '低牌-单色非连张同花面' },
    { id: 25, key: 'LOW_MONOTONE_HIGH_CONN', name: '低牌-单色动态连张同花面' },

    // 26-27: 三条牌面 (2 Rank)
    { id: 26, key: 'HIGH_TRIPS', name: '高三条公牌面 (888+)' },
    { id: 27, key: 'LOW_TRIPS', name: '低三条公牌面 (222-777)' }
  ];

  /**
   * 将单张牌字符串映射为 0..51 数字编号
   * @param {string} cardStr - 如 'As', '5d', 'Th'
   * @returns {number} 0..51 编号，无效则返回 -1
   */
  function cardStringToIndex(cardStr) {
    if (!cardStr || cardStr.length < 2) return -1;
    const r = RANK_VALUES[cardStr[0]];
    const s = SUIT_ORDER[cardStr[1]];
    if (r === undefined || s === undefined) return -1;
    return (r - 2) * 4 + s;
  }

  /**
   * 三张卡牌编号映射为 C(52,3)=22,100 的 Colex 组合索引
   * @param {number} c0 - 卡牌编号 1
   * @param {number} c1 - 卡牌编号 2
   * @param {number} c2 - 卡牌编号 3
   * @returns {number} 0..22099
   */
  function getFlopIndex(c0, c1, c2) {
    const sorted = [c0, c1, c2].sort((a, b) => a - b);
    const a = sorted[0], b = sorted[1], c = sorted[2];
    return a + (b * (b - 1)) / 2 + (c * (c - 1) * (c - 2)) / 6;
  }

  function isValidCard(c) {
    return typeof c === 'string' && c.length >= 2;
  }

  /**
   * 翻牌 28 牌面簇分类核心算法
   * @param {Array<string>} boardCards - 3 张公牌，如 ['5d', '5h', '3c']
   * @returns {Object} 完整分类信息与 28 簇 ID
   */
  function classifyFlopToCluster(boardCards) {
    if (!Array.isArray(boardCards) || boardCards.length < 3 || boardCards.slice(0, 3).some(c => !isValidCard(c))) {
      return {
        clusterId: 0,
        clusterKey: 'UNKNOWN',
        clusterName: '未知牌面',
        highCard: 'UNKNOWN',
        connectedness: 'UNKNOWN',
        suitedness: 'UNKNOWN',
        pairedness: 'UNKNOWN',
        isDry: false,
        isWet: false
      };
    }

    const ranks = [];
    const suits = {};
    const rankCounts = {};

    for (const c of boardCards) {
      if (!c) continue;
      const rVal = RANK_VALUES[c[0]] || 0;
      const sChar = (c[1] || 's').toLowerCase();
      ranks.push(rVal);
      suits[sChar] = (suits[sChar] || 0) + 1;
      rankCounts[rVal] = (rankCounts[rVal] || 0) + 1;
    }

    ranks.sort((a, b) => b - a); // 降序

    const maxRankFreq = Math.max(...Object.values(rankCounts));
    const maxSuitFreq = Math.max(...Object.values(suits));
    const maxRank = ranks[0];

    let clusterId = 0;
    let highCard = 'LOW';
    let pairedness = 'UNPAIRED';
    let suitedness = 'RAINBOW';
    let connectedness = 'DISCONNECTED';

    // 1. 三条牌面 (Trips: clusters 26, 27)
    if (maxRankFreq >= 3) {
      pairedness = 'TRIPPED';
      highCard = maxRank >= 10 ? 'HIGH' : 'LOW';
      suitedness = 'RAINBOW';
      connectedness = 'DISCONNECTED';
      clusterId = maxRank >= 8 ? 26 : 27;
    }
    // 2. 单色牌面 (Monotone: clusters 22..25)
    else if (maxSuitFreq >= 3) {
      suitedness = 'MONOTONE';
      pairedness = 'UNPAIRED';
      const isHigh = maxRank >= 10;
      highCard = isHigh ? 'HIGH' : 'LOW';

      const span = ranks[0] - ranks[2];
      const hasWheel = ranks.includes(14) && (ranks.includes(2) || ranks.includes(3) || ranks.includes(4) || ranks.includes(5));
      const isConn = (span <= 4) || hasWheel;
      connectedness = isConn ? 'CONNECTED' : 'DISCONNECTED';

      if (isHigh) {
        clusterId = isConn ? 23 : 22;
      } else {
        clusterId = isConn ? 25 : 24;
      }
    }
    // 3. 一对牌面 (Paired: clusters 16..21)
    else if (maxRankFreq === 2) {
      pairedness = 'PAIRED';
      const pairRank = Object.keys(rankCounts).find(r => rankCounts[r] === 2) * 1;
      let pairCat = 0; // 0: High, 1: Mid, 2: Low
      if (pairRank >= 10) { pairCat = 0; highCard = 'HIGH'; }
      else if (pairRank >= 6) { pairCat = 1; highCard = 'MID'; }
      else { pairCat = 2; highCard = 'LOW'; }

      const isTwoTone = (maxSuitFreq === 2);
      suitedness = isTwoTone ? 'TWO_TONE' : 'RAINBOW';
      connectedness = 'DISCONNECTED';
      clusterId = 16 + pairCat * 2 + (isTwoTone ? 1 : 0);
    }
    // 4. 非配对、非单色 (Unpaired Non-monotone: clusters 0..15)
    else {
      pairedness = 'UNPAIRED';
      let hcCat = 0;
      if (maxRank === 14) { hcCat = 0; highCard = 'A_HIGH'; }
      else if (maxRank >= 12) { hcCat = 1; highCard = 'KQ_HIGH'; }
      else if (maxRank >= 10) { hcCat = 2; highCard = 'JT_HIGH'; }
      else { hcCat = 3; highCard = 'LOW'; }

      const span = ranks[0] - ranks[2];
      const hasWheel = ranks.includes(14) && ranks.some(r => r <= 5);
      const isConn = (span <= 4) || (hasWheel && ranks.filter(r => r <= 5).length >= 2);
      connectedness = isConn ? 'CONNECTED' : 'DISCONNECTED';

      const isTwoTone = (maxSuitFreq === 2);
      suitedness = isTwoTone ? 'TWO_TONE' : 'RAINBOW';

      clusterId = hcCat * 4 + (isConn ? 2 : 0) + (isTwoTone ? 1 : 0);
    }

    const clusterDef = POSTFLOP_CLUSTERS_28[clusterId] || POSTFLOP_CLUSTERS_28[0];
    const isDry = suitedness === 'RAINBOW' && (connectedness === 'DISCONNECTED' || pairedness === 'PAIRED');
    const isWet = suitedness === 'MONOTONE' || connectedness === 'CONNECTED';

    return {
      clusterId,
      clusterKey: clusterDef.key,
      clusterName: clusterDef.name,
      highCard,
      connectedness,
      suitedness,
      pairedness,
      isDry,
      isWet
    };
  }

  /**
   * 既有 API 兼容包装 (保持 100% 向后兼容)
   */
  function classifyBoardTexture(boardCards) {
    return classifyFlopToCluster(boardCards);
  }

  global.classifyFlopToCluster = classifyFlopToCluster;
  global.classifyBoardTexture = classifyBoardTexture;
  global.cardStringToIndex = cardStringToIndex;
  global.getFlopIndex = getFlopIndex;
  global.POSTFLOP_CLUSTERS_28 = POSTFLOP_CLUSTERS_28;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      classifyFlopToCluster,
      classifyBoardTexture,
      cardStringToIndex,
      getFlopIndex,
      POSTFLOP_CLUSTERS_28
    };
    exports.classifyFlopToCluster = classifyFlopToCluster;
    exports.classifyBoardTexture = classifyBoardTexture;
    exports.cardStringToIndex = cardStringToIndex;
    exports.getFlopIndex = getFlopIndex;
    exports.POSTFLOP_CLUSTERS_28 = POSTFLOP_CLUSTERS_28;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
