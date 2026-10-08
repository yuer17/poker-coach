// ==============================================================================
// PokerCode Postflop GTO Query & Unification Engine (v3.26.4)
// Architecture: Single Strategy Ownership with Zero UI Bloat
// S4 24-Suit Isomorphism Canonical Mapping & High-Precision Equilibrium Retrieval
// ==============================================================================
(function(root) {
  'use strict';

  const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const RANK_VAL = {
    '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9,
    'T':10, 'J':11, 'Q':12, 'K':13, 'A':14
  };
  const SUITS = ['s', 'h', 'd', 'c'];

  // 全集 24 种花色置换群 S_4
  const PERMUTATIONS = (function() {
    const perms = [];
    function permute(arr, m = []) {
      if (arr.length === 0) perms.push(m);
      else {
        for (let i = 0; i < arr.length; i++) {
          const curr = arr.slice();
          const next = curr.splice(i, 1);
          permute(curr.slice(), m.concat(next));
        }
      }
    }
    permute(SUITS);
    return perms.map(p => ({
      's': p[0],
      'h': p[1],
      'd': p[2],
      'c': p[3]
    }));
  })();

  function parseCard(c) {
    if (!c) return null;
    if (typeof c === 'object' && c.rank && c.suit) {
      const r = c.rank.toUpperCase();
      const s = c.suit.toLowerCase();
      if (!RANK_VAL[r] || !['s', 'h', 'd', 'c'].includes(s)) return null;
      return { rank: r, suit: s, val: RANK_VAL[r] };
    }
    if (typeof c === 'string' && c.length >= 2) {
      const r = c[0].toUpperCase();
      const s = c[1].toLowerCase();
      if (!RANK_VAL[r] || !['s', 'h', 'd', 'c'].includes(s)) return null;
      return { rank: r, suit: s, val: RANK_VAL[r] };
    }
    return null;
  }

  function parseCards(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(parseCard).filter(Boolean);
  }

  function sortCards(cards) {
    return cards.slice().sort((a, b) => {
      if (b.val !== a.val) return b.val - a.val;
      return a.suit.localeCompare(b.suit);
    });
  }

  function cardsToString(cards) {
    return cards.map(c => c.rank + c.suit).join('');
  }

  /**
   * 翻牌 3 张公牌 24 种置换规范元求解 (Canonical Flop)
   */
  function getCanonicalFlop(boardCards) {
    const cards = parseCards(boardCards).slice(0, 3);
    if (cards.length < 3) return null;

    let bestStr = null;
    let bestPerm = null;

    for (let i = 0; i < PERMUTATIONS.length; i++) {
      const perm = PERMUTATIONS[i];
      const mapped = cards.map(c => ({ rank: c.rank, suit: perm[c.suit], val: c.val }));
      const sorted = sortCards(mapped);
      const str = cardsToString(sorted);
      if (bestStr === null || str < bestStr) {
        bestStr = str;
        bestPerm = perm;
      }
    }

    return { canonical: bestStr, perm: bestPerm, raw: cardsToString(cards) };
  }

  // 1326 组合索引映射表缓存
  let _comboMap = null;
  function getComboMap(combosIndex) {
    if (_comboMap) return _comboMap;
    _comboMap = new Map();
    combosIndex.forEach((c, idx) => _comboMap.set(c, idx));
    return _comboMap;
  }

  /**
   * 推导当前对局快照对应的 GTO 战术战局 (Tactical Spot)
   * 严格核查双方座位与行动类型，杜绝越界接管 (P0-1 闭环)
   */
  function derivePostflopSpot(snapshot) {
    if (!snapshot) return null;
    const board = parseCards(snapshot.board || []);
    if (board.length < 3) return null;

    const street = board.length === 3 ? 'flop' : (board.length === 4 ? 'turn' : 'river');
    const heroPos = snapshot.heroPosition; // 'IP' or 'OOP'
    const heroSeat = snapshot.heroSeat || (heroPos === 'IP' ? 'BTN' : 'BB');
    const villainSeat = snapshot.villainSeat || (heroPos === 'IP' ? 'BB' : 'BTN');
    const mode = snapshot.currentMode; // 'open', 'vsLimp', 'squeeze', 'face3b', 'faceBet', 'defend'
    const potTracker = snapshot.potTracker || {};
    const actions = potTracker.actions || [];

    // 多人底池与未加注跛入底池 (vsLimp) 绝不进入单加注或 3-Bet GTO 矩阵 (P2-A 闭环)
    const extraVillains = snapshot.extraVillains || [];
    if (extraVillains.length > 0) return null;
    if (mode === 'vsLimp') return null;

    const streetActs = actions.filter(a => a.street === street);
    const villainBet = streetActs.filter(a => a.player === 'villain' && ['bet', 'raise', 'allin'].includes(a.action)).pop();

    // 判定翻前是否为 4-Bet 或 3-Bet 底池 (P1-D / P1-C 闭环: 严防 coldCall 模式穿透)
    const is4BetPot = mode === 'face4b' || !!snapshot.hero4bet;
    const is3BetPot = ['squeeze', 'face3b', 'coldCall'].includes(mode) || !!snapshot.hero3bet;
    const isBigPot = is3BetPot || is4BetPot;

    if (is4BetPot) return null; // 4-Bet 底池无解算节点，安全回退

    // 翻牌街 (Flop)
    if (street === 'flop') {
      // 场景 5/6: 3-Bet 底池 (优先校验，防止被 SRP 短路)
      if (is3BetPot) {
        // 仅当 Hero 是 3-Bet 主动侵略者 (PFA) 时放行 OOP C-Bet 节点；
        // Hero 为 Caller (如 mode === 'face3b' 或 'coldCall') 或 4-Bet 方时一律回退
        const heroIs3BAggressor = (mode === 'squeeze' || (mode === 'faceBet' && !!snapshot.hero3bet)) && !snapshot.hero4bet;
        if (heroIs3BAggressor && heroPos === 'OOP' && (!villainBet || villainBet.amount === 0)) {
          if (heroSeat === 'BB' && villainSeat === 'BTN') return 'BB_vs_BTN_3BP_CBet_OOP';
          if (heroSeat === 'SB' && villainSeat === 'BTN') return 'SB_vs_BTN_3BP_CBet_OOP';
        }
        return null; // 其余 3BP (如 Hero 为 Caller 或面对对手下注) 一律回退
      }

      if (isBigPot) return null; // 严防任何大底池漏入 SRP

      // ── 以下均为单加注底池 (Single Raised Pot) ──
      // 场景 1: BTN vs BB SRP IP C-Bet (Hero BTN, Villain BB, 面对 BB 过牌)
      if (heroPos === 'IP' && heroSeat === 'BTN' && villainSeat === 'BB' && (!villainBet || villainBet.amount === 0)) {
        return 'BTN_vs_BB_SRP_CBet_IP';
      }

      // 场景 2: BB vs BTN SRP OOP 首次行动 (Hero BB, Villain BTN, 决策是否领打)
      if (heroPos === 'OOP' && heroSeat === 'BB' && villainSeat === 'BTN' && (!villainBet || villainBet.amount === 0)) {
        return 'BB_vs_BTN_SRP_First_To_Act_OOP';
      }

      // 场景 3: BB vs BTN SRP 面对 C-Bet (Hero BB, Villain BTN, 面对对手下注)
      if (heroPos === 'OOP' && heroSeat === 'BB' && villainSeat === 'BTN' && villainBet && villainBet.amount > 0) {
        return 'BB_vs_BTN_Face_CBet_OOP';
      }

      // 场景 4: SB vs BB BvB C-Bet OOP (Hero SB, Villain BB, 面对 BB)
      if (heroPos === 'OOP' && heroSeat === 'SB' && villainSeat === 'BB' && (!villainBet || villainBet.amount === 0)) {
        return 'SB_vs_BB_BvB_CBet_OOP';
      }
    }

    // 转牌街 (Turn)
    if (street === 'turn' && !isBigPot) {
      // P1-B: 必须由 Hero 主动下注/加注翻牌，方可构成转牌 Double Barrel (排除对手领打 Hero 跟注流)
      const heroFlopBetted = actions.some(a => a.street === 'flop' && a.player === 'hero' && ['bet', 'raise'].includes(a.action));
      // 场景 7: BTN vs BB Turn Double Barrel IP (Hero BTN, Villain BB, Hero 翻牌下注二次开火)
      if (heroPos === 'IP' && heroSeat === 'BTN' && villainSeat === 'BB' && (!villainBet || villainBet.amount === 0) && heroFlopBetted) {
        return 'BTN_Turn_Double_Barrel_IP';
      }
    }

    return null;
  }

  /**
   * 核心求解器查询函数
   */
  function queryPostflopGtoSolver(snapshot) {
    if (!snapshot) return { matched: false, reason: 'NO_SNAPSHOT' };

    // 获取全局 GTO 数据资产
    const gtoData = (typeof window !== 'undefined' && (window.GTO_POSTFLOP_DATA || window.POSTFLOP_GTO_MATRIX)) ||
                    (typeof globalThis !== 'undefined' && (globalThis.GTO_POSTFLOP_DATA || globalThis.POSTFLOP_GTO_MATRIX)) ||
                    (typeof module !== 'undefined' && module.exports && (global.GTO_POSTFLOP_DATA || global.POSTFLOP_GTO_MATRIX));

    if (!gtoData || !gtoData.nodes) {
      return { matched: false, reason: 'GTO_DATA_NOT_LOADED' };
    }

    // 1. 判定对局战术战局
    const spot = derivePostflopSpot(snapshot);
    if (!spot) {
      return { matched: false, reason: 'SPOT_NOT_COVERED' };
    }

    // 2. 公牌 24 种花色同构化（翻牌规范元 + 转牌单张等价映射）
    const boardCards = parseCards(snapshot.board || []);
    if (boardCards.length < 3) {
      return { matched: false, reason: 'INVALID_BOARD' };
    }

    const flopObj = getCanonicalFlop(boardCards.slice(0, 3));
    if (!flopObj) {
      return { matched: false, reason: 'INVALID_BOARD' };
    }

    const { canonical, perm, raw } = flopObj;
    let nodeKey = `${spot}|${canonical}`;
    let fullBoardRaw = raw;
    let fullCanonical = canonical;

    if (boardCards.length >= 4) {
      // 转牌三段式节点键: spot|canonFlop|canonTurn
      const turnCard = boardCards[3];
      const canonTurn = turnCard.rank + perm[turnCard.suit];
      nodeKey = `${spot}|${canonical}|${canonTurn}`;
      fullBoardRaw = `${raw}${turnCard.rank}${turnCard.suit}`;
      fullCanonical = `${canonical}|${canonTurn}`;
    }

    const node = gtoData.nodes[nodeKey];
    if (!node) {
      return { matched: false, reason: 'BOARD_NOT_IN_GTO_SUBSET', spot, canonicalBoard: fullCanonical };
    }

    // 3. Hero 手牌花色置换与组合索引
    const rawHeroCards = parseCards(
      (snapshot.heroCards && snapshot.heroCards.length >= 2)
        ? snapshot.heroCards
        : [snapshot.heroCard1, snapshot.heroCard2].filter(Boolean)
    );
    if (rawHeroCards.length < 2) {
      return { matched: false, reason: 'INVALID_HERO_CARDS' };
    }

    const mappedHeroCards = rawHeroCards.map(c => ({ rank: c.rank, suit: perm[c.suit], val: c.val }));
    const sortedHero = sortCards(mappedHeroCards);
    const canonHandStr = cardsToString(sortedHero);

    const comboMap = getComboMap(gtoData.combos_index);
    const cid = comboMap.get(canonHandStr);
    if (cid === undefined) {
      return { matched: false, reason: 'INVALID_COMBO_MAPPING', canonHandStr };
    }

    const freqs = node.c[cid];
    if (!freqs) {
      return { matched: false, reason: 'HAND_OUT_OF_SOLVER_RANGE', canonHandStr };
    }

    // 4. 解析行动与频率
    const actions = node.a.map((aStr, idx) => {
      const parts = aStr.split(':');
      const rawName = parts[0];
      const sizingNum = parts[1] ? Number(parts[1]) : undefined;
      let standardAction = 'CHECK';
      let sizingDesc = '';

      if (rawName === 'check') standardAction = 'CHECK';
      else if (rawName === 'call') standardAction = 'CALL';
      else if (rawName === 'fold') standardAction = 'FOLD';
      else if (rawName === 'allin') { standardAction = 'ALLIN'; sizingDesc = '全押'; }
      else if (rawName.startsWith('bet')) {
        standardAction = 'BET';
        sizingDesc = sizingNum ? `${sizingNum}% 底池` : `${rawName.replace('bet', '')}BB`;
      } else if (rawName.startsWith('raise')) {
        standardAction = 'RAISE';
        sizingDesc = sizingNum ? `${sizingNum}% 底池` : `${rawName.replace('raise', '')}BB`;
      }

      return {
        name: rawName,
        action: standardAction,
        sizingNum,
        sizingDesc,
        freqPct: +(freqs[idx] / 10).toFixed(1), // 0..100%
        freqRaw: freqs[idx]
      };
    });

    // 找出最大频率行动 (Dominant Action)
    let dominant = actions[0];
    actions.forEach(a => {
      if (a.freqRaw > dominant.freqRaw) dominant = a;
    });

    // 格式化输出频率字典
    const frequencies = {};
    actions.forEach(a => {
      const k = a.action.toLowerCase();
      frequencies[k] = (frequencies[k] || 0) + Math.round(a.freqPct);
    });
    // 确保归一化为 100
    const fKeys = Object.keys(frequencies);
    const fSum = fKeys.reduce((acc, k) => acc + frequencies[k], 0);
    if (fSum !== 100 && fKeys.length > 0) {
      frequencies[dominant.action.toLowerCase()] += (100 - fSum);
    }

    // 构造结构化理由说明
    const spotCN = {
      'BTN_vs_BB_SRP_CBet_IP': '单加注底池 BTN vs BB (有利位置 C-Bet)',
      'BB_vs_BTN_SRP_First_To_Act_OOP': '单加注底池 BB vs BTN (不利位置防守领打)',
      'BB_vs_BTN_Face_CBet_OOP': '单加注底池 BB 面对 BTN 持续下注 (过牌加注 / Check-Raise 决策)',
      'SB_vs_BB_BvB_CBet_OOP': '盲注对抗 SB vs BB (不利位置 C-Bet)',
      'BB_vs_BTN_3BP_CBet_OOP': '3-Bet 底池 BB vs BTN (不利位置 C-Bet)',
      'SB_vs_BTN_3BP_CBet_OOP': '3-Bet 底池 SB vs BTN (不利位置 C-Bet)',
      'BTN_Turn_Double_Barrel_IP': '转牌连续进攻 BTN vs BB (二次开火)'
    }[spot] || spot;

    const actionBreakdown = actions
      .filter(a => a.freqPct > 0)
      .map(a => `${a.action === 'BET' || a.action === 'RAISE' ? `${a.sizingDesc || a.name}` : a.action} ${a.freqPct}%`)
      .join(' / ');

    const rawHeroStr = cardsToString(rawHeroCards);
    const reasoning = `🎯 [QuintAce GTO 求解器纯解]：战局=${spotCN}，公牌 ${fullBoardRaw}（同构基准面 ${fullCanonical}）。手牌 ${rawHeroStr} 真实平衡解为：${actionBreakdown}。主建议【${dominant.action}${dominant.sizingDesc ? ' ' + dominant.sizingDesc : ''}】。`;

    return {
      matched: true,
      source: 'gto_solver',
      spot,
      primaryAction: dominant.action,
      sizing: dominant.sizingDesc,
      frequencies,
      reasoning,
      actions,
      dominantAction: dominant,
      gtoMeta: {
        spot,
        spotCN,
        rawBoard: fullBoardRaw,
        canonicalBoard: fullCanonical,
        rawHeroCards: rawHeroStr,
        canonicalHeroCards: canonHandStr,
        isExactMatch: true
      }
    };
  }

  // 挂载
  const api = {
    getCanonicalFlop,
    derivePostflopSpot,
    queryPostflopGtoSolver
  };

  if (typeof window !== 'undefined') {
    window.PostflopGtoEngine = api;
    window.queryPostflopGtoSolver = queryPostflopGtoSolver;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.PostflopGtoEngine = api;
    globalThis.queryPostflopGtoSolver = queryPostflopGtoSolver;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : this);
