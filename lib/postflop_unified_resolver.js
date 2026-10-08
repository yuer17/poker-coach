/**
 * postflop_unified_resolver.js - 翻后决策单一事实源仲裁器 (Unified Action Resolver)
 * 
 * 职责：终结"多大脑"割裂，统一权威动作、频率矩阵、注额尺度与策略理由，
 * 将河牌终局博弈、转牌跃迁与几何注额、过牌加注极化反击、多人底池动力学与底层 Micro-LUT
 * 深度合流为单一权威事实源 (Single Source of Truth)，保证全站 UI (顶栏 HUD、决策依据主卡、
 * 行动按钮星标以及微卡片) 100% 动作零矛盾闭环。
 * 
 * Version: PokerCode v3.15 正式版
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.UnifiedResolver = factory();
        root.resolveUnifiedDecision = root.UnifiedResolver.resolveUnifiedDecision;
        root.closeFrequencies = root.UnifiedResolver.closeFrequencies;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * 最大余数法 (Largest Remainder Method / Hamilton Rule, Issue 10)
     * 保证概率非负且严格闭合为 100%，优先调用统一权威 normalizeFrequencies 实现
     */
    function closeFrequencies(freqObj) {
        if (typeof normalizeFrequencies === 'function') {
            return normalizeFrequencies(freqObj);
        }
        if (typeof globalThis !== 'undefined' && typeof globalThis.normalizeFrequencies === 'function') {
            return globalThis.normalizeFrequencies(freqObj);
        }
        if (!freqObj || typeof freqObj !== 'object') return { check: 100 };
        const keys = Object.keys(freqObj);
        if (keys.length === 0) return { check: 100 };

        let rawSum = 0;
        const validValues = {};
        keys.forEach(k => {
            const rawNum = Number(freqObj[k]);
            const v = (Number.isFinite(rawNum) && rawNum > 0) ? rawNum : 0;
            validValues[k] = v;
            rawSum += v;
        });

        if (rawSum <= 0) {
            const res = {};
            keys.forEach((k, i) => { res[k] = (i === 0 ? 100 : 0); });
            return res;
        }

        let sum = 0;
        const integerParts = {};
        const remainders = [];

        keys.forEach(k => {
            const normalized = (validValues[k] / rawSum) * 100;
            const fl = Math.floor(normalized);
            integerParts[k] = fl;
            sum += fl;
            remainders.push({ k, rem: normalized - fl });
        });

        remainders.sort((a, b) => b.rem - a.rem);
        let deficit = 100 - sum;
        let idx = 0;
        while (deficit > 0 && idx < remainders.length) {
            integerParts[remainders[idx].k]++;
            deficit--;
            idx++;
        }

        return integerParts;
    }

    /**
     * 决策合流仲裁核心函数
     * @param {Object} result - postEngine 初始装配的决策对象
     * @param {Object} state - 当前 postState 全局上下文
     * @param {Object} ctx - 环境参数 (board, pot, villainBet, effStack, heroPos, heroIsOOP 等)
     * @returns {Object} 仲裁归一化后的决策对象
     */
    function resolveUnifiedDecision(result, state, ctx) {
        if (!result || typeof result !== 'object') return result;
        ctx = ctx || {};
        state = state || {};

        const board = ctx.board || (state.board ? state.board.filter(c => c !== null) : []);
        const boardN = Array.isArray(board) ? board.filter(c => c !== null).length : 0;
        const street = ctx.street || (boardN === 5 ? 'river' : (boardN === 4 ? 'turn' : 'flop'));
        const villainBet = (typeof ctx.villainBet === 'number') ? ctx.villainBet : ((result.math && result.math.villainBet) || 0);
        const pot = (typeof ctx.pot === 'number') ? ctx.pot : ((result.math && result.math.pot) || 0);
        const effStack = (typeof ctx.effStack === 'number') ? ctx.effStack : ((result.math && result.math.effStack) || 0);
        const heroPos = ctx.heroPos || (state.heroPosition || 'IP');
        const heroIsOOP = ctx.heroIsOOP !== undefined ? ctx.heroIsOOP : (heroPos === 'OOP' || heroPos === 'BB' || heroPos === 'SB');
        const isFacingBet = villainBet > 0;

        // 记录原始值以供调试与对账
        result._rawPrimaryAction = result.primaryAction;
        result._rawFrequencies = Object.assign({}, result.frequencies || {});
        result._rawSizing = result.sizing;

        // ── 仲裁优先级 0: 极端边缘场景终极兜底 (Facing All-in / Re-Raise Shove Ultimate Mathematical Shield) ──
        const isShield = !!(result.isFacingAllin || result.isUltimateMathShield || result.guardrail === 'ULTIMATE_MATH_SHIELD');
        if (isShield) {
            result.isUnified = true;
            result.arbitrationSource = 'ULTIMATE_MATH_SHIELD';
            return result;
        }

        // ── 仲裁优先级 1: QuintAce 翻后高精 GTO 解算器真解 (Single Strategy Ownership, v3.27.0) ──
        if (result.source === 'gto_solver' && result.gtoSolver && result.gtoSolver.matched) {
            result.isUnified = true;
            result.arbitrationSource = 'GTO_SOLVER';
            return result;
        }

        // ── 仲裁优先级 2: 河牌终局博弈 (River Terminal Engine) ──
        if (street === 'river' && result.riverTerminal && result.riverTerminal.status === 'MATCHED_RIVER_TERMINAL') {
            const rt = result.riverTerminal;
            const rawAction = rt.primaryAction; // 'CHECK', 'BET_LARGE', 'BET_SMALL', 'CALL', 'RAISE', 'FOLD'
            let unifiedAct = rawAction;
            let unifiedSizing = result.sizing;
            let unifiedFreqs = {};

            if (rawAction === 'BET_LARGE' || rawAction === 'BET_SMALL') {
                unifiedAct = 'BET';
                unifiedSizing = (rawAction === 'BET_LARGE')
                    ? (rt.sizing || result.sizing || '75% 底池')
                    : (rt.sizing || result.sizing || '33% 底池');
            } else if (rawAction === 'RAISE' || rawAction === 'ALLIN') {
                unifiedAct = isFacingBet ? 'RAISE' : 'BET';
                unifiedSizing = (rawAction === 'ALLIN' || (effStack > 0 && effStack <= villainBet * 2.5))
                    ? '全押'
                    : (rt.sizing || result.sizing || `${Math.max(villainBet * 2.5, villainBet + pot * 0.5).toFixed(1)}BB`);
            } else if (rawAction === 'CALL') {
                unifiedAct = 'CALL';
                unifiedSizing = '';
            } else if (rawAction === 'CHECK') {
                unifiedAct = 'CHECK';
                unifiedSizing = '';
            } else if (rawAction === 'FOLD') {
                unifiedAct = 'FOLD';
                unifiedSizing = '';
            }

            if (rt.frequencies) {
                const rf = rt.frequencies;
                if (isFacingBet) {
                    unifiedFreqs = closeFrequencies({
                        fold: rf.FOLD || 0,
                        call: rf.CALL || 0,
                        raise: (rf.RAISE || 0) + (rf.ALLIN || 0)
                    });
                } else {
                    unifiedFreqs = closeFrequencies({
                        check: rf.CHECK || 0,
                        bet: (rf.BET_SMALL || 0) + (rf.BET_LARGE || 0) + (rf.ALLIN || 0)
                    });
                }
            }

            // 多人底池河牌纯空气诈唬强力压制为过牌
            const isMw = (result.multiwayDynamics && result.multiwayDynamics.isMultiway) || (ctx && ctx.isMultiway);
            const isRiverSolverCalibrated = !!(result.calibrationSource === 'TexasSolver' || result.isSolverCalibrated);
            if (isMw && (rt.terminalTier === 'PURE_AIR' || (!isFacingBet && unifiedAct === 'BET' && ((result.math && result.math.equity < 35) || (result._rawFrequencies && result._rawFrequencies.bet === 0))))) {
                unifiedAct = 'CHECK';
                unifiedSizing = '';
                unifiedFreqs = closeFrequencies({ check: 100, bet: 0 });
            }
            // 若河牌处于未下注主动节点，且底层已由 TexasSolver / 强价值逻辑产出更精准的频率与主动作
            else if (!isFacingBet && result._rawFrequencies) {
                // 如果底牌原本已有高频强价值下注 (>= 75%)，保留其高频下注与主动作
                if ((result._rawFrequencies.bet || 0) >= 75) {
                    unifiedFreqs = closeFrequencies(result._rawFrequencies);
                    unifiedAct = 'BET';
                    if (result._rawSizing) unifiedSizing = result._rawSizing;
                }
                // 如果底牌已经过 TexasSolver 校准注入了诈唬下注频率 (bet > 0)，保留其校准频率
                else if (isRiverSolverCalibrated && (result._rawFrequencies.bet || 0) > 0) {
                    unifiedFreqs = closeFrequencies(result._rawFrequencies);
                }
            }

            result.primaryAction = unifiedAct;
            result.sizing = unifiedSizing;
            if (Object.keys(unifiedFreqs).length > 0) {
                result.frequencies = unifiedFreqs;
            }
            if (rt.tactics || rt.tierName) {
                const hasRiverTactics = !!(result.isNutBlocker || result.isTripleBarrel || isRiverSolverCalibrated);
                if (result.reasoning && hasRiverTactics) {
                    result.reasoning = `🛑 [河牌终局博弈 · ${rt.tierName || '纳什终局'}]：${result.reasoning}`;
                } else {
                    result.reasoning = `🛑 [河牌终局博弈 · ${rt.tierName || '纳什终局'}]：${rt.tactics || result.reasoning || ''}`;
                }
            }
            result.arbitrationSource = 'RIVER_TERMINAL';
            result.isUnified = true;
            return result;
        }

        // ── 仲裁优先级 2: 翻后过牌加注 (Check-Raise Engine) ──
        if (isFacingBet && heroIsOOP && result.checkRaiseDecision && result.checkRaiseDecision.action === 'CHECK_RAISE') {
            const cr = result.checkRaiseDecision;
            result.primaryAction = 'RAISE';
            result.sizing = cr.isAllIn ? '全押' : `${cr.recommendedRaiseToBb.toFixed(1)}BB`;
            const raiseF = cr.crFrequency || 35;
            const isValueCR = cr.categoryLabel === '价值反击' || cr.categoryLabel === '强牌价值' ||
                              cr.category === 'VALUE' || cr.isValue === true ||
                              result.isValue === true || result.isStrongValue === true;
            const foldF = isValueCR ? 0 : (cr.foldF !== undefined ? cr.foldF : 25);
            const callF = Math.max(0, 100 - raiseF - foldF);
            result.frequencies = closeFrequencies({
                raise: raiseF,
                call: callF,
                fold: foldF
            });
            if (cr.tacticalReasoning) {
                result.reasoning = `⚔️ [翻后过牌加注 · ${cr.categoryLabel || '极化反击'}]：${cr.tacticalReasoning}`;
            }
            // 考虑对手画像与剥削偏转 (DEF-MW-04)
            const vProf = ctx.villainProfile || (state && state.villainProfile) || (result.exploit && result.exploit.profile);
            if (vProf) result.villainProfile = vProf;
            result.arbitrationSource = 'CHECK_RAISE';
            result.isUnified = true;
            return result;
        }

        // ── 仲裁优先级 3: 转牌跃迁与多档位几何注额 (Turn Sizing & Transition Engine) ──
        if (street === 'turn' && result.turnSizing && result.turnSizing.status === 'MATCHED_TURN_SIZING') {
            const ts = result.turnSizing;
            if (!isFacingBet) {
                // 若转牌原本已被 TexasSolver (环节 7 驱动量校准) 精确解算频率，保留其频率与理由
                const isTurnSolverCalibrated = !!(result.calibrationSource === 'TexasSolver' || result.isSolverCalibrated);
                if (isTurnSolverCalibrated) {
                    if (ts.primaryTier && ts.primaryTier !== '过牌' && ts.primaryBb > 0 && !result.sizing) {
                        result.sizing = `${ts.primaryTier} (${ts.primaryBb}BB)`;
                    }
                    result.arbitrationSource = 'TURN_SIZING';
                    result.isUnified = true;
                    return result;
                }
                if (ts.primaryTier === '过牌' || ts.action === 'CHECK') {
                    result.primaryAction = 'CHECK';
                    result.sizing = '';
                    const chkF = (ts.frequencies && ts.frequencies.check !== undefined) ? ts.frequencies.check : 90;
                    result.frequencies = closeFrequencies({
                        check: chkF,
                        bet: Math.max(0, 100 - chkF)
                    });
                } else if (ts.primaryTier === 'ALLIN' || ts.action === 'ALLIN') {
                    result.primaryAction = 'BET';
                    result.sizing = (effStack > 0) ? `All-in ${effStack.toFixed(1)}BB（全押）` : '全押';
                    const allinF = (ts.frequencies && ts.frequencies.allin !== undefined) ? ts.frequencies.allin : 75;
                    result.frequencies = closeFrequencies({
                        bet: allinF,
                        check: Math.max(0, 100 - allinF)
                    });
                } else {
                    result.primaryAction = 'BET';
                    result.sizing = `${ts.primaryTier}${ts.primaryBb > 0 ? ` (${ts.primaryBb}BB)` : ''}`;
                    const chkF = (ts.frequencies && ts.frequencies.check !== undefined) ? ts.frequencies.check : 20;
                    result.frequencies = closeFrequencies({
                        bet: Math.max(0, 100 - chkF),
                        check: chkF
                    });
                }
                if (ts.rationale) {
                    const tName = result.turnTransition ? (result.turnTransition.typeName || '') : '';
                    const xrTag = (result.actionLine && result.actionLine.isPostXRNode) ? ' · Check-Raise 第二桶持续施压' : '';
                    result.reasoning = `🔄 [转牌几何规划${tName ? ` · ${tName}` : ''}${xrTag}]：${ts.rationale}`;
                }
                result.arbitrationSource = 'TURN_SIZING';
                result.isUnified = true;
                return result;
            }
        }

        // ── 仲裁优先级 4: 多人底池纯诈唬压制 (Multiway Dynamics Engine) ──
        if (result.multiwayDynamics && result.multiwayDynamics.isMultiway) {
            const mw = result.multiwayDynamics;
            if (!isFacingBet && !mw.pureBluffAllowed && (result.frequencies && result.frequencies.bet > 0)) {
                const equity = (state.equityResult ? state.equityResult.equity : ((result.math && result.math.equity) || 0));
                const isValueHand = equity >= (mw.betThresh || 40);
                const isValidSemiBluff = mw.semiBluffAllowed === true;
                if (!isValueHand && !isValidSemiBluff) {
                    result.primaryAction = 'CHECK';
                    result.sizing = '';
                    result.frequencies = closeFrequencies({ check: 100, bet: 0 });
                    result.reasoning = `👥 [多人底池控池]：${mw.numContenders}人底池严禁空气牌诈唬，100% 采取防守过牌；${result.reasoning || ''}`;
                    result.arbitrationSource = 'MULTIWAY_SUPPRESSION';
                    result.isUnified = true;
                    return result;
                }
            }
        }

        // ── 仲裁优先级 5: 对手画像与剥削偏转融合 (DEF-MW-04: Exploit & Villain Profile) ──
        const vProf = ctx.villainProfile || (state && state.villainProfile) || (result.exploit && result.exploit.profile);
        if (vProf && vProf !== 'balanced') {
            result.villainProfile = vProf;
            // 若包含剥削偏转配置，按画像偏转微调频率
            if (result.exploit && result.exploit.shift && result.frequencies) {
                for (const act of Object.keys(result.exploit.shift)) {
                    if (result.frequencies[act] !== undefined) {
                        result.frequencies[act] = Math.max(0, result.frequencies[act] + result.exploit.shift[act]);
                    }
                }
            }
        }

        // ── 兜底保证：频率严格闭合为 100% ──
        if (result.frequencies) {
            result.frequencies = closeFrequencies(result.frequencies);
        }
        result.arbitrationSource = 'BASE_GTO_ENGINE';
        result.isUnified = true;

        return result;
    }

    return {
        closeFrequencies: closeFrequencies,
        resolveUnifiedDecision: resolveUnifiedDecision
    };
}));
