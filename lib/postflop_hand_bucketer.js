// 翻后手牌 24 子分桶器与宏观 GTO 聚类映射 (Phase 4 - Module 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-036 架构裁决：细化 24 手牌子分桶，支撑离线预解 Micro-LUT 策略矩阵

(function(global) {
  const RANK_VALUES = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
  };

  /**
   * 24 个手牌子桶标准定义 (Astra 规范)
   */
  const POSTFLOP_SUB_BUCKETS_24 = [
    // 0-6: NUTS_PREMIUM group
    { id: 0, key: 'NUTS_QUADS_FULLHOUSE', name: '四条/葫芦', macroBucket: 'NUTS_PREMIUM' },
    { id: 1, key: 'NUTS_FLUSH', name: '坚果同花', macroBucket: 'NUTS_PREMIUM' },
    { id: 2, key: 'FLUSH_NON_NUT', name: '非坚果同花', macroBucket: 'NUTS_PREMIUM' },
    { id: 3, key: 'STRAIGHT', name: '顺子成牌', macroBucket: 'NUTS_PREMIUM' },
    { id: 4, key: 'SET_TRIPS', name: '三条/暗三', macroBucket: 'NUTS_PREMIUM' },
    { id: 5, key: 'TWO_PAIR_TOP', name: '顶两对/强两对', macroBucket: 'NUTS_PREMIUM' },
    { id: 6, key: 'TWO_PAIR_WEAK', name: '底两对/弱两对', macroBucket: 'NUTS_PREMIUM' },

    // 7-10: TOP_PAIR / OVERPAIR (MARGINAL_MADE / VALUE)
    { id: 7, key: 'OVERPAIR', name: '超对 (Overpair)', macroBucket: 'MARGINAL_MADE' },
    { id: 8, key: 'TOP_PAIR_TOP_KICKER', name: '顶对顶踢 (TPTK)', macroBucket: 'MARGINAL_MADE' },
    { id: 9, key: 'TOP_PAIR_GOOD_KICKER', name: '顶对好踢 (TPGK)', macroBucket: 'MARGINAL_MADE' },
    { id: 10, key: 'TOP_PAIR_WEAK_KICKER', name: '顶对弱踢 (TPWK)', macroBucket: 'MARGINAL_MADE' },

    // 11-15: MARGINAL_MADE group
    { id: 11, key: 'SECOND_PAIR_STRONG', name: '中对强踢', macroBucket: 'MARGINAL_MADE' },
    { id: 12, key: 'SECOND_PAIR_WEAK', name: '中对弱踢', macroBucket: 'MARGINAL_MADE' },
    { id: 13, key: 'UNDERPAIR', name: '口袋对子 (中位)', macroBucket: 'MARGINAL_MADE' },
    { id: 14, key: 'BOTTOM_PAIR', name: '底对', macroBucket: 'MARGINAL_MADE' },
    { id: 15, key: 'BOARD_PAIR_WEAK', name: '公牌成对+弱底牌', macroBucket: 'MARGINAL_MADE' },

    // 16-19: STRONG_DRAW group
    { id: 16, key: 'COMBO_DRAW', name: '组合巨抽 (同花+顺子听牌)', macroBucket: 'STRONG_DRAW' },
    { id: 17, key: 'NUT_FLUSH_DRAW', name: '坚果同花听牌 (NFD)', macroBucket: 'STRONG_DRAW' },
    { id: 18, key: 'FLUSH_DRAW_WEAK', name: '同花听牌 (9 outs)', macroBucket: 'STRONG_DRAW' },
    { id: 19, key: 'OESD', name: '双头顺听牌 (8 outs)', macroBucket: 'STRONG_DRAW' },

    // 20-22: WEAK_DRAW & BACKDOOR group
    { id: 20, key: 'GUTSHOT', name: '卡顺听牌 (4 outs)', macroBucket: 'BACKDOOR_POTENTIAL' },
    { id: 21, key: 'DOUBLE_BACKDOOR', name: '双后门潜力 (后门花+后门顺)', macroBucket: 'BACKDOOR_POTENTIAL' },
    { id: 22, key: 'SINGLE_BACKDOOR', name: '单后门潜力', macroBucket: 'AIR_WEAK' },

    // 23: AIR group
    { id: 23, key: 'AIR_PURE', name: '纯空气高牌', macroBucket: 'AIR_WEAK' }
  ];

  function isValidCard(c) {
    return typeof c === 'string' && c.length >= 2;
  }

  /**
   * 判定手牌在当前公牌下的 24 手牌子分桶与 5 大宏观分桶
   * @param {Array<string>} heroCards - 手牌两张，如 ['Td', '2d']
   * @param {Array<string>} boardCards - 公牌数组，如 ['5d', '5h', '3c']
   * @returns {Object} 包含 subBucketId (0..23) 与旧有 bucket 兼容字段
   */
  function bucketHeroHand(heroCards, boardCards) {
    if (!Array.isArray(heroCards) || heroCards.length < 2 || !isValidCard(heroCards[0]) || !isValidCard(heroCards[1]) ||
        !Array.isArray(boardCards) || boardCards.length < 3 || boardCards.slice(0, 3).some(c => !isValidCard(c))) {
      return {
        subBucketId: 23,
        subBucketKey: 'AIR_PURE',
        subBucketName: '未知牌型',
        bucket: 'AIR_WEAK',
        details: '未知牌型',
        outs: 0,
        hasBackdoor: false
      };
    }

    const h1 = heroCards[0], h2 = heroCards[1];
    const r1 = RANK_VALUES[h1[0]] || 0, r2 = RANK_VALUES[h2[0]] || 0;
    const s1 = (h1[1] || 's').toLowerCase(), s2 = (h2[1] || 'h').toLowerCase();
    const isPocketPair = (r1 === r2);
    const isSuited = (s1 === s2);

    const bRanks = boardCards.map(c => RANK_VALUES[c[0]] || 0).sort((a,b)=>b-a);
    const bSuits = boardCards.map(c => (c[1] || 's').toLowerCase());
    const distinctBoardRanks = [...new Set(bRanks)].sort((a,b)=>b-a);
    const maxBoardRank = distinctBoardRanks[0] || 0;
    const secondBoardRank = distinctBoardRanks.length >= 2 ? distinctBoardRanks[1] : 0;
    const minBoardRank = distinctBoardRanks[distinctBoardRanks.length - 1] || 0;

    // 1. 公牌与手牌点数频次统计
    const boardCounts = {};
    for (const r of bRanks) boardCounts[r] = (boardCounts[r] || 0) + 1;
    const boardHasTrips = Object.values(boardCounts).some(c => c >= 3);
    const boardHasPair = Object.values(boardCounts).some(c => c >= 2);

    let hasQuadsOrFullHouse = false;
    let hasTrips = false;
    let hasTwoPair = false;
    let hasOverpair = false;
    let hasUnderpair = false;
    let hitTopPair = false;
    let hitSecondPair = false;
    let hitBottomPair = false;

    if (isPocketPair) {
      if (boardCounts[r1] >= 2) {
        hasQuadsOrFullHouse = true; // 四条 (Quads)
      } else if (boardCounts[r1] === 1) {
        if (boardHasPair) hasQuadsOrFullHouse = true; // 葫芦 (Full House)
        else hasTrips = true; // 暗三条 (Set)
      } else if (boardHasTrips) {
        hasQuadsOrFullHouse = true; // 公牌三条 + 口袋对 = 葫芦 (如 KKK 面 88)
      } else if (r1 > maxBoardRank) {
        hasOverpair = true; // 超对 (Overpair)
      } else if (boardHasPair) {
        // 口袋对 + 公牌成对 (如 KK2 面 QQ 或 22K 面 88): 形成两对
        hasTwoPair = true;
      } else if (r1 > secondBoardRank) {
        hasUnderpair = true; // 介于顶牌与中牌之间的口袋对
      } else if (r1 < minBoardRank) {
        hitBottomPair = true; // 低于公牌底牌的口袋对
      } else {
        hasUnderpair = true;
      }
    } else {
      const match1 = boardCounts[r1] || 0;
      const match2 = boardCounts[r2] || 0;

      if ((match1 >= 2 && match2 >= 1) || (match2 >= 2 && match1 >= 1)) {
        hasQuadsOrFullHouse = true; // 葫芦 (如 KK8 面 K8)
      } else if (boardHasTrips && (match1 >= 1 || match2 >= 1)) {
        hasQuadsOrFullHouse = true; // 公牌三条 + 手牌击中另一张 = 葫芦 (如 KKK 面 A8)
      } else if (match1 >= 2 || match2 >= 2) {
        hasTrips = true; // 明三条 (Trips)
      } else if (match1 >= 1 && match2 >= 1) {
        hasTwoPair = true; // 两对
      } else if (match1 >= 1 || match2 >= 1) {
        const hitRank = match1 >= 1 ? r1 : r2;
        if (boardHasPair) {
          // 公牌已成对 (如 KK8 面 A8)，Hero 击中另一张，形成两对 (KK88)
          hasTwoPair = true;
        } else {
          if (hitRank === maxBoardRank) hitTopPair = true;
          else if (hitRank === secondBoardRank) hitSecondPair = true;
          else hitBottomPair = true;
        }
      }
    }

    // 2. 同花与顺子成牌与听牌
    const allCards = [...heroCards, ...boardCards];
    const suitCounts = {};
    for (const c of allCards) {
      const s = (c[1] || 's').toLowerCase();
      suitCounts[s] = (suitCounts[s] || 0) + 1;
    }
    const maxSuitCount = Math.max(...Object.values(suitCounts));
    const isFlushDraw = (maxSuitCount === 4 && (heroCards.some(c => suitCounts[(c[1]||'').toLowerCase()] >= 4)));
    const isMadeFlush = (maxSuitCount >= 5 && heroCards.some(c => suitCounts[(c[1]||'').toLowerCase()] >= 5));
    const isNutFlushDraw = isFlushDraw && (heroCards.some(c => c[0].toUpperCase() === 'A' && suitCounts[(c[1]||'').toLowerCase()] >= 4));

    // 顺子判定 (含 A-2-3-4-5 轮子顺)
    const distinctRanks = [...new Set(allCards.map(c => RANK_VALUES[c[0]] || 0))].sort((a,b)=>b-a);
    if (distinctRanks.includes(14)) distinctRanks.push(1);

    let isMadeStraight = false;
    let isOESD = false;
    let hasGutshot = false;

    // 顺子成牌
    for (let i = 0; i + 4 < distinctRanks.length; i++) {
      if (distinctRanks[i] - distinctRanks[i+4] === 4) {
        const straightSpan = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3], distinctRanks[i+4]];
        const heroUsed = straightSpan.includes(r1) || straightSpan.includes(r2) || (straightSpan.includes(1) && (r1 === 14 || r2 === 14));
        if (heroUsed) {
          isMadeStraight = true;
          break;
        }
      }
    }

    // 听顺判定
    if (!isMadeStraight) {
      for (let i = 0; i + 3 < distinctRanks.length; i++) {
        if (distinctRanks[i] - distinctRanks[i+3] === 3) {
          const span = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3]];
          const heroUsed = span.includes(r1) || span.includes(r2) || (span.includes(1) && (r1 === 14 || r2 === 14));
          if (heroUsed) isOESD = true;
        }
      }
      if (!isOESD) {
        for (let i = 0; i + 3 < distinctRanks.length; i++) {
          if (distinctRanks[i] - distinctRanks[i+3] === 4) {
            const span = [distinctRanks[i], distinctRanks[i+1], distinctRanks[i+2], distinctRanks[i+3]];
            const heroUsed = span.includes(r1) || span.includes(r2) || (span.includes(1) && (r1 === 14 || r2 === 14));
            if (heroUsed) hasGutshot = true;
          }
        }
      }
    }

    // 3. 后门听牌判定 (底牌必须实质贡献)
    let hasBackdoorFlush = false;
    if (isSuited && boardCards.length === 3) {
      const flopSuitMatches = bSuits.filter(s => s === s1).length;
      if (flopSuitMatches === 1) hasBackdoorFlush = true;
    }

    let hasBackdoorStraight = false;
    if (boardCards.length === 3) {
      const heroRanks = [r1, r2];
      if (r1 === 14) heroRanks.push(1);
      if (r2 === 14) heroRanks.push(1);

      const bRanksSet = [...new Set(bRanks)];
      if (bRanksSet.includes(14)) bRanksSet.push(1);

      for (const hr of heroRanks) {
        for (let i = 0; i < bRanksSet.length; i++) {
          for (let j = i + 1; j < bRanksSet.length; j++) {
            const trio = [hr, bRanksSet[i], bRanksSet[j]].sort((a,b)=>a-b);
            if (trio[2] - trio[0] <= 4 && trio[0] !== trio[1] && trio[1] !== trio[2]) {
              hasBackdoorStraight = true;
              break;
            }
          }
          if (hasBackdoorStraight) break;
        }
        if (hasBackdoorStraight) break;
      }
    }

    // 踢脚高低判定
    const kickerRank = hitTopPair ? (r1 === maxBoardRank ? r2 : r1) : Math.min(r1, r2);

    // 4. 映射到 24 手牌子分桶
    let subBucketId = 23;

    // 4.1 坚果/成牌端
    if (hasQuadsOrFullHouse) {
      subBucketId = 0;
    } else if (isMadeFlush && heroCards.some(c => c[0].toUpperCase() === 'A')) {
      subBucketId = 1;
    } else if (isMadeFlush) {
      subBucketId = 2;
    } else if (isMadeStraight) {
      subBucketId = 3;
    } else if (hasTrips) {
      subBucketId = 4;
    } else if (hasTwoPair && Math.max(r1, r2) === maxBoardRank) {
      subBucketId = 5;
    } else if (hasTwoPair) {
      subBucketId = 6;
    }
    // 4.2 强成牌 / 顶对
    else if (hasOverpair) {
      subBucketId = 7;
    } else if (hitTopPair && kickerRank >= 13) {
      subBucketId = 8;
    } else if (hitTopPair && kickerRank >= 10) {
      subBucketId = 9;
    } else if (hitTopPair) {
      subBucketId = 10;
    }
    // 4.3 强听牌
    else if (isFlushDraw && (isOESD || hasGutshot)) {
      subBucketId = 16;
    } else if (isNutFlushDraw) {
      subBucketId = 17;
    } else if (isFlushDraw) {
      subBucketId = 18;
    } else if (isOESD) {
      subBucketId = 19;
    }
    // 4.4 边际成牌
    else if (hitSecondPair && kickerRank >= 10) {
      subBucketId = 11;
    } else if (hitSecondPair) {
      subBucketId = 12;
    } else if (hasUnderpair) {
      subBucketId = 13;
    } else if (hitBottomPair) {
      subBucketId = 14;
    } else if (boardHasPair && isPocketPair) {
      subBucketId = 15;
    }
    // 4.5 弱听牌与后门
    else if (hasGutshot) {
      subBucketId = 20;
    } else if (hasBackdoorFlush && hasBackdoorStraight && boardCards.length === 3) {
      subBucketId = 21;
    } else if (hasBackdoorFlush || hasBackdoorStraight) {
      subBucketId = 22;
    } else {
      subBucketId = 23;
    }

    const subDef = POSTFLOP_SUB_BUCKETS_24[subBucketId] || POSTFLOP_SUB_BUCKETS_24[23];

    // 计算合理 outs
    let outs = 0;
    if (subBucketId <= 6) outs = 0; // 成牌
    else if (subBucketId === 16) outs = 12; // 组合听
    else if (subBucketId === 17 || subBucketId === 18) outs = 9; // 同花听
    else if (subBucketId === 19) outs = 8; // 双头顺听
    else if (subBucketId === 20) outs = 4; // 卡顺
    else if (subBucketId === 21) outs = 3; // 双后门
    else if (subBucketId === 22) outs = 1; // 单后门
    else if (subBucketId >= 7 && subBucketId <= 15) outs = 2; // 成对补三条

    return {
      subBucketId,
      subBucketKey: subDef.key,
      subBucketName: subDef.name,
      bucket: subDef.macroBucket,
      details: subDef.name,
      outs,
      hasBackdoor: subBucketId === 21 || subBucketId === 22
    };
  }

  global.bucketHeroHand = bucketHeroHand;
  global.POSTFLOP_SUB_BUCKETS_24 = POSTFLOP_SUB_BUCKETS_24;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bucketHeroHand, POSTFLOP_SUB_BUCKETS_24 };
    exports.bucketHeroHand = bucketHeroHand;
    exports.POSTFLOP_SUB_BUCKETS_24 = POSTFLOP_SUB_BUCKETS_24;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
