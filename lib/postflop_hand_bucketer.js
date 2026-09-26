// 翻后手牌宏观分桶器 (Phase 3 - Module 2)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 目标：将玩家在特定牌面下的手牌，精准归入 4+1 大 GTO 分桶：
// [NUTS_PREMIUM, MARGINAL_MADE, STRONG_DRAW, BACKDOOR_POTENTIAL, AIR_WEAK]

const RANK_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  'T': 10, 't': 10, 'J': 11, 'j': 11, 'Q': 12, 'q': 12, 'K': 13, 'k': 13, 'A': 14, 'a': 14
};

/**
 * 判定手牌在当前公牌下的 GTO 宏观分桶
 * @param {Array<string>} heroCards - 手牌两张，如 ['Td', '2d']
 * @param {Array<string>} boardCards - 公牌数组，如 ['5d', '5h', '3c']
 * @returns {Object} { bucket: string, details: string, outs: number, hasBackdoor: boolean }
 */
export function bucketHeroHand(heroCards, boardCards) {
  if (!heroCards || heroCards.length < 2 || !boardCards || boardCards.length < 3) {
    return { bucket: 'AIR_WEAK', details: '未知牌型', outs: 0, hasBackdoor: false };
  }

  const h1 = heroCards[0], h2 = heroCards[1];
  const r1 = RANK_VALUES[h1[0]] || 0, r2 = RANK_VALUES[h2[0]] || 0;
  const s1 = h1[1], s2 = h2[1];
  const isPocketPair = (r1 === r2);
  const isSuited = (s1 === s2);

  const bRanks = boardCards.map(c => RANK_VALUES[c[0]] || 0).sort((a,b)=>b-a);
  const bSuits = boardCards.map(c => c[1]);
  const maxBoardRank = bRanks[0];

  // 1. 计算公牌点数与 Hero 击中情况
  const boardCounts = {};
  for (const r of bRanks) {
    boardCounts[r] = (boardCounts[r] || 0) + 1;
  }
  const boardHasPair = Object.values(boardCounts).some(c => c >= 2);

  let hasTrips = false;
  let hasTwoPair = false;
  let hasOnePair = false;
  let pairRank = null;

  // 三条判定: Hero 拿对子且中1张, 或 Hero 1张中公牌对子
  if (isPocketPair && (boardCounts[r1] || 0) >= 1) {
    hasTrips = true;
  } else if (!isPocketPair && ((boardCounts[r1] || 0) >= 2 || (boardCounts[r2] || 0) >= 2)) {
    hasTrips = true;
  }

  // 两对判定: Hero 两张各自中不同的公牌, 或 Hero 拿对子且公牌有对
  if ((boardCounts[r1] || 0) >= 1 && (boardCounts[r2] || 0) >= 1 && r1 !== r2) {
    hasTwoPair = true;
  } else if (isPocketPair && boardHasPair) {
    hasTwoPair = true;
  }

  // 单对判定: Hero 手持口袋对, 或 Hero 其中一张中单对
  if (isPocketPair) {
    hasOnePair = true;
    pairRank = r1;
  } else if ((boardCounts[r1] || 0) === 1) {
    hasOnePair = true;
    pairRank = r1;
  } else if ((boardCounts[r2] || 0) === 1) {
    hasOnePair = true;
    pairRank = r2;
  }

  // 2. 听花 (Flush Draw) 与后门花 (Backdoor Flush Draw) 检测
  let flushSuitCount = 0;
  let hasBackdoorFlush = false;
  for (const s of ['s', 'h', 'd', 'c']) {
    const inHand = (s1 === s ? 1 : 0) + (s2 === s ? 1 : 0);
    const onBoard = bSuits.filter(bs => bs === s).length;
    const total = inHand + onBoard;
    if (total >= 4) flushSuitCount = total;
    // 后门花：Flop 上手中 2 张同花 + 公牌 1 张同花，总计 3 张同花
    if (isSuited && inHand === 2 && onBoard === 1 && boardCards.length === 3) {
      hasBackdoorFlush = true;
    }
  }

  // 3. 顺子与顺子听牌检测
  const allRanks = [...new Set([r1, r2, ...bRanks])].sort((a,b)=>a-b);
  let hasStraight = false;
  let hasOESD = false;
  let hasGutshot = false;

  for (let i = 0; i <= allRanks.length - 4; i++) {
    const sub = allRanks.slice(i, i + 4);
    const span = sub[3] - sub[0];
    if (span === 3) hasOESD = true;
    else if (span === 4) hasGutshot = true;
  }
  for (let i = 0; i <= allRanks.length - 5; i++) {
    const sub = allRanks.slice(i, i + 5);
    if (sub[4] - sub[0] === 4) hasStraight = true;
  }

  // 后门顺子潜力 (手牌与公牌相邻间隙 <= 2)
  let hasBackdoorStraight = false;
  if (boardCards.length === 3) {
    if (Math.abs(r1 - r2) <= 3 || bRanks.some(br => Math.abs(br - r1) <= 2 || Math.abs(br - r2) <= 2)) {
      hasBackdoorStraight = true;
    }
  }

  // 4. 分桶判定逻辑 (从顶端 Nuts 到 Air)
  // 4.1 Nuts / Premium (两对及以上、三条、葫芦、同花、顺子、超强顶对 TPTK)
  if (hasStraight || flushSuitCount >= 5 || hasTrips || hasTwoPair) {
    return {
      bucket: 'NUTS_PREMIUM',
      details: hasTrips ? '三条及以上' : (hasTwoPair ? '两对' : '成牌坚果'),
      outs: 0,
      hasBackdoor: false
    };
  }

  // 顶对 TPTK
  const hitTopPair = (r1 === maxBoardRank || r2 === maxBoardRank);
  const kicker = hitTopPair ? (r1 === maxBoardRank ? r2 : r1) : 0;
  if (hitTopPair && kicker >= 11) {
    return {
      bucket: 'NUTS_PREMIUM',
      details: '顶对强踢脚 (TPTK)',
      outs: 5,
      hasBackdoor: false
    };
  }

  // 4.2 Strong Draw (同花听牌 >= 9 outs, 两头顺 OESD >= 8 outs)
  if (flushSuitCount === 4 || hasOESD) {
    return {
      bucket: 'STRONG_DRAW',
      details: flushSuitCount === 4 ? '同花听牌 (FD)' : '两头顺听牌 (OESD)',
      outs: flushSuitCount === 4 ? 9 : 8,
      hasBackdoor: false
    };
  }

  // 4.3 Marginal Made (普通顶对、中对、底对、口袋中对)
  if (hitTopPair || hasOnePair) {
    return {
      bucket: 'MARGINAL_MADE',
      details: hitTopPair ? '普通顶对' : (isPocketPair ? '口袋对子' : '中底对'),
      outs: 2,
      hasBackdoor: false
    };
  }

  // 4.4 Backdoor Potential (双后门潜力: 后门同花 + 后门顺子, 具备极化 Check-Raise 反击能力)
  if (hasBackdoorFlush && hasBackdoorStraight && boardCards.length === 3) {
    return {
      bucket: 'BACKDOOR_POTENTIAL',
      details: '双后门潜力 (后门同花+后门顺子)',
      outs: 3,
      hasBackdoor: true
    };
  }

  // 4.5 Air / Weak
  return {
    bucket: 'AIR_WEAK',
    details: '高牌/无成牌空气',
    outs: hasGutshot ? 4 : 0,
    hasBackdoor: hasBackdoorFlush || hasBackdoorStraight
  };
}
