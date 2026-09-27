// 翻后多人底池收紧与范围衰减矩阵引擎 (Phase 9B - Multiway Postflop Shrinkage & Dynamics Engine)
// 设计者：GPT-6-Astra (首席架构师) + Gemini (主程)
// 依据：TASK-ASTRA-038 架构裁决：多人底池共享 MDF 定理与相对位置夹心衰减

(function(global) {
  'use strict';

  /**
   * 计算多人底池共享最小防守频率 (Shared Multiway MDF)
   * 定理：在 N 人底池中（N >= 2），存在 K = N - 1 名防守者。
   * 下注者的纯诈唬必须令所有 K 名防守者同时弃牌才能盈利：
   * (1 - D)^K = alpha = bet / (pot + bet)
   * => 个人纳什均衡防守频率 D = 1 - (alpha)^(1 / K)
   * @param {number} preBetPot - 对手下注前底池大小 (BB)
   * @param {number} bet - 对手下注额 (BB)
   * @param {number} numContenders - 当前在池总人数 N (如单挑=2, 三人=3)
   * @returns {number} 个人应防守频率百分比 (0 ~ 100)
   */
  function calculateMultiwayMdf(preBetPot, bet, numContenders) {
    if (!bet || bet <= 0) return 100;
    const n = Math.max(2, numContenders || 2);
    const k = n - 1; // 防守者数量
    const totalPot = Math.max(0.1, preBetPot + bet);
    const alpha = Math.max(0.01, Math.min(0.99, bet / totalPot));
    
    // D = 1 - alpha^(1 / k)
    const personalMdfRatio = 1 - Math.pow(alpha, 1 / k);
    return Math.max(0, Math.min(100, Math.round(personalMdfRatio * 1000) / 10));
  }

  /**
   * 计算多人底池相对位置角色与实现率乘数
   * @param {string} heroPos - Hero 位置 (如 'BTN', 'SB', 'BB', 'CO', 'HJ')
   * @param {Array<string>} activePositions - 所有在局活跃位置列表 (按顺位排序或集合)
   * @returns {Object} 角色标签、中文名称与权益实现率校正系数 EQR
   */
  function evaluateMultiwayRole(heroPos, activePositions) {
    if (!activePositions || activePositions.length <= 2) {
      return {
        role: 'HEADS_UP',
        roleLabel: '单挑对决',
        badgeClass: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
        eqrMultiplier: 1.0,
        sandwichRisk: false
      };
    }

    const posOrder = ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'];
    const sorted = [...activePositions].sort((a, b) => posOrder.indexOf(a) - posOrder.indexOf(b));
    const heroIdx = sorted.indexOf(heroPos);

    if (heroIdx === sorted.length - 1) {
      // 关门位 (在所有人之后行动)
      return {
        role: 'ABSOLUTE_IP',
        roleLabel: '关门在位 (Absolute IP)',
        badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
        eqrMultiplier: 1.12, // 关门位享受信息与控池红利
        sandwichRisk: false,
        tactics: '处于最后关门位，无需防范身后二次进攻，可精准利用前序弃牌率与便宜摊牌'
      };
    } else if (heroIdx === 0) {
      // 枪口/最先位 (所有人都在身后行动)
      return {
        role: 'ABSOLUTE_OOP',
        roleLabel: '首位出线 (Absolute OOP)',
        badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
        eqrMultiplier: 0.82, // 翻后全街没有位置
        sandwichRisk: false,
        tactics: '处于绝对不利首位，翻后全街率先暴露意图，价值下注需大幅收敛、以过牌控池为主'
      };
    } else {
      // 夹心位 (前后均有人，最危险位置)
      return {
        role: 'SANDWICH',
        roleLabel: '夹心位 (Sandwich)',
        badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        eqrMultiplier: 0.72, // 承受被两面夹击与再次加注高风险
        sandwichRisk: true,
        tactics: '前后均有活跃对手，面临极度严重的再加注（Check-Raise / Squeeze）与反向暗含赔率风险，严禁跟注边缘弱手'
      };
    }
  }

  /**
   * 翻后多人底池核心综合动力学分析器
   * @param {Object} ctx - 上下文参数
   * @returns {Object} 完整的多人底池动力学研判与决策参数修正
   */
  function evaluateMultiwayDynamics(ctx) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    if (!ctx) {
      return {
        status: 'INVALID_INPUT',
        isMultiway: false,
        numContenders: 2,
        sharedMdf: 0,
        fairShareEquity: 50,
        bluffSuppressed: false,
        relativeRole: null
      };
    }

    const heroPos = ctx.heroPos || 'BTN';
    const contenders = Array.isArray(ctx.contenders) ? ctx.contenders : [heroPos, 'BB'];
    const numContenders = Math.max(2, ctx.numContenders !== undefined ? ctx.numContenders : contenders.length);
    const isMultiway = numContenders >= 3;
    const mwN = Math.max(0, numContenders - 2);

    const pot = Math.max(0.1, ctx.pot || 10);
    const villainBet = Math.max(0, ctx.villainBet || 0);
    const preBetPot = Math.max(0.1, pot - villainBet);
    const street = ctx.street || 'flop';
    const equity = ctx.equity !== undefined ? ctx.equity : 50;
    const outs = ctx.outs || 0;
    const handBucket = ctx.handBucket || '无对';

    // 1. 共享 MDF 与相对公平胜率计算
    const sharedMdf = calculateMultiwayMdf(preBetPot, villainBet, numContenders);
    const fairShareEquity = Math.round((100 / numContenders) * 10) / 10;

    // 2. 相对位置角色
    const roleInfo = evaluateMultiwayRole(heroPos, contenders);

    // 3. 门槛动态折减与漂移 (Fedor Holz 相对胜率比模型)
    // 单挑门槛基准是 50%，3人池基准是 33.3%，4人池基准是 25.0%
    const betThresh = Math.round(fairShareEquity * 1.12);
    const strongThresh = Math.round(fairShareEquity * 1.35);

    // 夹心位跟注门槛惩罚 (+4%)，首位惩罚 (+2%)，关门位放宽 (-2%)
    let callMarginShift = 2 * mwN;
    if (roleInfo.role === 'SANDWICH') callMarginShift += 4;
    else if (roleInfo.role === 'ABSOLUTE_OOP') callMarginShift += 2;
    else if (roleInfo.role === 'ABSOLUTE_IP') callMarginShift -= 1;

    // 4. 纯诈唬与半诈唬资格判定
    // 多人底池 (N >= 3) 严正归零纯空气诈唬，弃牌率呈指数级衰减
    const pureBluffAllowed = !isMultiway;
    // 半诈唬进张门槛升高 (翻牌需 >= 8 outs，转牌需 >= 10 outs)
    const semiBluffMinOuts = isMultiway ? (street === 'turn' ? 10 : 8) : (street === 'turn' ? 9 : 8);
    const semiBluffAllowed = outs >= semiBluffMinOuts && equity >= fairShareEquity;

    // 5. 综合战术解说 (Rich Rationale)
    let tacticalSummary = '';
    if (isMultiway) {
      if (villainBet > 0) {
        tacticalSummary = `${numContenders}人底池面对下注：纳什共享防守频率(MDF)折减至 ${sharedMdf}%（单挑需防守 ${(preBetPot/(preBetPot+villainBet)*100).toFixed(0)}%）。` +
          `我方处于${roleInfo.roleLabel}，${roleInfo.tactics}。跟注门槛收紧 +${callMarginShift}%，严禁盲目宽跟。`;
      } else {
        tacticalSummary = `${numContenders}人底池面对过牌：相对公平胜率基准为 ${fairShareEquity}%。多人底池纯空气牌诈唬归零（弃牌率衰减），` +
          `仅在手牌胜率大幅超越公平胜率 (${betThresh}%+) 或持强进张 (>=${semiBluffMinOuts}张) 时发起价值下注。`;
      }
    } else {
      tacticalSummary = '单挑对决：执行常规 GTO 范围防守与标准 MDF 平衡。';
    }

    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const latencyUs = Math.round((t1 - t0) * 1000 * 10) / 10;

    return {
      status: 'MATCHED_MULTIWAY_DYNAMICS',
      isMultiway,
      numContenders,
      extraVillainsCount: mwN,
      sharedMdf,
      fairShareEquity,
      relativeRole: roleInfo.role,
      roleLabel: roleInfo.roleLabel,
      badgeClass: roleInfo.badgeClass,
      eqrMultiplier: roleInfo.eqrMultiplier,
      sandwichRisk: roleInfo.sandwichRisk,
      betThresh,
      strongThresh,
      callMarginShift,
      pureBluffAllowed,
      semiBluffAllowed,
      tacticalSummary,
      latencyUs: latencyUs > 0 ? latencyUs : 0.1
    };
  }

  global.calculateMultiwayMdf = calculateMultiwayMdf;
  global.evaluateMultiwayRole = evaluateMultiwayRole;
  global.evaluateMultiwayDynamics = evaluateMultiwayDynamics;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      calculateMultiwayMdf,
      evaluateMultiwayRole,
      evaluateMultiwayDynamics
    };
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
