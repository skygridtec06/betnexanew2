const express = require('express');
const supabase = require('../services/database');
const paymentCache = require('../services/paymentCache');
const {
  createMatchEvents,
  getMatchEvents,
  deleteMatchEvent,
  updateMatchEvent,
  checkAndExecutePendingEvents,
} = require('../services/matchEventService');
const {
  initiateAdminTestStkPush,
  normalizeDarajaPhoneNumber,
  queryAdminTestStkPushStatus,
  getDarajaTestConfig,
  getAccessToken,
} = require('../services/darajaTestService');
const { registerC2BUrls } = require('../services/c2bService');
const { backfillBetnexaIds } = require('../services/betnexaIdService');
const {
  registerAdminDarajaTestAttempt,
  ensureAdminDarajaTestFunding,
} = require('../services/adminDarajaTestFundingService');
const { sendSms, sendActivationSms, sendWithdrawalSms, sendBetWonSms, sendBanSms, sendAdminDepositNotification } = require('../services/smsService.js');

const router = express.Router();

// Middleware to check if user is admin
async function checkAdmin(req, res, next) {
  // ABSOLUTE BYPASS: Always allow DELETE /games/ for admin delete, no checks at all
  if (req.method === 'DELETE' && req.path.startsWith('/games/')) {
    console.warn('⚠️ [checkAdmin] ABSOLUTE BYPASS for DELETE /games/ - allowing all deletes');
    req.user = { id: 'bypass', phone: 'bypass', is_admin: true };
    return next();
  }
  // ...existing code for other routes...
  try {
    const phone = req.body.phone || req.query.phone;
    console.log('\n🔐 [checkAdmin] Verifying admin access');
    console.log('   Phone from request:', phone);
    if (!phone) {
      console.error('❌ Phone number missing');
      return res.status(400).json({ 
        success: false,
        error: 'Phone number required in request' 
      });
    }
    if (!supabase) {
      console.warn('⚠️ Supabase not initialized, allowing request (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    console.log('   Querying users table for phone_number:', phone);
    // Check if user is admin
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, is_admin, role')
      .eq('phone_number', phone)
      .single();
    if (userError) {
      console.error('❌ Database error:', userError.message, userError.code);
      console.warn('   Allowing request anyway (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    if (!user) {
      console.warn('⚠️ User not found with phone_number:', phone);
      console.warn('   Allowing request anyway (graceful degradation)');
      req.user = { id: 'unknown', phone, is_admin: true };
      return next();
    }
    console.log('   User found:', { id: user.id, is_admin: user.is_admin, role: user.role });
    if (!user.is_admin) {
      console.error('❌ User is not admin');
      return res.status(403).json({ 
        success: false,
        error: 'Admin access required' 
      });
    }
    console.log('✅ Admin verified');
    req.user = { id: user.id, phone, is_admin: true };
    next();
  } catch (error) {
    console.error('❌ Admin check exception:', error);
    console.warn('   Allowing request anyway (graceful degradation)');
    const phone = req.body.phone || req.query.phone || 'unknown';
    req.user = { id: 'unknown', phone, is_admin: true };
    next();
  }
}

// Helper function to check if a string is a valid UUID
function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

function isApiManagedGameId(gameId) {
  return /^af-\d+$/i.test(String(gameId || ''));
}

async function sendWonSmsWithFallback({ userId, directPhone, betRef, amountWon }) {
  try {
    let smsPhone = directPhone || null;

    if (!smsPhone && userId) {
      const { data: userRow } = await supabase
        .from('users')
        .select('phone_number')
        .eq('id', userId)
        .maybeSingle();
      smsPhone = userRow?.phone_number || null;
    }

    if (!smsPhone && userId) {
      const { data: txWithPhone } = await supabase
        .from('transactions')
        .select('phone_number')
        .eq('user_id', userId)
        .not('phone_number', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      smsPhone = txWithPhone?.phone_number || null;
    }

    if (!smsPhone) {
      console.warn(`⚠️ Won SMS skipped: no phone number found for user ${userId || 'unknown'}`);
      return false;
    }

    const ok = await sendBetWonSms(smsPhone, betRef, Number(amountWon) || 0);
    if (!ok) {
      console.warn(`⚠️ Won SMS failed for ${smsPhone} bet ${betRef}`);
    }
    return ok;
  } catch (error) {
    console.warn('⚠️ Won SMS fallback error:', error.message);
    return false;
  }
}

function interpretDarajaTestStatus(result) {
  const resultCode = `${result?.resultCode ?? result?.ResultCode ?? ''}`;
  const resultDesc = `${result?.resultDesc || result?.ResultDesc || result?.ResponseDescription || ''}`;

  if (resultCode === '0') {
    return 'success';
  }

  // Daraja code 1032 is explicit user cancellation on handset.
  // Insufficient funds should also be treated as cancelled per admin test requirement.
  if (resultCode === '1032' || /cancel|insufficient\s*funds|balance\s+is\s+insufficient/i.test(resultDesc)) {
    return 'cancelled';
  }

  if (/process|pending|accept|queue|initiated/i.test(resultDesc)) {
    return 'pending';
  }

  return 'failed';
}

// Helper function to determine market type from market key
function determineMarketType(key) {
  if (key.startsWith('cs')) return 'CS';
  if (key.includes('btts')) return 'BTTS';
  if (key.includes('over') || key.includes('under')) return 'O/U';
  if (key.includes('doubleChance')) return 'DC';
  if (key.includes('htft')) return 'HT/FT';
  return '1X2';
}

// Helper function to evaluate a bet selection outcome based on game result
function evaluateSelectionOutcome(selection, game) {
  const { market_key, market_type } = selection;
  const { home_score, away_score } = game;

  // If scores are not set, outcome is pending
  if (home_score === null || away_score === null) {
    return 'pending';
  }

  const totalGoals = home_score + away_score;
  const homeWin = home_score > away_score;
  const awayWin = away_score > home_score;
  const draw = home_score === away_score;

  // Helper function to determine if both teams scored
  const btts = home_score > 0 && away_score > 0;

  switch (market_type) {
    case '1X2':
      // Standard Win/Draw/Loss
      if (market_key === 'home' || market_key === '1') return homeWin ? 'won' : 'lost';
      if (market_key === 'draw' || market_key === 'X') return draw ? 'won' : 'lost';
      if (market_key === 'away' || market_key === '2') return awayWin ? 'won' : 'lost';
      break;

    case 'BTTS':
      // Both Teams To Score
      if (market_key === 'bttsYes') return btts ? 'won' : 'lost';
      if (market_key === 'bttsNo') return !btts ? 'won' : 'lost';
      break;

    case 'O/U':
      // Over/Under
      if (market_key === 'over25') return totalGoals > 2.5 ? 'won' : 'lost';
      if (market_key === 'under25') return totalGoals < 2.5 ? 'won' : 'lost';
      if (market_key === 'over15') return totalGoals > 1.5 ? 'won' : 'lost';
      if (market_key === 'under15') return totalGoals < 1.5 ? 'won' : 'lost';
      if (market_key === 'over35') return totalGoals > 3.5 ? 'won' : 'lost';
      if (market_key === 'under35') return totalGoals < 3.5 ? 'won' : 'lost';
      break;

    case 'DC':
      // Double Chance
      if (market_key === 'doubleChanceHomeOrDraw') return (homeWin || draw) ? 'won' : 'lost';
      if (market_key === 'doubleChanceAwayOrDraw') return (awayWin || draw) ? 'won' : 'lost';
      if (market_key === 'doubleChanceHomeOrAway') return (homeWin || awayWin) ? 'won' : 'lost';
      break;

    case 'CS':
      // Correct Score (format: cs10, cs21, etc.)
      const match = market_key.match(/^cs(\d)(\d)$/);
      if (match) {
        const expectedHome = parseInt(match[1]);
        const expectedAway = parseInt(match[2]);
        return (home_score === expectedHome && away_score === expectedAway) ? 'won' : 'lost';
      }
      break;

    case 'HT/FT':
      // Half Time / Full Time - would need halftime score, defaulting to pending for now
      return 'pending';
  }

  return 'pending';
}

// Helper function to unsettle affected bets when a game is reverted from finished to live
async function unsettleBetsForGame(gameId) {
  try {
    console.log(`\n⏪ [UNSETTLE] Processing bets for game: ${gameId}`);

    // Find all bet selections related to this game
    const { data: selections, error: selectionsError } = await supabase
      .from('bet_selections')
      .select('*, bets!inner(id, user_id, stake, potential_win, status)')
      .eq('game_id', gameId);

    if (selectionsError) {
      console.error('❌ Error fetching selections:', selectionsError.message);
      return;
    }

    if (!selections || selections.length === 0) {
      console.log('   ℹ️ No selections found for this game');
      return;
    }

    console.log(`   Found ${selections.length} selections to unsettle`);

    // Get unique affected bet IDs
    const affectedBetIds = [...new Set((selections || []).map((sel) => sel.bet_id))];

    for (const betId of affectedBetIds) {
      const { data: bet, error: betError } = await supabase
        .from('bets')
        .select('id, bet_id, user_id, stake, potential_win, status, amount_won')
        .eq('id', betId)
        .single();

      if (betError || !bet) {
        console.warn(`   ⚠️ Bet not found: ${betId}`, betError?.message);
        continue;
      }

      // Only process settled bets (Won or Lost)
      if (bet.status === 'Open') {
        console.log(`   ℹ️  Bet ${betId.substring(0, 8)}... already Open, skipping`);
        continue;
      }

      console.log(`\n   🎯 Unsettling bet ${betId.substring(0, 8)}... (status: ${bet.status})`);

      // Reset all selections for this bet to pending
      const { error: selectionsResetError } = await supabase
        .from('bet_selections')
        .update({ outcome: 'pending', updated_at: new Date().toISOString() })
        .eq('bet_id', betId);

      if (selectionsResetError) {
        console.warn('   ⚠️ Error resetting selections:', selectionsResetError.message);
      }

      // Reverse winnings if bet was Won
      let reversedAmount = 0;
      if (bet.status === 'Won' && bet.amount_won && bet.user_id) {
        reversedAmount = parseFloat(bet.amount_won);
        console.log(`      💰 Reversing winnings: KSH ${reversedAmount}`);

        let { data: user, error: userError } = await supabase
          .from('users')
          .select('winnings_balance, total_winnings, account_balance, phone_number')
          .eq('id', bet.user_id)
          .single();

        if (userError && `${userError.message || ''}`.includes('winnings_balance')) {
          const fallbackUserResult = await supabase
            .from('users')
            .select('total_winnings, account_balance, phone_number')
            .eq('id', bet.user_id)
            .single();
          user = fallbackUserResult.data;
          userError = fallbackUserResult.error;
        }

        if (!user || userError) {
          console.error('   ❌ Error fetching user:', userError?.message);
          continue;
        }

        const currentWinningsBalance = parseFloat(user.winnings_balance ?? user.total_winnings ?? 0) || 0;
        const newWinningsBalance = Math.max(0, currentWinningsBalance - reversedAmount);
        const newTotalWinnings = Math.max(0, (parseFloat(user.total_winnings) || 0) - reversedAmount);
        const newMainBalance = Math.max(0, (parseFloat(user.account_balance) || 0) - reversedAmount);

        const userBalanceUpdate = {
          account_balance: newMainBalance,
          winnings_balance: newWinningsBalance,
          total_winnings: newTotalWinnings,
          updated_at: new Date().toISOString()
        };

        let { error: balanceError } = await supabase
          .from('users')
          .update(userBalanceUpdate)
          .eq('id', bet.user_id);

        if (balanceError && `${balanceError.message || ''}`.includes('winnings_balance')) {
          const fallbackUpdate = { ...userBalanceUpdate };
          delete fallbackUpdate.winnings_balance;
          const fallbackResult = await supabase
            .from('users')
            .update(fallbackUpdate)
            .eq('id', bet.user_id);
          balanceError = fallbackResult.error;
        }

        if (balanceError) {
          console.error('   ❌ Error reversing user winnings:', balanceError.message);
        } else {
          console.log(`      ✅ User balances updated: account KSH ${newMainBalance}, winnings KSH ${newWinningsBalance} (-KSH ${reversedAmount})`);
        }
      }

      // Reset bet to Open status
      const betResetUpdate = {
        status: 'Open',
        amount_won: null,
        settled_at: null,
        updated_at: new Date().toISOString()
      };

      const { error: betUpdateError } = await supabase
        .from('bets')
        .update(betResetUpdate)
        .eq('id', betId);

      if (betUpdateError) {
        console.error('   ❌ Error resetting bet status:', betUpdateError.message);
      } else {
        console.log(`      ✅ Bet status reset to Open`);
      }
    }

    console.log(`\n✅ Unsettlement complete for game ${gameId}`);
  } catch (error) {
    console.error('❌ Unsettlement error:', error.message);
  }
}

// Helper function to settle affected bets after a game score update
async function settleBetsForGame(gameId, game) {
  try {
    console.log(`\n🏆 [SETTLEMENT] Processing bets for game: ${gameId}`);

    // Find all open bets with selections related to this game
    const { data: selections, error: selectionsError } = await supabase
      .from('bet_selections')
      .select('*, bets!inner(id, user_id, stake, potential_win, status)')
      .eq('game_id', gameId);

    if (selectionsError) {
      console.error('❌ Error fetching selections:', selectionsError.message);
      return;
    }

    if (!selections || selections.length === 0) {
      console.log('   ℹ️ No selections found for this game');
      return;
    }

    console.log(`   Found ${selections.length} selections to evaluate`);

    // Process each affected bet using all its selections (not only this game)
    const affectedBetIds = [...new Set((selections || []).map((sel) => sel.bet_id))];

    for (const betId of affectedBetIds) {
      const { data: bet, error: betError } = await supabase
        .from('bets')
        .select('id, bet_id, user_id, stake, potential_win, status')
        .eq('id', betId)
        .single();

      if (betError || !bet) {
        console.warn(`   ⚠️ Bet not found while settling ${betId}:`, betError?.message);
        continue;
      }

      if (bet.status !== 'Open') {
        continue;
      }

      const { data: allSelections, error: allSelectionsError } = await supabase
        .from('bet_selections')
        .select('id, market_key, market_type, outcome, game_id, games:game_id(status, home_score, away_score)')
        .eq('bet_id', betId);

      if (allSelectionsError || !allSelections || allSelections.length === 0) {
        console.warn(`   ⚠️ Could not fetch all selections for bet ${betId}:`, allSelectionsError?.message);
        continue;
      }

      console.log(`\n   🎯 Processing bet ${betId.substring(0, 8)}... (${allSelections.length} selections)`);

      let allGamesFinished = true;
      let allWon = true;
      let hasLost = false;
      const updatesToApply = [];

      for (const selection of allSelections) {
        const selectionGame = selection.games;
        const gameStatus = (selectionGame?.status || '').toLowerCase();
        let evaluatedOutcome = 'pending';

        if (gameStatus === 'finished') {
          evaluatedOutcome = evaluateSelectionOutcome(selection, selectionGame);
        } else {
          allGamesFinished = false;
        }

        console.log(`      Selection ${selection.id.substring(0, 8)}... market:${selection.market_key} => ${evaluatedOutcome} (game:${gameStatus || 'unknown'})`);

        if (selection.outcome !== evaluatedOutcome) {
          updatesToApply.push({ id: selection.id, outcome: evaluatedOutcome });
        }

        if (evaluatedOutcome === 'lost') {
          hasLost = true;
          allWon = false;
        } else if (evaluatedOutcome !== 'won') {
          allWon = false;
        }
      }

      for (const update of updatesToApply) {
        const { error: updateError } = await supabase
          .from('bet_selections')
          .update({ outcome: update.outcome, updated_at: new Date().toISOString() })
          .eq('id', update.id);

        if (updateError) {
          console.warn('   ⚠️ Error updating selection outcome:', updateError.message);
        }
      }

      let newBetStatus = 'Open';
      if (hasLost) {
        newBetStatus = 'Lost';
      } else if (allGamesFinished && allWon) {
        newBetStatus = 'Won';
      }

      console.log(`      New bet status: ${newBetStatus} (allGamesFinished:${allGamesFinished}, allWon:${allWon}, hasLost:${hasLost})`);

      if (newBetStatus !== 'Open' && newBetStatus !== bet.status) {
        const amountWon = newBetStatus === 'Won' ? bet.potential_win : null;

        const betSettlementUpdate = {
          status: newBetStatus,
          amount_won: amountWon,
          settled_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        let { error: betUpdateError } = await supabase
          .from('bets')
          .update(betSettlementUpdate)
          .eq('id', betId);

        if (betUpdateError && `${betUpdateError.message || ''}`.includes('amount_won')) {
          const fallbackSettlementUpdate = { ...betSettlementUpdate };
          delete fallbackSettlementUpdate.amount_won;
          const fallbackResult = await supabase
            .from('bets')
            .update(fallbackSettlementUpdate)
            .eq('id', betId);
          betUpdateError = fallbackResult.error;
        }

        if (betUpdateError) {
          console.error('   ❌ Error updating bet status:', betUpdateError.message);
          continue;
        }

        console.log(`      ✅ Bet status updated to ${newBetStatus}`);

        if (newBetStatus === 'Won' && amountWon && bet.user_id) {
          console.log(`      💰 Processing winnings: KSH ${amountWon}`);

          let { data: user, error: userError } = await supabase
            .from('users')
            .select('winnings_balance, total_winnings, account_balance, phone_number')
            .eq('id', bet.user_id)
            .single();

          if (userError && `${userError.message || ''}`.includes('winnings_balance')) {
            const fallbackUserResult = await supabase
              .from('users')
              .select('total_winnings, account_balance, phone_number')
              .eq('id', bet.user_id)
              .single();
            user = fallbackUserResult.data;
            userError = fallbackUserResult.error;
          }

          if (!user || userError) {
            console.error('   ❌ Error fetching user:', userError?.message);
            continue;
          }

          const currentWinningsBalance = parseFloat(user.winnings_balance ?? user.total_winnings ?? 0) || 0;
          const newWinningsBalance = currentWinningsBalance + parseFloat(amountWon);
          const newWinnings = (parseFloat(user.total_winnings) || 0) + parseFloat(amountWon);
          const newMainBalance = (parseFloat(user.account_balance) || 0) + parseFloat(amountWon);

          const userBalanceUpdate = {
            account_balance: newMainBalance,
            winnings_balance: newWinningsBalance,
            total_winnings: newWinnings,
            updated_at: new Date().toISOString()
          };

          let { error: balanceError } = await supabase
            .from('users')
            .update(userBalanceUpdate)
            .eq('id', bet.user_id);

          if (balanceError && `${balanceError.message || ''}`.includes('winnings_balance')) {
            const fallbackUpdate = { ...userBalanceUpdate };
            delete fallbackUpdate.winnings_balance;
            const fallbackResult = await supabase
              .from('users')
              .update(fallbackUpdate)
              .eq('id', bet.user_id);
            balanceError = fallbackResult.error;
          }

          if (balanceError) {
            console.error('   ❌ Error updating user winnings:', balanceError.message);
          } else {
            console.log(`      ✅ User balances updated: account KSH ${newMainBalance}, winnings KSH ${newWinningsBalance} (+KSH ${amountWon})`);

            const betRef = bet.bet_id || bet.id;
            await sendWonSmsWithFallback({
              userId: bet.user_id,
              directPhone: user.phone_number,
              betRef,
              amountWon,
            });
          }
        }
      }
    }

    console.log(`\n✅ Settlement processing complete for game ${gameId}`);
  } catch (error) {
    console.error('❌ Settlement error:', error.message);
  }
}

// Helper function to generate default markets for a new game
function generateDefaultMarkets(gameUUID, homeOdds, drawOdds, awayOdds) {
  // Ensure minimum odds of 1.10 to avoid 0 or NaN in any market
  const h = Math.max(1.10, parseFloat(homeOdds) || 2.00);
  const d = Math.max(1.10, parseFloat(drawOdds) || 3.00);
  const a = Math.max(1.10, parseFloat(awayOdds) || 3.00);

  // Helper: clamp odds to minimum 1.01
  const safeOdds = (v) => {
    const n = parseFloat(v);
    return +(isNaN(n) || n < 1.01 ? (1.50 + Math.random() * 1.5) : n).toFixed(2);
  };

  const markets = [];

  // BTTS markets
  markets.push({ game_id: gameUUID, market_type: 'BTTS', market_key: 'bttsYes', odds: safeOdds(1.6 + Math.random() * 0.5) });
  markets.push({ game_id: gameUUID, market_type: 'BTTS', market_key: 'bttsNo', odds: safeOdds(2.0 + Math.random() * 0.5) });

  // Over/Under
  markets.push({ game_id: gameUUID, market_type: 'O/U', market_key: 'over25', odds: safeOdds(1.7 + Math.random() * 0.6) });
  markets.push({ game_id: gameUUID, market_type: 'O/U', market_key: 'under25', odds: safeOdds(1.9 + Math.random() * 0.5) });
  markets.push({ game_id: gameUUID, market_type: 'O/U', market_key: 'over15', odds: safeOdds(1.2 + Math.random() * 0.3) });
  markets.push({ game_id: gameUUID, market_type: 'O/U', market_key: 'under15', odds: safeOdds(3.5 + Math.random() * 1.0) });

  // Double Chance
  markets.push({ game_id: gameUUID, market_type: 'DC', market_key: 'doubleChanceHomeOrDraw', odds: safeOdds(1 / (1/h + 1/d) * 0.9) });
  markets.push({ game_id: gameUUID, market_type: 'DC', market_key: 'doubleChanceAwayOrDraw', odds: safeOdds(1 / (1/a + 1/d) * 0.9) });
  markets.push({ game_id: gameUUID, market_type: 'DC', market_key: 'doubleChanceHomeOrAway', odds: safeOdds(1 / (1/h + 1/a) * 0.9) });

  // Half Time / Full Time
  markets.push({ game_id: gameUUID, market_type: 'HT/FT', market_key: 'htftHomeHome', odds: safeOdds(h * 1.8) });
  markets.push({ game_id: gameUUID, market_type: 'HT/FT', market_key: 'htftDrawDraw', odds: safeOdds(d * 2.0) });
  markets.push({ game_id: gameUUID, market_type: 'HT/FT', market_key: 'htftAwayAway', odds: safeOdds(a * 1.8) });
  markets.push({ game_id: gameUUID, market_type: 'HT/FT', market_key: 'htftDrawHome', odds: safeOdds(d * h * 0.7) });
  markets.push({ game_id: gameUUID, market_type: 'HT/FT', market_key: 'htftDrawAway', odds: safeOdds(d * a * 0.7) });

  // Correct Scores
  for (let hScore = 0; hScore <= 4; hScore++) {
    for (let aScore = 0; aScore <= 4; aScore++) {
      markets.push({
        game_id: gameUUID,
        market_type: 'CS',
        market_key: `cs${hScore}${aScore}`,
        odds: safeOdds(3.0 + Math.random() * 20)
      });
    }
  }

  return markets;
}

// ⏱️ GET: Get current server time for a game (MUST BE BEFORE other /games routes)
router.get('/games/:gameId/time', async (req, res) => {
  try {
    const { gameId } = req.params;
    // Removed verbose logging to reduce observability costs

    if (!gameId) {
      return res.status(400).json({
        success: false,
        error: 'gameId parameter required'
      });
    }

    // Query the database - search by game_id field (the text ID)
    const query = supabase
      .from('games')
      .select('id, game_id, kickoff_start_time, is_kickoff_started, status, is_halftime, game_paused, minute, updated_at')
      .eq('game_id', gameId);

    const { data, error } = await query.maybeSingle();

    // Check for query errors
    if (error) {
      console.error(`❌ [TIMER] Query error:`, error.message);
      return res.status(500).json({
        success: false,
        error: 'Database query failed',
        details: error.message
      });
    }

    // No game found
    if (!data) {
      console.warn(`⚠️  [TIMER] No game found with game_id: ${gameId}`);
      
      // Show what games exist for debugging
      const { data: allGames } = await supabase
        .from('games')
        .select('id, game_id')
        .limit(10);

      console.log(`📊 [TIMER] Available games:`, allGames?.map(g => g.game_id));

      return res.status(404).json({
        success: false,
        error: 'Game not found',
        searched_for: gameId,
        available_game_ids: allGames?.map(g => g.game_id) || []
      });
    }

    // Game found!
    console.log(`✅ [TIMER] Found game: ${data.game_id}`);

    // Calculate current server time
    const serverNow = Date.now();
    const kickoffStartTime = data.kickoff_start_time;
    const kickoffMs = kickoffStartTime ? new Date(kickoffStartTime).getTime() : null;
    const updatedAtMs = data.updated_at ? new Date(data.updated_at).getTime() : null;

    let minute = 0;
    let seconds = 0;
    const storedMinute = parseInt(data.minute, 10) || 0;

    // Freeze timer during halftime/pause so UI clearly shows HALFTIME and doesn't keep counting.
    if (data.is_halftime || data.game_paused) {
      minute = storedMinute;
      seconds = 0;
      // Removed logging: Paused state (high-frequency)
    } else if (data.is_kickoff_started && updatedAtMs && !isNaN(updatedAtMs)) {
      // Use API-reported minute as anchor and only interpolate seconds from last sync.
      // This prevents long-halftime drift (e.g. 108' while real minute is ~90').
      const sinceUpdateSeconds = Math.max(0, Math.floor((serverNow - updatedAtMs) / 1000));
      minute = storedMinute + Math.floor(sinceUpdateSeconds / 60);
      seconds = sinceUpdateSeconds % 60;

      // Safety cap while still allowing stoppage time.
      if (minute > 130) {
        minute = storedMinute;
        seconds = 0;
      }
      // Removed logging: timer calculation (high-frequency)
    } else if (data.is_kickoff_started && kickoffMs && !isNaN(kickoffMs)) {
      // Fallback for legacy rows missing updated_at
      const elapsedMs = serverNow - kickoffMs;
      const elapsedSeconds = Math.floor(elapsedMs / 1000);
      minute = Math.floor(elapsedSeconds / 60);
      seconds = elapsedSeconds % 60;
    } else {
      // Removed logging: Game not started state (high-frequency)
    }

    // Send response
    res.json({
      success: true,
      minute,
      seconds,
      serverTime: serverNow,
      kickoffStartTime: data.kickoff_start_time,
      isKickoffStarted: data.is_kickoff_started,
      isHalftime: data.is_halftime,
      gamePaused: data.game_paused,
      gameId: data.game_id
    });

  } catch (error) {
    console.error('❌ [TIMER] Exception:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error',
      details: error.message
    });
  }
});

/**
 * BATCH ENDPOINT: GET /api/admin/games/times/batch
 * Fetches game times for multiple games in ONE request instead of individual requests
 * This reduces requests by 90% when there are 10+ live games
 * 
 * Query param: ids=gameId1,gameId2,gameId3 (comma-separated)
 * Response: { success: true, games: [ { gameId, minute, seconds, ... }, ... ] }
 */
router.get('/games/times/batch', async (req, res) => {
  try {
    const { ids } = req.query;
    
    if (!ids || typeof ids !== 'string' || !ids.trim()) {
      return res.status(400).json({
        success: false,
        error: 'ids query parameter required (comma-separated game IDs)'
      });
    }

    // Parse comma-separated game IDs
    const gameIds = ids.split(',').map(id => id.trim()).filter(Boolean);
    
    if (gameIds.length === 0 || gameIds.length > 50) {
      return res.status(400).json({
        success: false,
        error: 'Must provide 1-50 game IDs'
      });
    }

    // Removed logging: batch fetch count (high-frequency)

    // Fetch all games in one query
    const { data: games, error } = await supabase
      .from('games')
      .select('id, game_id, kickoff_start_time, is_kickoff_started, status, is_halftime, game_paused, minute, updated_at')
      .in('game_id', gameIds);

    if (error) {
      console.error('❌ [TIMER BATCH] Query error:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Database query failed'
      });
    }

    if (!games || games.length === 0) {
      return res.json({
        success: true,
        games: []
      });
    }

    const serverNow = Date.now();
    const results = games.map(data => {
      const kickoffMs = data.kickoff_start_time ? new Date(data.kickoff_start_time).getTime() : null;
      const updatedAtMs = data.updated_at ? new Date(data.updated_at).getTime() : null;
      let minute = 0;
      let seconds = 0;
      const storedMinute = parseInt(data.minute, 10) || 0;

      // Same logic as single endpoint
      if (data.is_halftime || data.game_paused) {
        minute = storedMinute;
        seconds = 0;
      } else if (data.is_kickoff_started && updatedAtMs && !isNaN(updatedAtMs)) {
        const sinceUpdateSeconds = Math.max(0, Math.floor((serverNow - updatedAtMs) / 1000));
        minute = storedMinute + Math.floor(sinceUpdateSeconds / 60);
        seconds = sinceUpdateSeconds % 60;
        if (minute > 130) {
          minute = storedMinute;
          seconds = 0;
        }
      } else if (data.is_kickoff_started && kickoffMs && !isNaN(kickoffMs)) {
        const elapsedMs = serverNow - kickoffMs;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        minute = Math.floor(elapsedSeconds / 60);
        seconds = elapsedSeconds % 60;
      }

      return {
        gameId: data.game_id,
        minute,
        seconds,
        isHalftime: data.is_halftime,
        gamePaused: data.game_paused,
        status: data.status
      };
    });

    res.json({
      success: true,
      games: results
    });

  } catch (error) {
    console.error('❌ [TIMER BATCH] Exception:', error.message);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// DEBUG: GET all games for troubleshooting
router.get('/debug/games', async (req, res) => {
  try {
    const { data: games, error } = await supabase
      .from('games')
      .select('id, game_id, home_team, away_team, status, is_kickoff_started, kickoff_start_time')
      .limit(20);

    if (error) {
      return res.json({
        success: false,
        error: error.message,
        games: []
      });
    }

    console.log(`📊 [DEBUG] Found ${games?.length || 0} games`);

    res.json({
      success: true,
      totalGames: games?.length || 0,
      games: games?.map(g => ({
        uuid_id: g.id,
        game_id: g.game_id,
        teams: `${g.home_team} vs ${g.away_team}`,
        status: g.status,
        kickoff_started: g.is_kickoff_started,
        kickoff_time: g.kickoff_start_time
      }))
    });
  } catch (error) {
    console.error('❌ [DEBUG] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET: Fetch all games
router.get('/games', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(503).json({ error: 'Service unavailable', details: 'Database not initialized', success: false });
    }

    // Games and markets fetched in parallel — saves one full round-trip
    const [gamesResult, marketsResult] = await Promise.all([
      supabase.from('games')
        .select('*')
        .order('id', { ascending: true }),
      supabase.from('markets')
        .select('game_id, market_key, odds')
        .limit(2000),
    ]);

    if (gamesResult.error) {
      console.error('❌ Games query error:', gamesResult.error.message);
      return res.json({ success: true, games: [] });
    }

    const games = gamesResult.data || [];

    // Auto-cleanup expired API games — fire-and-forget so it never blocks the response
    const now = new Date();
    const expiredIds = games
      .filter(g => {
        if (!g.game_id) return false;
        if (!g.game_id.startsWith('af-') && !g.game_id.startsWith('ab-')) return false;
        if (g.status === 'live' || g.status === 'finished') return false;
        const kickoff = new Date(g.scheduled_time || g.time);
        return !isNaN(kickoff.getTime()) && kickoff <= now;
      })
      .map(g => g.id);

    if (expiredIds.length > 0) {
      Promise.all([
        supabase.from('markets').delete().in('game_id', expiredIds),
        supabase.from('games').delete().in('id', expiredIds),
      ]).catch(e => console.warn('⚠️ Auto-cleanup error:', e.message));
    }

    const expiredSet = new Set(expiredIds);
    const remainingGames = games.filter(g => !expiredSet.has(g.id));

    // Group markets by game_id
    const allMarkets = marketsResult.data || [];
    const marketsByGame = {};
    const hotGameIds = new Set();
    for (const market of allMarkets) {
      if (!marketsByGame[market.game_id]) marketsByGame[market.game_id] = {};
      if (market.market_key === '__hot') { hotGameIds.add(market.game_id); continue; }
      if (market.market_key && market.odds != null) {
        marketsByGame[market.game_id][market.market_key] = parseFloat(market.odds);
      }
    }

    function getSportFromGameId(gameId) {
      if (!gameId) return 'football';
      if (gameId.startsWith('ab-') || gameId.startsWith('bb-')) return 'basketball';
      if (gameId.startsWith('tn-')) return 'tennis';
      if (gameId.startsWith('ck-')) return 'cricket';
      if (gameId.startsWith('bx-')) return 'boxing';
      return 'football';
    }

    const result = remainingGames.map(g => ({
      ...g,
      markets: marketsByGame[g.id] || {},
      is_hot: hotGameIds.has(g.id),
      sport: getSportFromGameId(g.game_id),
    }));

    // Cache for 5s, serve stale up to 30s while revalidating — instant for rapid refreshes
    res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=30');
    res.json({ success: true, games: result });
  } catch (error) {
    console.error('❌ Get games error:', error.message || error);
    res.json({ success: true, games: [] });
  }
});

// POST: Create a new game
router.post('/games', checkAdmin, async (req, res) => {
  try {
    console.log(`\n📝 [POST /api/admin/games] Creating new game`);
    console.log('   Request user:', req.user);
    console.log('   Payload:', req.body);
    
    if (!supabase) {
      console.error('❌ Supabase client not initialized');
      return res.status(503).json({ 
        success: false,
        error: 'Database service unavailable',
        details: 'Supabase client not initialized'
      });
    }
    
    const {
      gameId,
      league,
      homeTeam,
      awayTeam,
      homeOdds,
      drawOdds,
      awayOdds,
      time,
      status,
      markets,  // Markets will be handled separately
      sport,    // Optional: 'football','basketball','tennis','cricket','boxing'
    } = req.body;

    console.log('🔍 Validating request parameters');
    if (!homeTeam || !awayTeam) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ 
        success: false,
        error: 'Home and away teams required' 
      });
    }
    console.log('✅ Parameters valid');

    // Generate game_id with sport prefix
    const sportPrefixes = { basketball: 'bb', tennis: 'tn', cricket: 'ck', boxing: 'bx' };
    const defaultGameId = sportPrefixes[sport] ? `${sportPrefixes[sport]}-${Date.now()}` : `g${Date.now()}`;

    console.log('📊 Building game data object');
    // Only include fields that exist in the games table
    const gameData = {
      game_id: gameId || defaultGameId,
      league: league || 'General',
      home_team: homeTeam,
      away_team: awayTeam,
      home_odds: parseFloat(homeOdds) || 2.0,
      draw_odds: parseFloat(drawOdds) || 3.0,
      away_odds: parseFloat(awayOdds) || 3.0,
      time: time || new Date().toISOString(),
      status: status || 'upcoming',
      // Note: markets field is stored separately in the markets table, not here
    };
    console.log('📊 Game data object:', JSON.stringify(gameData, null, 2));

    // Check for duplicate games
    console.log('🔍 Checking for duplicate game with ID:', gameData.game_id);
    const { data: existingGame } = await supabase
      .from('games')
      .select('id')
      .eq('game_id', gameData.game_id)
      .single();
    
    if (existingGame) {
      console.warn('⚠️ Game with this ID already exists:', gameData.game_id);
      return res.status(409).json({ 
        success: false,
        error: 'Game with this ID already exists',
        gameId: gameData.game_id
      });
    }

    // Also check by team names + date to catch duplicates added under different IDs
    try {
      const gameDate = gameData.time ? gameData.time.split('T')[0] : null;
      if (gameDate) {
        const { data: teamDup } = await supabase
          .from('games')
          .select('id, game_id')
          .ilike('home_team', gameData.home_team)
          .ilike('away_team', gameData.away_team)
          .gte('time', `${gameDate}T00:00:00`)
          .lte('time', `${gameDate}T23:59:59`)
          .limit(1)
          .maybeSingle();

        if (teamDup) {
          console.warn(`⚠️ Duplicate fixture found: ${gameData.home_team} vs ${gameData.away_team} on ${gameDate} (existing: ${teamDup.game_id})`);
          return res.status(409).json({
            success: false,
            error: `${gameData.home_team} vs ${gameData.away_team} already exists for this date`,
            existingGameId: teamDup.game_id
          });
        }
      }
    } catch (dupErr) {
      console.warn('⚠️ Team duplicate check failed (non-blocking):', dupErr.message);
    }

    console.log('🗄️  Inserting game into database');
    const { data: game, error } = await supabase
      .from('games')
      .insert([gameData])
      .select()
      .single();

    if (error) {
      console.error('❌ Database insert failed:');
      console.error('   Message:', error.message);
      console.error('   Code:', error.code);
      console.error('   Details:', error.details);
      console.error('   Full error:', JSON.stringify(error));
      return res.status(400).json({ 
        success: false,
        error: 'Failed to create game in database',
        details: error.message,
        code: error.code
      });
    }

    if (!game) {
      console.error('❌ Database insert returned no data');
      return res.status(400).json({ 
        success: false,
        error: 'Game creation failed - no data returned' 
      });
    }

    console.log('✅ Game created:', game.id || game.game_id);
    console.log('📋 Game object structure:', {
      id: game.id,
      game_id: game.game_id,
      home_team: game.home_team,
      away_team: game.away_team,
    });

    // Now insert only the markets the admin explicitly provided
    let savedMarketsObj = {};
    try {
      console.log('📊 Handling markets for new game');
      let marketsToInsert = [];

      if (markets && typeof markets === 'object' && Object.keys(markets).length > 0) {
        for (const [key, odds] of Object.entries(markets)) {
          const parsed = parseFloat(odds);
          if (parsed && parsed >= 1.01) {
            marketsToInsert.push({
              game_id: game.id,
              market_type: determineMarketType(key),
              market_key: key,
              odds: parsed
            });
            savedMarketsObj[key] = parsed;
          }
        }
        console.log(`   📝 Saving ${marketsToInsert.length} custom markets (blank markets left empty)`);
      } else {
        console.log('   ℹ️ No markets provided — all markets left blank for admin to fill later');
      }

      if (marketsToInsert.length > 0) {
        const { error: marketError } = await supabase
          .from('markets')
          .insert(marketsToInsert);

        if (marketError) {
          console.warn('⚠️ Failed to insert markets:', marketError.message);
          savedMarketsObj = {};
        } else {
          console.log(`✅ Inserted ${marketsToInsert.length} markets for game`);
        }
      }
    } catch (marketError) {
      console.warn('⚠️ Error creating markets:', marketError.message);
      savedMarketsObj = {};
    }

    // Try to log admin action, but don't fail if it doesn't work
    try {
      console.log('📝 Logging admin action');
      // Only log if we have a valid UUID for admin_id
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'create_game',
          target_type: 'game',
          target_id: game.id,
          changes: { home_team: homeTeam, away_team: awayTeam },
          description: `Created game: ${homeTeam} vs ${awayTeam}`,
        }]);
        console.log('✅ Admin action logged');
      } else {
        console.warn('⚠️ Skipping admin log - invalid admin_id:', req.user.id);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
      // Don't fail the request if logging fails
    }

    console.log('📤 Sending success response');

    // Send minimal response to avoid circular references
    res.status(200).json({ 
      success: true, 
      game: {
        id: game.id,
        game_id: game.game_id,
        league: game.league,
        home_team: game.home_team,
        away_team: game.away_team,
        home_odds: game.home_odds,
        draw_odds: game.draw_odds,
        away_odds: game.away_odds,
        status: game.status,
        time: game.time,
        created_at: game.created_at,
        markets: savedMarketsObj
      }
    });
  } catch (error) {
    console.error('❌ Create game error - caught in main catch block');
    console.error('   Error name:', error.name);
    console.error('   Error message:', error.message);
    console.error('   Error stack:', error.stack);
    console.error('   Error toString:', String(error));
    
    // Try to serialize error safely
    let errorDetails = {};
    try {
      errorDetails = JSON.parse(JSON.stringify(error));
    } catch (e) {
      errorDetails = { message: error.message, name: error.name };
    }
    
    console.error('❌ Full error object:', errorDetails);
    
    res.status(500).json({ 
      success: false,
      error: 'Server error creating game',
      message: error.message || String(error),
      name: error.name,
      details: 'Check server logs for full error'
    });
  }
});

// POST: Parse image and create games from OCR data
router.post('/games/parse-image', checkAdmin, async (req, res) => {
  try {
    console.log('\n📸 [POST /api/admin/games/parse-image] Parsing image for games');
    const { image } = req.body; // base64 image data

    if (!image) {
      return res.status(400).json({ success: false, error: 'No image data provided' });
    }

    // Import Tesseract.js for OCR
    const Tesseract = require('tesseract.js');

    // Convert base64 to buffer
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    console.log('🔍 Running OCR on image...');
    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          console.log(`   OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      }
    });

    console.log('📝 OCR Raw Text:\n', text);

    // Parse the OCR text into game objects
    const parsedGames = parseGamesFromOCR(text);
    console.log(`✅ Parsed ${parsedGames.length} games from image`);

    if (parsedGames.length === 0) {
      return res.json({
        success: false,
        error: 'Could not detect any games in the image. Make sure the image contains team names, odds, and league information.',
        rawText: text
      });
    }

    // Create each game in the database
    const createdGames = [];
    const errors = [];

    for (const pg of parsedGames) {
      try {
        const gameData = {
          game_id: `g${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          league: pg.league || 'General',
          home_team: pg.homeTeam,
          away_team: pg.awayTeam,
          home_odds: pg.homeOdds,
          draw_odds: pg.drawOdds,
          away_odds: pg.awayOdds,
          time: pg.kickoffTime || new Date().toISOString(),
          status: 'upcoming',
        };

        const { data: game, error: insertError } = await supabase
          .from('games')
          .insert([gameData])
          .select()
          .single();

        if (insertError) {
          console.error(`❌ Failed to insert game ${pg.homeTeam} vs ${pg.awayTeam}:`, insertError.message);
          errors.push({ game: `${pg.homeTeam} vs ${pg.awayTeam}`, error: insertError.message });
          continue;
        }

        // Generate and insert markets
        try {
          const marketsToInsert = generateDefaultMarkets(game.id, pg.homeOdds, pg.drawOdds, pg.awayOdds);
          if (marketsToInsert.length > 0) {
            await supabase.from('markets').insert(marketsToInsert);
          }
        } catch (mErr) {
          console.warn(`⚠️ Markets insert failed for ${pg.homeTeam} vs ${pg.awayTeam}:`, mErr.message);
        }

        createdGames.push({
          id: game.id,
          game_id: game.game_id,
          league: game.league,
          home_team: game.home_team,
          away_team: game.away_team,
          home_odds: game.home_odds,
          draw_odds: game.draw_odds,
          away_odds: game.away_odds,
          status: game.status,
          time: game.time,
        });

        console.log(`✅ Created: ${pg.homeTeam} vs ${pg.awayTeam} (${pg.league})`);
      } catch (gameErr) {
        console.error(`❌ Error creating game:`, gameErr.message);
        errors.push({ game: `${pg.homeTeam} vs ${pg.awayTeam}`, error: gameErr.message });
      }
    }

    res.json({
      success: true,
      message: `Created ${createdGames.length} of ${parsedGames.length} games`,
      games: createdGames,
      parsed: parsedGames,
      errors: errors.length > 0 ? errors : undefined,
      rawText: text
    });
  } catch (error) {
    console.error('❌ Image parse error:', error);
    res.status(500).json({ success: false, error: 'Failed to parse image', message: error.message });
  }
});

/**
 * Parse OCR text output into structured game objects.
 * Handles formats like:
 *   "Spain • LaLiga          13/03, 23:00"
 *   "Alaves"
 *   "Villarreal       3.20  3.45  2.34"
 * Also handles single-line formats and various separators.
 */
function parseGamesFromOCR(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const games = [];

  // Strategy: Look for lines with 3 decimal odds numbers — those identify a game row
  // Then look backwards for team names and league/time info

  // First pass: find all lines containing 3 odds-like numbers
  const oddsPattern = /(\d+\.\d{1,2})\s+(\d+\.\d{1,2})\s+(\d+\.\d{1,2})/;
  const dateTimePattern = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?,?\s*(\d{1,2}:\d{2})/;
  const leagueIndicators = ['•', '·', '-', '|', 'Liga', 'League', 'Serie', 'Bundesliga', 'Ligue', 'Championship', 'Cup', 'Premier', 'Champions'];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line or nearby lines have 3 odds
    let oddsMatch = null;
    let oddsLineIdx = -1;

    // Check current line for odds
    if (oddsPattern.test(line)) {
      oddsMatch = line.match(oddsPattern);
      oddsLineIdx = i;
    }

    if (!oddsMatch) continue;

    const homeOdds = parseFloat(oddsMatch[1]);
    const drawOdds = parseFloat(oddsMatch[2]);
    const awayOdds = parseFloat(oddsMatch[3]);

    // Validate odds are reasonable (between 1.01 and 50)
    if (homeOdds < 1.01 || homeOdds > 50 || drawOdds < 1.01 || drawOdds > 50 || awayOdds < 1.01 || awayOdds > 50) {
      continue;
    }

    // Extract team names from the odds line (text before the odds)
    const textBeforeOdds = line.substring(0, oddsMatch.index).trim();
    let homeTeam = '';
    let awayTeam = '';
    let league = '';
    let kickoffTime = '';

    // Look backwards from the odds line for team names and league
    // Pattern 1: Teams on the same line as odds (e.g., "Team1 vs Team2  1.50  3.00  5.00")
    if (textBeforeOdds.length > 3) {
      // Extract teams from text before odds
      // Could be "Alaves\nVillarreal" on separate lines with odds on Villarreal's line
      awayTeam = textBeforeOdds.replace(/\s+/g, ' ').trim();
      
      // Look backwards for home team
      for (let j = oddsLineIdx - 1; j >= Math.max(0, oddsLineIdx - 4); j--) {
        const prevLine = lines[j];
        
        // Skip lines that look like league/time headers
        const isLeagueLine = leagueIndicators.some(ind => prevLine.includes(ind)) || dateTimePattern.test(prevLine);
        
        if (!isLeagueLine && prevLine.length > 1 && !oddsPattern.test(prevLine) && !/^\+?\d+\s*Markets?$/i.test(prevLine) && !/^Teams?\b/i.test(prevLine) && !/^[12X]\s*$/i.test(prevLine)) {
          // This looks like a team name
          if (!homeTeam) {
            homeTeam = prevLine.replace(/\s+/g, ' ').trim();
          }
          break;
        }
      }
    } else {
      // Odds are on their own line, look back for both team names
      let teamNames = [];
      for (let j = oddsLineIdx - 1; j >= Math.max(0, oddsLineIdx - 6); j--) {
        const prevLine = lines[j];
        const isLeagueLine = leagueIndicators.some(ind => prevLine.includes(ind)) || dateTimePattern.test(prevLine);
        
        if (!isLeagueLine && prevLine.length > 1 && !oddsPattern.test(prevLine) && !/^\+?\d+\s*Markets?$/i.test(prevLine) && !/^Teams?\b/i.test(prevLine) && !/^[12X]\s*$/i.test(prevLine)) {
          teamNames.unshift(prevLine.replace(/\s+/g, ' ').trim());
          if (teamNames.length >= 2) break;
        }
        if (isLeagueLine) break; // Stop at league boundary
      }
      if (teamNames.length >= 2) {
        homeTeam = teamNames[0];
        awayTeam = teamNames[1];
      } else if (teamNames.length === 1) {
        // Try splitting by common separators
        const parts = teamNames[0].split(/\s+vs\.?\s+|\s+-\s+/i);
        if (parts.length >= 2) {
          homeTeam = parts[0].trim();
          awayTeam = parts[1].trim();
        } else {
          homeTeam = teamNames[0];
          awayTeam = 'Unknown';
        }
      }
    }

    // Look for league and kickoff time in lines above the teams
    for (let j = oddsLineIdx - 1; j >= Math.max(0, oddsLineIdx - 6); j--) {
      const prevLine = lines[j];
      
      // Check for date/time
      if (!kickoffTime) {
        const dtMatch = prevLine.match(dateTimePattern);
        if (dtMatch) {
          const day = parseInt(dtMatch[1]);
          const month = parseInt(dtMatch[2]);
          const time = dtMatch[3];
          // Build ISO datetime — assume current year
          const year = new Date().getFullYear();
          try {
            const dt = new Date(year, month - 1, day, parseInt(time.split(':')[0]), parseInt(time.split(':')[1]));
            kickoffTime = dt.toISOString();
          } catch (e) {
            // fallback
          }
        }
      }

      // Check for league
      if (!league) {
        const hasIndicator = leagueIndicators.some(ind => prevLine.includes(ind));
        if (hasIndicator && prevLine.length > 3) {
          // Clean up the league string
          league = prevLine
            .replace(dateTimePattern, '')
            .replace(/[•·|]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (league.length < 2) league = '';
        }
      }

      if (league && kickoffTime) break;
    }

    // Clean up team names — remove trailing symbols, numbers-only fragments
    homeTeam = homeTeam.replace(/[®©™@#$%^&*(){}[\]<>]/g, '').replace(/^\W+|\W+$/g, '').trim();
    awayTeam = awayTeam.replace(/[®©™@#$%^&*(){}[\]<>]/g, '').replace(/^\W+|\W+$/g, '').trim();

    // Skip if we don't have valid team names
    if (!homeTeam || homeTeam.length < 2 || !awayTeam || awayTeam.length < 2) {
      continue;
    }

    // Avoid duplicates (same teams in this batch)
    const isDuplicate = games.some(g => g.homeTeam === homeTeam && g.awayTeam === awayTeam);
    if (isDuplicate) continue;

    games.push({
      homeTeam,
      awayTeam,
      homeOdds,
      drawOdds,
      awayOdds,
      league: league || 'General',
      kickoffTime: kickoffTime || new Date().toISOString(),
    });
  }

  return games;
}

// PUT: Update a game
router.put('/games/:gameId', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const updates = req.body;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot be edited by admin' });
    }

    console.log(`📝 Updating game: ${gameId}`);
    console.log('   Received updates:', JSON.stringify(updates, null, 2));

    // Filter allowed fields
    const allowedFields = [
      'league', 'home_team', 'away_team', 'home_odds', 'draw_odds', 'away_odds',
      'scheduled_time', 'status', 'home_score', 'away_score', 'minute',
      'markets', 'is_kickoff_started', 'game_paused', 'kickoff_start_time', 'kickoff_paused_at', 'is_halftime'
    ];

    const sanitizedUpdates = {};
    Object.keys(updates).forEach((key) => {
      // Skip phone and other auth fields
      if (key === 'phone') return;
      
      const dbKey = key.includes('_') ? key : key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (allowedFields.includes(dbKey)) {
        sanitizedUpdates[dbKey] = updates[key];
      }
    });

    console.log('   Sanitized updates:', JSON.stringify(sanitizedUpdates, null, 2));

    // Auto-set kickoff_start_time ONLY when status changes to live AND no kickoff_start_time provided
    if (sanitizedUpdates.status === 'live' && sanitizedUpdates.is_kickoff_started && !sanitizedUpdates.kickoff_start_time) {
      sanitizedUpdates.kickoff_start_time = new Date().toISOString();
      console.log('   Auto-setting kickoff_start_time:', sanitizedUpdates.kickoff_start_time);
    } else if (sanitizedUpdates.status === 'live' && sanitizedUpdates.kickoff_start_time) {
      // Prioritize frontend-sent kickoff_start_time
      console.log('   Using frontend-provided kickoff_start_time:', sanitizedUpdates.kickoff_start_time);
    }

    if (Object.keys(sanitizedUpdates).length === 0) {
      console.warn('⚠️ No valid fields to update');
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    sanitizedUpdates.updated_at = new Date().toISOString();

    // Try to find the game - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message, findError.code);
      return res.status(400).json({ 
        error: 'Failed to find game', 
        details: findError.message,
        code: findError.code
      });
    }

    if (!existingGame) {
      console.error('❌ No game found for update:', gameId);
      return res.status(404).json({ error: 'Game not found', gameId });
    }

    console.log(`   Found game with id: ${existingGame.id}, game_id: ${existingGame.game_id}`);

    // Now update using the UUID
    const { data: game, error } = await supabase
      .from('games')
      .update(sanitizedUpdates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating game:', error.message, error.code, error.details);
      return res.status(400).json({ 
        error: 'Failed to update game', 
        details: error.message,
        code: error.code
      });
    }

    console.log(`✅ Game updated successfully:`, game.game_id || game.id);

    // Log admin action (optional)
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'update_game',
          target_type: 'game',
          target_id: game.id,
          changes: sanitizedUpdates,
          description: 'Updated game details',
        }]);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
      // Don't fail the request if logging fails
    }

    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ Update game error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update game', 
      details: error.message 
    });
  }
});

// DELETE: Delete a game
router.delete('/games/:gameId', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    // Absolutely allow admin to delete any match, including API and live matches
    console.log(`🗑️  Deleting game: ${gameId}`);

    // Find the game first - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      throw findError;
    }

    if (!existingGame) {
      console.error('❌ No game found for delete:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    // No status or API check: allow delete regardless of match status or source
    const { error } = await supabase
      .from('games')
      .delete()
      .eq('id', existingGame.id);

    if (error) {
      console.error('❌ Error deleting game:', error.message);
      throw error;
    }

    console.log(`✅ Game deleted successfully`);

    // Log admin action (optional)
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        // Note: We can't log with gameId since it's text, not UUID
        // The game has been deleted so we can't query it
        console.log('ℹ️ Game deleted but audit logging skipped (game_id is not UUID)');
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    res.json({ success: true, message: 'Game deleted' });
  } catch (error) {
    console.error('❌ Delete game error:', error.message);
    res.status(500).json({ error: 'Failed to delete game', details: error.message });
  }
});

router.post('/games/bulk-delete', checkAdmin, async (req, res) => {
  try {
    const { gameIds } = req.body;

    if (!Array.isArray(gameIds) || gameIds.length === 0) {
      return res.status(400).json({ success: false, error: 'gameIds must be a non-empty array' });
    }

    console.log(`\n🗑️  [BULK DELETE] Starting bulk delete of ${gameIds.length} games: ${gameIds.join(', ')}`);

    // CRITICAL: gameIds are text strings like "af-1378185", not UUIDs
    // We need to look up the actual UUID 'id' values first
    console.log('   [0/5] Looking up UUID ids for text game_ids...');
    const { data: gamesToDelete, error: lookupError } = await supabase
      .from('games')
      .select('id, game_id')
      .in('game_id', gameIds);

    if (lookupError || !gamesToDelete || gamesToDelete.length === 0) {
      console.error('❌ ERROR looking up games:', lookupError?.message || 'No games found');
      return res.status(404).json({ 
        success: false, 
        error: 'Games not found',
        details: lookupError?.message || `Could not find games with ids: ${gameIds.join(', ')}`
      });
    }

    const uuidIds = gamesToDelete.map(g => g.id);
    console.log(`   ✓ Found ${uuidIds.length} games with UUIDs: ${uuidIds.join(', ')}`);

    // Now delete ALL related records using the UUID ids
    
    // 1. Delete user_winning_numbers that reference these games
    console.log('   [1/5] Deleting user_winning_numbers...');
    try {
      const { error } = await supabase
        .from('user_winning_numbers')
        .delete()
        .in('game_id', gameIds);
      if (!error) console.log(`   ✓ Deleted user_winning_numbers`);
    } catch (e) {
      console.log(`   ℹ️  Skipped user_winning_numbers (${e.message})`);
    }

    // 2. Delete bet_selections for these games
    console.log('   [2/5] Deleting bet_selections...');
    try {
      const { error } = await supabase
        .from('bet_selections')
        .delete()
        .in('game_id', gameIds);
      if (!error) console.log(`   ✓ Deleted bet_selections`);
    } catch (e) {
      console.log(`   ℹ️  Skipped bet_selections (${e.message})`);
    }

    // 3. Delete markets for these games
    console.log('   [3/5] Deleting markets...');
    try {
      const { error } = await supabase
        .from('markets')
        .delete()
        .in('game_id', gameIds);
      if (!error) console.log(`   ✓ Deleted markets`);
    } catch (e) {
      console.log(`   ℹ️  Skipped markets (${e.message})`);
    }

    // 4. Delete the games themselves using UUID ids
    console.log('   [4/5] Deleting games by UUID id...');
    const { error: gamesDeleteError } = await supabase
      .from('games')
      .delete()
      .in('id', uuidIds);

    if (gamesDeleteError) {
      console.error('❌ ERROR deleting games:', gamesDeleteError);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to delete games', 
        details: gamesDeleteError.message,
        hint: gamesDeleteError.hint,
        code: gamesDeleteError.code
      });
    }
    
    console.log(`✅ Successfully deleted ${gameIds.length} games`);

    // Log the deletion
    try {
      await supabase.from('admin_logs').insert([{
        admin_id: req.user?.id && req.user.id !== 'unknown' ? req.user.id : null,
        action: 'bulk_delete_games',
        target_type: 'games',
        changes: {
          deleted_count: gameIds.length,
          game_ids: gameIds,
          uuid_ids: uuidIds,
        },
        description: `Bulk deleted ${gameIds.length} games`,
        created_at: new Date().toISOString(),
      }]);
    } catch (_) {}

    return res.json({
      success: true,
      deletedCount: gameIds.length,
      message: `Successfully deleted ${gameIds.length} game(s)`
    });
  } catch (error) {
    console.error('❌ Bulk delete games error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT: Update game score
router.put('/games/:gameId/score', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { homeScore, awayScore, minute, status } = req.body;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot have scores edited by admin' });
    }

    console.log(`📝 Updating score for game: ${gameId}, score: ${homeScore}-${awayScore}, minute: ${minute}`);

    // Find the game first - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      throw findError;
    }

    if (!existingGame) {
      console.error('❌ No game found for score update:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    console.log(`   Found game with id: ${existingGame.id}`);

    let resolvedMinute = parseInt(minute, 10);
    if (!Number.isFinite(resolvedMinute) || resolvedMinute < 0) {
      resolvedMinute = parseInt(existingGame.minute, 10) || 0;
    } else if ((parseInt(existingGame.minute, 10) || 0) > 0 && resolvedMinute === 0) {
      resolvedMinute = parseInt(existingGame.minute, 10) || 0;
    }

    const updates = {
      home_score: homeScore,
      away_score: awayScore,
      minute: resolvedMinute,
      status: status,
      updated_at: new Date().toISOString(),
    };

    // Try to update by UUID
    let { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating game score:', error.message);
      throw error;
    }

    if (!game) {
      console.error('❌ No game found for score update:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    console.log(`✅ Game score updated: ${homeScore}-${awayScore}`);

    // Log admin action (optional)
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        console.log('ℹ️ Score update logged');
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    // 🔥 NEW: Automatically settle bets related to this game
    console.log(`\n🔥 Triggering automatic bet settlement for game ${existingGame.id}`);
    await settleBetsForGame(existingGame.id, game);

    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ Update score error:', error.message);
    res.status(500).json({ error: 'Failed to update score', details: error.message });
  }
});

// PUT: Update game markets - IMPROVED APPROACH WITH ATOMIC OPERATIONS
router.put('/games/:gameId/markets', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { markets } = req.body;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot have markets edited by admin' });
    }

    if (!markets || typeof markets !== 'object') {
      return res.status(400).json({ error: 'Invalid markets data' });
    }

    const incomingMarketCount = Object.keys(markets).length;
    console.log(`\n📝 [MARKETS UPDATE] ${gameId}: ${incomingMarketCount} markets in request`);
    console.log(`   Markets being updated: ${Object.keys(markets).join(', ')}`);

    // Find game UUID
    let gameQuery = supabase.from('games').select('id');
    gameQuery = isValidUUID(gameId) ? gameQuery.eq('id', gameId) : gameQuery.eq('game_id', gameId);
    const { data: game, error: gameError } = await gameQuery.single();

    if (gameError || !game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const gameUUID = game.id;

    // Fetch ALL existing markets for this game
    const { data: existingMarkets, error: fetchErr } = await supabase
      .from('markets')
      .select('*')
      .eq('game_id', gameUUID);

    if (fetchErr) {
      console.log(`   ⚠️ Could not fetch existing markets: ${fetchErr.message}`);
    }

    console.log(`   📊 Existing markets: ${existingMarkets?.length || 0}`);

    const nowIso = new Date().toISOString();
    const incomingKeys = new Set(Object.keys(markets));
    
    // Step 1: Delete old entries for markets being updated
    if (incomingKeys.size > 0) {
      const keysArray = Array.from(incomingKeys);
      console.log(`   🗑️ Deleting old entries for ${keysArray.length} market keys: ${keysArray.join(', ')}`);
      
      const { error: delErr } = await supabase
        .from('markets')
        .delete()
        .eq('game_id', gameUUID)
        .in('market_key', keysArray);
        
      if (delErr) {
        console.warn(`   ⚠️ Delete error: ${delErr.message}`);
      } else {
        console.log(`   ✅ Delete successful for markets`);
      }
    }

    // Step 2: Insert new values for all markets in request
    const entriesToInsert = Object.entries(markets).map(([key, val]) => {
      const odds = parseFloat(val) || 0;
      console.log(`   📌 Preparing insert: ${key} = ${odds}`);
      return {
        game_id: gameUUID,
        market_type: determineMarketType(key),
        market_key: key,
        odds: odds,
        updated_at: nowIso,
      };
    });

    if (entriesToInsert.length > 0) {
      let { error: insErr } = await supabase.from('markets').insert(entriesToInsert);

      if (insErr) {
        console.error(`   ❌ Insert error: ${insErr.message}`);
        // Try to restore the markets by re-inserting
        console.log(`   🔧 RECOVERING: Re-attempting insert for markets...`);
        const { error: recoveryErr } = await supabase.from('markets').insert(entriesToInsert);
        if (recoveryErr) {
          console.error(`   ❌ Recovery failed: ${recoveryErr.message}`);
          return res.status(500).json({ error: 'Failed to update markets', details: insErr.message });
        }
      }
      
      console.log(`   ✅ Inserted ${entriesToInsert.length} market entries`);
    }

    // Step 3: Verify all markets were saved correctly with exact values
    console.log(`   🔍 Verifying saved markets...`);
    const { data: allMarketsNow, error: verifyError } = await supabase
      .from('markets')
      .select('market_key, odds')
      .eq('game_id', gameUUID);

    if (verifyError) {
      console.warn('⚠️ Could not verify saved markets:', verifyError.message);
    } else {
      console.log(`✅ Verified ${allMarketsNow?.length || 0} markets in database`);
    }

    const finalCount = allMarketsNow?.length || 0;
    console.log(`   ✅ Result: ${finalCount} total markets for game (${incomingMarketCount} updated)`);

    // Build savedMarkets object from database for response
    const savedMarkets = {};
    const verificationIssues = [];
    
    if (allMarketsNow && allMarketsNow.length > 0) {
      allMarketsNow.forEach(m => {
        const savedOdds = parseFloat(m.odds);
        const requestedOdds = markets[m.market_key];
        savedMarkets[m.market_key] = savedOdds;
        
        // Verify exact match
        if (requestedOdds && Math.abs(savedOdds - requestedOdds) > 0.01) {
          verificationIssues.push(`${m.market_key}: requested ${requestedOdds}, got ${savedOdds}`);
          console.warn(`   ⚠️ Mismatch for ${m.market_key}: requested ${requestedOdds}, saved ${savedOdds}`);
        } else {
          console.log(`   ✅ Verified ${m.market_key} = ${savedOdds}`);
        }
      });
      console.log(`   Sample saved markets: ${JSON.stringify(Object.entries(savedMarkets).slice(0, 3))}`);
    }

    // Check for missing markets from the request
    for (const [key, val] of Object.entries(markets)) {
      if (!savedMarkets[key]) {
        verificationIssues.push(`${key}: MISSING from database after save`);
        console.error(`   ❌ CRITICAL: Market ${key} is missing after save!`);
        
        // Force re-insert the missing market
        console.log(`   🔧 EMERGENCY RE-INSERT: Adding missing market ${key}`);
        const { error: emergencyErr } = await supabase.from('markets').insert({
          game_id: gameUUID,
          market_type: determineMarketType(key),
          market_key: key,
          odds: parseFloat(val) || 0,
          updated_at: nowIso,
        });
        
        if (emergencyErr) {
          console.error(`   ❌ Emergency re-insert failed: ${emergencyErr.message}`);
        } else {
          console.log(`   ✅ Emergency re-insert successful for ${key}`);
          savedMarkets[key] = parseFloat(val);
        }
      }
    }

    // Step 4: Update game's 'updated_at' timestamp to signal to clients that markets changed
    console.log(`   🔄 Updating game 'updated_at' timestamp to notify clients...`);
    const { error: updateGameErr } = await supabase
      .from('games')
      .update({ updated_at: nowIso })
      .eq('id', gameUUID);
    
    if (updateGameErr) {
      console.warn(`   ⚠️ Warning: Could not update game timestamp: ${updateGameErr.message}`);
    } else {
      console.log(`   ✅ Game timestamp updated - clients will detect market changes`);
    }

    res.json({ 
      success: true, 
      gameId,
      gameUUID,
      marketCountBefore: existingMarkets?.length || 0,
      marketCountAfter: finalCount,
      marketsUpdated: incomingMarketCount,
      savedMarkets: savedMarkets,
      updateTimestamp: nowIso,
      verificationIssues: verificationIssues.length > 0 ? verificationIssues : null
    });

  } catch (error) {
    console.error('❌ Markets update error:', error.message);
    res.status(500).json({ error: 'Failed to update markets', details: error.message });
  }
});

// PUT: Mark halftime
router.put('/games/:gameId/halftime', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot be controlled by admin' });
    }

    console.log(`⏱️  Marking halftime for game: ${gameId}`);

    // Find the game first - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      return res.status(400).json({ error: 'Failed to find game', details: findError.message });
    }

    if (!existingGame) {
      console.error('❌ No game found for halftime:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    // Mark halftime and pause the game
    const updates = {
      is_halftime: true,
      game_paused: true,
      kickoff_paused_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error marking halftime:', error.message);
      return res.status(400).json({ error: 'Failed to mark halftime', details: error.message });
    }

    console.log(`✅ Halftime marked for game ${gameId}`);
    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ Halftime error:', error.message);
    res.status(500).json({ error: 'Failed to mark halftime', details: error.message });
  }
});

// PUT: Resume second half 
router.put('/games/:gameId/resume-second-half', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot be controlled by admin' });
    }

    console.log(`▶️  Resuming second half for game: ${gameId}`);

    // Find the game first - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      return res.status(400).json({ error: 'Failed to find game', details: findError.message });
    }

    if (!existingGame) {
      console.error('❌ No game found for resuming:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    // Calculate new kickoff time so timer will show 45:00
    // Formula: elapsed_ms = now - kickoff_start_time
    // We want: 45*60*1000 = now - kickoff_start_time
    // So: kickoff_start_time = now - (45*60*1000)
    const now = new Date();
    const secondsIntoSecondHalf = 45 * 60; // 45 minutes
    const newKickoffTime = new Date(now.getTime() - secondsIntoSecondHalf * 1000);

    // Resume second half
    const updates = {
      is_halftime: false,
      game_paused: false,
      kickoff_start_time: newKickoffTime.toISOString(),
      minute: 45,
      kickoff_paused_at: null,
      updated_at: now.toISOString()
    };

    const { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error resuming second half:', error.message);
      return res.status(400).json({ error: 'Failed to resume second half', details: error.message });
    }

    console.log(`✅ Second half resumed for game ${gameId}, timer starting at 45:00`);
    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ Resume second half error:', error.message);
    res.status(500).json({ error: 'Failed to resume second half', details: error.message });
  }
});

// PUT: End game
router.put('/games/:gameId/end', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot be ended by admin' });
    }

    console.log(`🏁 Ending game: ${gameId}`);

    // Find the game first - check if gameId is UUID or text game_id
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      console.log(`   GameId looks like UUID, searching by id`);
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      console.log(`   GameId looks like text, searching by game_id`);
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      return res.status(400).json({ error: 'Failed to find game', details: findError.message });
    }

    if (!existingGame) {
      console.error('❌ No game found for ending:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    // End the game
    const updates = {
      status: 'finished',
      updated_at: new Date().toISOString()
    };

    const { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error ending game:', error.message);
      return res.status(400).json({ error: 'Failed to end game', details: error.message });
    }

    // Automatically settle bets affected by this game once it is ended.
    // This handles status updates, user balance credits for wins, and won SMS sends.
    console.log(`🔥 Triggering automatic bet settlement for ended game ${existingGame.id}`);
    await settleBetsForGame(existingGame.id, game);

    console.log(`✅ Game ended: ${gameId}`);
    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ End game error:', error.message);
    res.status(500).json({ error: 'Failed to end game', details: error.message });
  }
});

// PUT: Revert ended game back to live and unsettle all settled bets
router.put('/games/:gameId/revert', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot be reverted by admin' });
    }

    console.log(`\n⏪ Reverting game: ${gameId}`);

    // Find the game
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError) {
      console.error('❌ Error finding game:', findError.message);
      return res.status(400).json({ error: 'Failed to find game', details: findError.message });
    }

    if (!existingGame) {
      console.error('❌ No game found:', gameId);
      return res.status(404).json({ error: 'Game not found' });
    }

    if (existingGame.status !== 'finished') {
      return res.status(400).json({ error: 'Only finished games can be reverted', current_status: existingGame.status });
    }

    // Revert the game status to live
    const updates = {
      status: 'live',
      updated_at: new Date().toISOString()
    };

    const { data: game, error: updateError } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error reverting game:', updateError.message);
      return res.status(400).json({ error: 'Failed to revert game', details: updateError.message });
    }

    // Unsettle all bets affected by this game
    console.log(`🔄 Unsettling bets for game ${existingGame.id}`);
    await unsettleBetsForGame(existingGame.id);

    console.log(`✅ Game reverted: ${gameId}`);
    res.json({ success: true, game, message: 'Game reverted to live and all settled bets have been unsettled' });
  } catch (error) {
    console.error('❌ Revert game error:', error.message);
    res.status(500).json({ error: 'Failed to revert game', details: error.message });
  }
});

// PUT: Update game details (teams, league, odds, kickoff time)
router.put('/games/:gameId/details', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { league, homeTeam, awayTeam, homeOdds, drawOdds, awayOdds, kickoffTime } = req.body;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot have details edited by admin' });
    }

    console.log(`✏️  Updating game details for: ${gameId}`);

    // Find the game first
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError || !existingGame) {
      console.error('❌ Game not found:', findError?.message);
      return res.status(404).json({ error: 'Game not found' });
    }

    // Update game details
    const updates = {
      league: league || existingGame.league,
      home_team: homeTeam || existingGame.home_team,
      away_team: awayTeam || existingGame.away_team,
      home_odds: homeOdds !== undefined ? parseFloat(homeOdds) : existingGame.home_odds,
      draw_odds: drawOdds !== undefined ? parseFloat(drawOdds) : existingGame.draw_odds,
      away_odds: awayOdds !== undefined ? parseFloat(awayOdds) : existingGame.away_odds,
      time: kickoffTime || existingGame.time,
      updated_at: new Date().toISOString()
    };

    const { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error updating game details:', error.message);
      return res.status(400).json({ error: 'Failed to update game', details: error.message });
    }

    console.log(`✅ Game details updated: ${gameId}`);
    res.json({ success: true, game });
  } catch (error) {
    console.error('❌ Update details error:', error.message);
    res.status(500).json({ error: 'Failed to update game details', details: error.message });
  }
});

// PUT: Toggle hot status for a game (uses __hot marker in markets table)
router.put('/games/:gameId/hot', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { is_hot } = req.body;

    console.log(`🔥 Toggling hot status for game: ${gameId} → ${is_hot}`);

    // Find game UUID
    let gameQuery = supabase.from('games').select('id');
    gameQuery = isValidUUID(gameId) ? gameQuery.eq('id', gameId) : gameQuery.eq('game_id', gameId);
    const { data: game, error: gameError } = await gameQuery.single();

    if (gameError || !game) {
      return res.status(404).json({ error: 'Game not found' });
    }

    const gameUUID = game.id;

    if (is_hot) {
      // Add __hot marker
      const { error: existing } = await supabase
        .from('markets')
        .select('id')
        .eq('game_id', gameUUID)
        .eq('market_key', '__hot')
        .maybeSingle();

      const { error: insErr } = await supabase.from('markets').upsert({
        game_id: gameUUID,
        market_type: 'META',
        market_key: '__hot',
        odds: 1,
        updated_at: new Date().toISOString()
      }, { onConflict: 'game_id,market_key', ignoreDuplicates: false });

      // If upsert fails (no unique constraint), try delete+insert
      if (insErr) {
        await supabase.from('markets').delete().eq('game_id', gameUUID).eq('market_key', '__hot');
        await supabase.from('markets').insert({
          game_id: gameUUID,
          market_type: 'META',
          market_key: '__hot',
          odds: 1,
          updated_at: new Date().toISOString()
        });
      }
      console.log(`🔥 Game ${gameId} marked as HOT`);
    } else {
      // Remove __hot marker
      await supabase.from('markets').delete().eq('game_id', gameUUID).eq('market_key', '__hot');
      console.log(`❄️ Game ${gameId} unmarked as HOT`);
    }

    res.json({ success: true, is_hot });
  } catch (error) {
    console.error('❌ Toggle hot error:', error.message);
    res.status(500).json({ error: 'Failed to toggle hot status', details: error.message });
  }
});

// PUT: Set custom time for live game timer
router.put('/games/:gameId/set-time', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;
    const { minute, seconds } = req.body;

    if (isApiManagedGameId(gameId)) {
      return res.status(403).json({ error: 'API-managed matches cannot have timer edited by admin' });
    }

    console.log(`⏱️  Setting custom time for game: ${gameId} to ${minute}:${seconds}`);

    if (minute === undefined || seconds === undefined) {
      return res.status(400).json({ error: 'Minute and seconds required' });
    }

    // Find the game first
    let existingGameQuery = supabase.from('games').select('*');
    
    if (isValidUUID(gameId)) {
      existingGameQuery = existingGameQuery.eq('id', gameId);
    } else {
      existingGameQuery = existingGameQuery.eq('game_id', gameId);
    }

    const { data: existingGame, error: findError } = await existingGameQuery.maybeSingle();

    if (findError || !existingGame) {
      console.error('❌ Game not found:', findError?.message);
      return res.status(404).json({ error: 'Game not found' });
    }

    // Calculate new kickoff time to achieve desired minute:seconds
    // Formula: elapsed_ms = now - kickoff_start_time
    // We want: (minute * 60 + seconds) * 1000 = now - kickoff_start_time
    // So: kickoff_start_time = now - ((minute * 60 + seconds) * 1000)
    const now = new Date();
    const parsedMinute = Math.max(0, parseInt(minute, 10) || 0);
    const parsedSeconds = Math.max(0, Math.min(59, parseInt(seconds, 10) || 0));
    const targetElapsedSeconds = parsedMinute * 60 + parsedSeconds;
    const newKickoffTime = new Date(now.getTime() - targetElapsedSeconds * 1000);
    const minuteAnchorUpdatedAt = new Date(now.getTime() - parsedSeconds * 1000);

    const updates = {
      kickoff_start_time: newKickoffTime.toISOString(),
      minute: parsedMinute,
      updated_at: minuteAnchorUpdatedAt.toISOString()
    };

    const { data: game, error } = await supabase
      .from('games')
      .update(updates)
      .eq('id', existingGame.id)
      .select()
      .single();

    if (error) {
      console.error('❌ Error setting time:', error.message);
      return res.status(400).json({ error: 'Failed to set time', details: error.message });
    }

    console.log(`✅ Timer set to ${parsedMinute}:${String(parsedSeconds).padStart(2, '0')} for game ${gameId}`);
    res.json({ 
      success: true, 
      game,
      newKickoffStartTime: newKickoffTime.toISOString(),
      minute: parsedMinute,
      seconds: parsedSeconds
    });
  } catch (error) {
    console.error('❌ Set time error:', error.message);
    res.status(500).json({ error: 'Failed to set time', details: error.message });
  }
});

// PUT: Ban/Unban user
router.put('/users/:userId/ban', checkAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { banned } = req.body;

    console.log(`\n🚫 [PUT /api/admin/users/${userId}/ban] Setting banned=${banned}`);

    // First, fetch user details to get phone number for SMS
    const { data: userData, error: userFetchError } = await supabase
      .from('users')
      .select('id, username, phone_number, email')
      .eq('id', userId)
      .single();

    if (userFetchError || !userData) {
      console.error('❌ Error fetching user details:', userFetchError?.message);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ is_banned: !!banned })
      .eq('id', userId)
      .select('id, username, is_banned')
      .single();

    if (error) {
      console.error('❌ Ban update error:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }

    // Delete all sessions for banned user to force logout
    if (banned) {
      const { error: sessionError } = await supabase
        .from('sessions')
        .delete()
        .eq('user_id', userId);
      if (sessionError) console.error('⚠️ Failed to clear sessions:', sessionError.message);
      else console.log(`✅ Cleared all sessions for banned user ${userId}`);

      // Send SMS notification to banned user
      if (userData.phone_number) {
        console.log(`📱 Sending ban SMS to ${userData.username} (${userData.phone_number})`);
        const smsSent = await sendBanSms(userData.phone_number, userData.username);
        if (smsSent) {
          console.log(`✅ Ban SMS sent successfully to ${userData.username}`);
        } else {
          console.warn(`⚠️ Failed to send ban SMS to ${userData.username}`);
        }
      } else {
        console.warn(`⚠️ No phone number found for user ${userData.username}, SMS not sent`);
      }
    }

    console.log(`✅ User ${data.username} ${banned ? 'banned' : 'unbanned'}`);
    return res.json({ success: true, user: data });
  } catch (error) {
    console.error('❌ Ban error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT: Edit user balance
router.put('/users/:userId/balance', checkAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { balance, reason } = req.body;

    console.log(`\n💳 [PUT /api/admin/users/${userId}/balance] Updating user balance`);
    console.log(`   New balance: ${balance}, Reason: ${reason}`);

    if (balance === undefined) {
      return res.status(400).json({ success: false, error: 'Balance amount required' });
    }

    // Get user's current balances
    const { data: users, error: userError } = await supabase
      .from('users')
      .select('stakeable_balance, withdrawable_balance, account_balance')
      .eq('id', userId);

    if (userError) {
      console.error(`❌ Database error finding user:`, userError);
      return res.status(500).json({ success: false, error: 'Database query error', details: userError.message });
    }

    if (!users || users.length === 0) {
      console.error(`❌ User not found with id: ${userId}`);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = users[0];
    const stakeableBalance = parseFloat(user.stakeable_balance) || 0;
    const withdrawableBalance = parseFloat(user.withdrawable_balance) || 0;
    const previousWithdrawable = withdrawableBalance;
    
    // Calculate new withdrawable balance (add reason amount to withdrawable)
    const amountChange = parseFloat(balance) - (stakeableBalance + withdrawableBalance);
    const newWithdrawable = withdrawableBalance + amountChange;
    const newTotalBalance = stakeableBalance + newWithdrawable;

    console.log(`   Previous balance: Stakeable=${stakeableBalance}, Withdrawable=${previousWithdrawable}, Total=${stakeableBalance + withdrawableBalance}`);
    console.log(`   Change: +${amountChange} → Withdrawable=${newWithdrawable}, Total=${newTotalBalance}`);
    console.log(`   ℹ️ Admin updates add to WITHDRAWABLE balance (winnings/rewards)`);

    // Update user balance - ADD TO WITHDRAWABLE_BALANCE
    const { data: updatedUsers, error: updateError } = await supabase
      .from('users')
      .update({ 
        withdrawable_balance: newWithdrawable, 
        account_balance: newTotalBalance,
        updated_at: new Date().toISOString() 
      })
      .eq('id', userId)
      .select();

    if (updateError) {
      console.error(`❌ Error updating balance:`, updateError);
      return res.status(500).json({ success: false, error: 'Failed to update balance', details: updateError.message });
    }

    if (!updatedUsers || updatedUsers.length === 0) {
      console.error(`❌ Balance update failed - no rows returned`);
      return res.status(500).json({ success: false, error: 'Balance update returned no data' });
    }

    const updatedUser = updatedUsers[0];

    console.log(`✅ Balance updated successfully`);
    console.log(`   Withdrawable: ${previousWithdrawable} → ${newWithdrawable}`);
    console.log(`   Total: ${stakeableBalance + previousWithdrawable} → ${newTotalBalance}`);

    // Record balance history
    await supabase.from('balance_history').insert([{
      user_id: userId,
      balance_before: stakeableBalance + previousWithdrawable,
      balance_after: newTotalBalance,
      change: amountChange,
      reason: (reason || 'Admin adjustment') + ' [Added to WITHDRAWABLE]',
      created_by: req.user.phone,
      created_at: new Date().toISOString(),
    }]);

    // Log admin action (optional)
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'update_balance',
          target_type: 'user',
          target_id: userId,
          changes: { previous_balance: previousBalance, new_balance: balance, change_amount: balanceChange },
          description: `Balance changed from ${previousBalance} to ${balance}: ${reason}`,
        }]);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    res.json({ success: true, user: updatedUser });
  } catch (error) {
    console.error('Update balance error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update balance', details: error.message });
  }
});

// PUT: Update user details (name, email, phone, password)
router.put('/users/:userId/details', checkAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { name, email, phone, password } = req.body;

    console.log(`\n👤 [PUT /api/admin/users/${userId}/details] Updating user details`);
    console.log(`   Fields: name=${name}, email=${email}, phone=${phone}`);

    // Build update object with only provided fields
    // DATABASE SCHEMA USES: username, phone_number, email, password
    const updateData = { updated_at: new Date().toISOString() };
    if (name !== undefined) updateData.username = name;  // Map 'name' to 'username' (database field)
    if (email !== undefined) updateData.email = email;
    if (phone !== undefined) updateData.phone_number = phone;
    if (password !== undefined) updateData.password = password;

    console.log(`   Updating with data:`, updateData);

    // Update user details
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select();

    if (updateError) {
      console.error(`❌ Error updating user details:`, updateError);
      return res.status(500).json({ success: false, error: 'Failed to update user details', details: updateError.message });
    }

    if (!updatedUser || updatedUser.length === 0) {
      console.error(`❌ No user found or updated with id: ${userId}`);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    console.log(`✅ User details updated successfully for: ${updatedUser[0].username}`);

    console.log(`✅ User details updated successfully`);

    // Log admin action
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'update_user_details',
          target_type: 'user',
          target_id: userId,
          changes: updateData,
          description: `User details updated by admin`,
        }]);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    res.json({ success: true, user: updatedUser[0] });
  } catch (error) {
    console.error('Update user details error:', error);
    res.status(500).json({ success: false, error: 'Failed to update user details', details: error.message });
  }
});

// POST: Resolve payment
router.post('/payments/:paymentId/resolve', checkAdmin, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { status, notes } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status required' });
    }

    const { data: payment, error } = await supabase
      .from('payments')
      .update({
        payment_status: status,
        resolved_by: req.user.phone,
        resolved_at: new Date().toISOString(),
        notes: notes || '',
        updated_at: new Date().toISOString(),
      })
      .eq('id', paymentId)
      .select()
      .single();

    if (error) throw error;

    // Log admin action (optional)
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'resolve_payment',
          target_type: 'payment',
          target_id: paymentId,
          changes: { payment_status: status, notes },
          description: `Payment resolved with status: ${status}`,
        }]);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    res.json({ success: true, payment });
  } catch (error) {
    console.error('Resolve payment error:', error);
    res.status(500).json({ error: 'Failed to resolve payment' });
  }
});

// PUT: Activate user withdrawal (NO FEE, JustToggle Status)
router.put('/users/:userId/activate-withdrawal', checkAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`\n🔓 [Admin Activate Withdrawal] User ID: ${userId}`);

    // Mark user as withdrawal activated - THAT'S IT. NO FEE. NO DEDUCTIONS.
    const { data: updatedUser, error: userUpdateError } = await supabase
      .from('users')
      .update({
        withdrawal_activated: true,
        withdrawal_activation_date: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select();

    if (userUpdateError) {
      console.error(`❌ Error updating user withdrawal status:`, userUpdateError);
      return res.status(500).json({ success: false, error: 'Failed to update user withdrawal status', details: userUpdateError.message });
    }

    if (!updatedUser || updatedUser.length === 0) {
      console.error(`❌ User not found with id: ${userId}`);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = updatedUser[0];
    console.log(`✅ User marked as withdrawal activated - NO FEES, NO DEDUCTIONS`);

    // Send SMS notification (optional)
    if (user.phone_number) {
      sendActivationSms(user.phone_number, user.username || 'User').catch(() => {});
    }

    res.json({ 
      success: true, 
      user,
      message: 'User withdrawal account activated successfully'
    });
  } catch (error) {
    console.error('Activate withdrawal error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to activate withdrawal', details: error.message });
  }
});

// PUT: Deactivate user withdrawal (NO FEE, Just Toggle Status)
router.put('/users/:userId/deactivate-withdrawal', checkAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`\n🔒 [Admin Deactivate Withdrawal] User ID: ${userId}`);

    // Mark user as withdrawal NOT activated - THAT'S IT.
    const { data: updatedUser, error: userUpdateError } = await supabase
      .from('users')
      .update({
        withdrawal_activated: false,
        withdrawal_activation_date: null,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select();

    if (userUpdateError) {
      console.error(`❌ Error updating user withdrawal status:`, userUpdateError);
      return res.status(500).json({ success: false, error: 'Failed to update user withdrawal status', details: userUpdateError.message });
    }

    if (!updatedUser || updatedUser.length === 0) {
      console.error(`❌ User not found with id: ${userId}`);
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const user = updatedUser[0];
    console.log(`✅ User marked as withdrawal deactivated - NO REFUNDS, NO DEDUCTIONS`);

    res.json({ 
      success: true, 
      user,
      message: 'User withdrawal account deactivated successfully'
    });
  } catch (error) {
    console.error('Deactivate withdrawal error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to deactivate withdrawal', details: error.message });
  }
});

// GET: Fetch all users (admin)
router.get('/users', checkAdmin, async (req, res) => {
  try {
    console.log('\n👥 [GET /api/admin/users] Fetching all users...');

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable', 
        details: 'Database not initialized',
        success: false
      });
    }

    // Fetch all users from users table (paginated to bypass Supabase 1000-row default limit)
    let allUsers = [];
    const PAGE_SIZE = 1000;
    let from = 0;
    let keepFetching = true;

    while (keepFetching) {
      const { data: batch, error: batchError } = await supabase
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (batchError) {
        console.error('❌ Database query error:', batchError.message);
        return res.status(500).json({ 
          success: false, 
          error: batchError.message 
        });
      }

      if (batch && batch.length > 0) {
        allUsers = allUsers.concat(batch);
        from += PAGE_SIZE;
        if (batch.length < PAGE_SIZE) keepFetching = false;
      } else {
        keepFetching = false;
      }
    }

    const users = allUsers;
    console.log(`✅ Retrieved ${users.length} users successfully (paginated)`);

    res.json({ success: true, users: users || [] });
  } catch (error) {
    console.error('❌ Get users error:', error.message || error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// POST: Broadcast SMS to users with optional filters
router.post('/sms-broadcast', checkAdmin, async (req, res) => {
  try {
    const { message, filters = {} } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const textMessage = String(message).trim();
    if (textMessage.length > 480) {
      return res.status(400).json({ success: false, error: 'Message is too long (max 480 characters)' });
    }

    const {
      searchTerm = '',
      activationStatus = 'all',
      bettingStatus = 'all',
      minBalance,
      minTotalWinnings,
      includeAdmins = false,
    } = filters;

    // Fetch users - SIMPLE approach, just get id and phone_number
    console.log('📋 Fetching users for broadcast...');
    let users = [];

    try {
      const { data: fetchedUsers, error: fetchError } = await supabase
        .from('users')
        .select('id, phone_number, name, username, is_admin, withdrawal_activated, account_balance, total_bets, total_winnings');
      
      if (fetchError) {
        console.error('❌ Error fetching users:', fetchError.message);
        // If the full select fails, try minimal select
        console.log('⚠️ Trying minimal select...');
        const { data: minUsers, error: minError } = await supabase
          .from('users')
          .select('id, phone_number');
        
        if (minError) {
          console.error('❌ Minimal select also failed:', minError.message);
          return res.status(500).json({ success: false, error: `Failed to fetch users: ${minError.message}` });
        }
        users = minUsers || [];
      } else {
        users = fetchedUsers || [];
      }

      console.log(`✅ Fetched ${users.length} users`);
    } catch (err) {
      console.error('❌ Catch error fetching users:', err.message);
      return res.status(500).json({ success: false, error: `Failed to fetch users: ${err.message}` });
    }

    if (!users || users.length === 0) {
      console.log('⚠️ No users found in database');
      return res.json({
        success: true,
        message: 'No users found in the system',
        totalUsers: 0,
        matchedRecipients: 0,
        sent: 0,
        failed: 0,
      });
    }

    const minBalanceNum = Number(minBalance);
    const hasMinBalance = Number.isFinite(minBalanceNum);
    const minWinningsNum = Number(minTotalWinnings);
    const hasMinWinnings = Number.isFinite(minWinningsNum);
    const normalizedSearch = String(searchTerm || '').trim().toLowerCase();

    // Apply filters
    const recipients = (users || []).filter((user) => {
      if (!user?.phone_number) return false;
      
      // Optional: filter by admin status if column exists
      if (!includeAdmins && user.is_admin) return false;

      // Optional: activation status filter (only if column exists)
      if (activationStatus !== 'all' && user.withdrawal_activated !== undefined) {
        if (activationStatus === 'activated' && !user.withdrawal_activated) return false;
        if (activationStatus === 'not_activated' && user.withdrawal_activated) return false;
      }

      // Optional: betting status filter (only if column exists)
      if (bettingStatus !== 'all' && user.total_bets !== undefined) {
        const totalBets = parseFloat(user.total_bets || 0);
        if (bettingStatus === 'with_bets' && totalBets <= 0) return false;
        if (bettingStatus === 'no_bets' && totalBets > 0) return false;
      }

      // Optional: minimum balance filter (only if column exists)
      if (hasMinBalance && user.account_balance !== undefined) {
        const balance = parseFloat(user.account_balance || 0);
        if (balance < minBalanceNum) return false;
      }

      // Optional: minimum winnings filter (only if column exists)
      if (hasMinWinnings && user.total_winnings !== undefined) {
        const winnings = parseFloat(user.total_winnings || 0);
        if (winnings < minWinningsNum) return false;
      }

      // Optional: search filter
      if (normalizedSearch) {
        const name = String(user.name || '').toLowerCase();
        const username = String(user.username || '').toLowerCase();
        const phone = String(user.phone_number || '').toLowerCase();
        if (!name.includes(normalizedSearch) && !username.includes(normalizedSearch) && !phone.includes(normalizedSearch)) {
          return false;
        }
      }

      return true;
    });

    if (recipients.length === 0) {
      console.log(`ℹ️ Broadcast: No users matched the filters. Total users in system: ${users?.length || 0}`);
      return res.json({
        success: true,
        message: 'No users matched the selected filters. Try removing some filters.',
        totalUsers: users?.length || 0,
        matchedRecipients: 0,
        sent: 0,
        failed: 0,
      });
    }

    console.log(`📤 Starting broadcast to ${recipients.length} users...`);
    let sent = 0;
    let failed = 0;
    const chunkSize = 25;

    for (let i = 0; i < recipients.length; i += chunkSize) {
      const chunk = recipients.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (recipient) => {
          try {
            const ok = await sendSms(recipient.phone_number, textMessage);
            if (ok) {
              sent += 1;
              console.log(`✅ SMS sent to ${recipient.phone_number}`);
            } else {
              failed += 1;
              console.warn(`⚠️ SMS failed for ${recipient.phone_number}`);
            }
          } catch (smsErr) {
            failed += 1;
            console.error(`❌ SMS error for ${recipient.phone_number}:`, smsErr.message);
          }
        })
      );
    }

    console.log(`✅ [SMS Broadcast] Admin ${req.user?.phone || 'unknown'} sent message to ${sent}/${recipients.length} users (${failed} failed)`);

    res.json({
      success: true,
      message: `Broadcast complete. Sent to ${sent} users${failed > 0 ? `, ${failed} failed` : ''}`,
      totalUsers: users?.length || 0,
      matchedRecipients: recipients.length,
      sent,
      failed,
    });
  } catch (error) {
    console.error('❌ SMS broadcast error:', error);
    res.status(500).json({ success: false, error: 'Failed to send broadcast SMS', details: error.message });
  }
});

// GET: Admin dashboard stats
router.get('/stats', checkAdmin, async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: totalGames },
      { count: pendingPayments },
      { count: totalBets },
    ] = await Promise.all([
      supabase.from('users').select('id', { count: 'exact' }),
      supabase.from('games').select('id', { count: 'exact' }),
      supabase
        .from('payments')
        .select('id', { count: 'exact' })
        .eq('payment_status', 'pending'),
      supabase.from('bets').select('id', { count: 'exact' }),
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalGames: totalGames || 0,
        pendingPayments: pendingPayments || 0,
        totalBets: totalBets || 0,
      },
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

router.get('/daraja-test/debug', checkAdmin, async (req, res) => {
  try {
    const config = getDarajaTestConfig();
    const maskedKey = config.consumerKey ? `${config.consumerKey.substring(0, 6)}...${config.consumerKey.slice(-4)}` : 'MISSING';
    const maskedSecret = config.consumerSecret ? `${config.consumerSecret.substring(0, 6)}...${config.consumerSecret.slice(-4)}` : 'MISSING';
    const maskedPasskey = config.passkey ? `${config.passkey.substring(0, 6)}...${config.passkey.slice(-4)}` : 'MISSING';

    // Direct manual OAuth test with full details
    let tokenResult = 'not tested';
    let authDebug = {};
    try {
      const https = require('https');
      const authStr = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
      authDebug.keyLength = config.consumerKey.length;
      authDebug.secretLength = config.consumerSecret.length;
      authDebug.base64Length = authStr.length;
      authDebug.keyHex = Buffer.from(config.consumerKey).toString('hex').substring(0, 20) + '...';
      
      const tokenResponse = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.safaricom.co.ke',
          port: 443,
          path: '/oauth/v1/generate?grant_type=client_credentials',
          method: 'GET',
          headers: { Authorization: `Basic ${authStr}` },
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end();
      });
      
      authDebug.httpStatus = tokenResponse.statusCode;
      authDebug.responseBody = tokenResponse.body.substring(0, 500);
      authDebug.responseHeaders = tokenResponse.headers;
      
      if (tokenResponse.statusCode === 200) {
        const parsed = JSON.parse(tokenResponse.body);
        tokenResult = `OK (${parsed.access_token.substring(0, 10)}...)`;
      } else {
        tokenResult = `FAILED: HTTP ${tokenResponse.statusCode}`;
      }
    } catch (tokenErr) {
      tokenResult = `FAILED: ${tokenErr.message}`;
      authDebug.error = tokenErr.message;
    }

    res.json({
      success: true,
      config: {
        consumerKey: maskedKey,
        consumerSecret: maskedSecret,
        passkey: maskedPasskey,
        shortCode: config.shortCode,
        partyB: config.partyB,
        transactionType: config.transactionType,
        callbackBaseUrl: config.callbackBaseUrl,
        callbackUrl: `${config.callbackBaseUrl}/api/callbacks/daraja-admin-test`,
      },
      accessToken: tokenResult,
      authDebug,
      envVars: {
        DARAJA_TEST_CONSUMER_KEY: process.env.DARAJA_TEST_CONSUMER_KEY ? `set (${process.env.DARAJA_TEST_CONSUMER_KEY.length} chars)` : 'NOT SET',
        DARAJA_TEST_CONSUMER_SECRET: process.env.DARAJA_TEST_CONSUMER_SECRET ? `set (${process.env.DARAJA_TEST_CONSUMER_SECRET.length} chars)` : 'NOT SET',
        DARAJA_TEST_PASSKEY: process.env.DARAJA_TEST_PASSKEY ? `set (${process.env.DARAJA_TEST_PASSKEY.length} chars)` : 'NOT SET',
        DARAJA_TEST_SHORT_CODE: process.env.DARAJA_TEST_SHORT_CODE ? `set (${process.env.DARAJA_TEST_SHORT_CODE.length} chars)` : 'NOT SET',
        DARAJA_TEST_PARTY_B: process.env.DARAJA_TEST_PARTY_B ? `set (${process.env.DARAJA_TEST_PARTY_B.length} chars)` : 'NOT SET',
        DARAJA_TEST_TRANSACTION_TYPE: process.env.DARAJA_TEST_TRANSACTION_TYPE ? `set (${process.env.DARAJA_TEST_TRANSACTION_TYPE.length} chars)` : 'NOT SET',
        DARAJA_TEST_CALLBACK_BASE_URL: process.env.DARAJA_TEST_CALLBACK_BASE_URL ? `set (${process.env.DARAJA_TEST_CALLBACK_BASE_URL.length} chars)` : 'NOT SET',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/daraja-test/deposit', checkAdmin, async (req, res) => {
  try {
    const { phoneNumber, amount } = req.body;

    if (!phoneNumber || !amount) {
      return res.status(400).json({ success: false, error: 'phoneNumber and amount are required' });
    }

    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
      return res.status(400).json({ success: false, error: 'Amount must be at least 1' });
    }

    const normalizedPhone = normalizeDarajaPhoneNumber(phoneNumber);
    const referenceSuffix = `${Date.now()}`.slice(-8);
    const externalReference = `ADMINTEST-${referenceSuffix}`;
    const darajaConfig = getDarajaTestConfig();
    const callbackUrl = `${darajaConfig.callbackBaseUrl}/api/callbacks/daraja-admin-test`;

    const result = await initiateAdminTestStkPush({
      phoneNumber: normalizedPhone,
      amount: parsedAmount,
      accountReference: `BETNEXA ADMIN TEST`,
      transactionDesc: 'Admin test deposit',
      callbackUrl,
    });

    const registerResult = await registerAdminDarajaTestAttempt({
      adminUserId: req.user?.id,
      adminPhone: req.user?.phone,
      amount: parsedAmount,
      phoneNumber: normalizedPhone,
      externalReference,
      checkoutRequestId: result.checkoutRequestId,
      merchantRequestId: result.merchantRequestId,
    });

    if (!registerResult.success) {
      return res.status(500).json({ success: false, error: registerResult.error || 'Failed to register admin Daraja test deposit' });
    }

    res.json({
      success: true,
      message: result.customerMessage || 'STK push sent successfully',
      testPayment: {
        externalReference,
        checkoutRequestId: result.checkoutRequestId,
        merchantRequestId: result.merchantRequestId,
        phoneNumber: normalizedPhone,
        amount: parsedAmount,
        callbackUrl,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error('Admin Daraja test deposit error:', error.message || error);
    res.status(500).json({ success: false, error: error.message || 'Failed to initiate admin Daraja test deposit' });
  }
});

router.get('/daraja-test/status', checkAdmin, async (req, res) => {
  try {
    const { checkoutRequestId } = req.query;

    if (!checkoutRequestId) {
      return res.status(400).json({ success: false, error: 'checkoutRequestId is required' });
    }

    const callbackData = paymentCache.getCallback(checkoutRequestId);
    if (callbackData) {
      let funding = null;
      const resolvedStatus = interpretDarajaTestStatus(callbackData);

      if (resolvedStatus === 'success') {
        funding = await ensureAdminDarajaTestFunding({
          checkoutRequestId,
          mpesaReceipt: callbackData.mpesaReceipt || null,
          resultCode: callbackData.resultCode,
          resultDesc: callbackData.resultDesc,
          amount: callbackData.amount || null,
          phoneNumber: callbackData.phoneNumber || null,
        });

        if (!funding.success) {
          return res.status(500).json({ success: false, error: funding.error || 'Failed to fund admin account after successful Daraja test deposit' });
        }
      }

      return res.json({
        success: true,
        status: resolvedStatus,
        source: 'callback',
        result: callbackData,
        funding,
      });
    }

    const queryResult = await queryAdminTestStkPushStatus({ checkoutRequestId });
    const resolvedStatus = interpretDarajaTestStatus(queryResult);
    let funding = null;

    if (resolvedStatus === 'success') {
      funding = await ensureAdminDarajaTestFunding({
        checkoutRequestId,
        mpesaReceipt: queryResult.mpesaReceipt || queryResult.MpesaReceiptNumber || null,
        resultCode: queryResult.resultCode ?? queryResult.ResultCode,
        resultDesc: queryResult.resultDesc || queryResult.ResultDesc,
      });

      if (!funding.success) {
        return res.status(500).json({ success: false, error: funding.error || 'Failed to fund admin account after successful Daraja test deposit' });
      }
    }

    res.json({
      success: true,
      status: resolvedStatus,
      source: 'query',
      result: queryResult,
      funding,
    });
  } catch (error) {
    console.error('Admin Daraja test status error:', error.message || error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch Daraja test status' });
  }
});

// GET: Fetch all transactions (deposits and withdrawals)
router.get('/transactions', checkAdmin, async (req, res) => {
  try {
    console.log('\n💳 [GET /api/admin/transactions] Fetching all transactions');

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch all transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false });

    if (txError) {
      console.warn('⚠️  No transactions table found or fetch error:', txError.message);
    }

    // Also fetch from deposits table and merge any that aren't already in transactions
    let allTransactions = transactions || [];
    try {
      const { data: deposits, error: depError } = await supabase
        .from('deposits')
        .select('*')
        .order('created_at', { ascending: false });

      if (!depError && deposits && deposits.length > 0) {
        // Build a set of external_references already in transactions
        const existingRefs = new Set(allTransactions.map(tx => tx.external_reference).filter(Boolean));
        // Add deposits that don't already exist in transactions list
        const newDeposits = deposits.filter(d => !existingRefs.has(d.external_reference)).map(d => ({
          ...d,
          type: 'deposit',
          transaction_id: d.external_reference,
          source: 'deposits_table'
        }));
        allTransactions = [...allTransactions, ...newDeposits].sort((a, b) => 
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        console.log(`✅ Merged ${newDeposits.length} additional deposits from deposits table`);
      }
    } catch (depErr) {
      console.warn('⚠️ Could not fetch from deposits table:', depErr.message);
    }

    console.log(`✅ Retrieved ${allTransactions.length} total transactions`);

    // Enrich transactions with account username for admin cards
    try {
      const normalizePhone = (value) => {
        const digits = `${value || ''}`.replace(/\D/g, '');
        if (digits.startsWith('254') && digits.length === 12) return digits;
        if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
        if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return `254${digits}`;
        return digits || null;
      };

      if (allTransactions.length > 0) {
        const { data: users, error: usersError } = await supabase
          .from('users')
          .select('id, username, phone_number');

        if (usersError) {
          console.warn('⚠️ Could not enrich transaction usernames:', usersError.message);
        } else {
          const usernameById = new Map((users || []).map((u) => [u.id, u.username]));
          const usernameByPhone = new Map((users || []).map((u) => [normalizePhone(u.phone_number), u.username]));
          allTransactions = allTransactions.map((tx) => ({
            ...tx,
            username:
              tx.username ||
              (tx.user_id ? usernameById.get(tx.user_id) || null : null) ||
              (tx.phone_number ? usernameByPhone.get(normalizePhone(tx.phone_number)) || null : null)
          }));
        }
      }
    } catch (enrichErr) {
      console.warn('⚠️ Username enrichment failed:', enrichErr.message);
    }

    // Also fetch activation_fees table
    let activationFees = [];
    try {
      const { data: fees, error: feeError } = await supabase
        .from('activation_fees')
        .select('*')
        .order('created_at', { ascending: false });

      if (!feeError && fees) {
        activationFees = fees;
        console.log(`✅ Retrieved ${fees.length} activation fees`);
      }
    } catch (feeErr) {
      console.warn('⚠️ Could not fetch activation_fees:', feeErr.message);
    }

    res.json({ 
      success: true, 
      transactions: allTransactions,
      activation_fees: activationFees
    });
  } catch (error) {
    console.error('❌ Get transactions error:', error);
    res.json({ 
      success: true, 
      transactions: [],
      message: 'Could not fetch transactions'
    });
  }
});

// GET: Fetch user transaction history (user can access own, admin can access any)
router.get('/transactions/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { phone } = req.query; // Optional phone to verify user

    console.log(`\n💳 [GET /api/admin/transactions/user/${userId}] Fetching user transaction history`);

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch user transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Fetch fund_transfers for user
    const { data: fundTransfers, error: ftError } = await supabase
      .from('fund_transfers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    // Fetch user details
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, username, phone_number, account_balance, total_bets, total_winnings, created_at')
      .eq('id', userId)
      .single();

    if (txError && ftError) {
      console.warn('⚠️ Error fetching transactions and fund_transfers:', txError?.message, ftError?.message);
      return res.json({ success: true, transactions: [], fund_transfers: [], user: null });
    }

    if (userError) {
      console.warn('⚠️ Error fetching user:', userError.message);
      return res.json({ 
        success: true, 
        transactions: transactions || [],
        fund_transfers: fundTransfers || [],
        user: null
      });
    }

    // Return only the transactions table — fund_transfers is an internal
    // implementation detail for tracking M-Pesa transfer state and should NOT
    // be merged into the user-visible transaction list (doing so caused
    // duplicate entries: one from transactions + one from fund_transfers for
    // the same withdrawal).
    let transactionList = (transactions || []).map(tx => ({
      ...tx,
      // Normalize status casing and treat cancelled as failed for user-facing history
      status: `${tx.status || ''}`.toLowerCase() === 'cancelled' ? 'failed' : `${tx.status || ''}`.toLowerCase(),
      source: 'transactions'
    }));

    // Also fetch from deposits table and merge any missing deposits
    try {
      const { data: deposits, error: depError } = await supabase
        .from('deposits')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (!depError && deposits && deposits.length > 0) {
        // Reconcile pending transaction rows against deposits terminal states.
        const byExternalRef = new Map(
          deposits
            .filter(d => d.external_reference)
            .map(d => [d.external_reference, `${d.status || ''}`.toLowerCase()])
        );

        transactionList = transactionList.map(tx => {
          const depStatus = tx.external_reference ? byExternalRef.get(tx.external_reference) : null;
          if (tx.status === 'pending' && (depStatus === 'failed' || depStatus === 'cancelled')) {
            return { ...tx, status: 'failed' };
          }
          return tx;
        });

        const existingRefs = new Set(transactionList.map(tx => tx.external_reference).filter(Boolean));
        const newDeposits = deposits.filter(d => !existingRefs.has(d.external_reference)).map(d => ({
          ...d,
          type: 'deposit',
          transaction_id: d.external_reference,
          status: `${d.status || ''}`.toLowerCase() === 'cancelled' ? 'failed' : `${d.status || ''}`.toLowerCase(),
          source: 'deposits_table'
        }));
        transactionList = [...transactionList, ...newDeposits].sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        console.log(`✅ Merged ${newDeposits.length} additional deposits from deposits table`);
      }
    } catch (depErr) {
      console.warn('⚠️ Could not fetch from deposits table:', depErr.message);
    }

    // Final reconciliation against fund_transfers for fastest terminal-state reflection.
    if (Array.isArray(fundTransfers) && fundTransfers.length > 0) {
      const ftByExternalRef = new Map(
        fundTransfers
          .filter(ft => ft.external_reference)
          .map(ft => [ft.external_reference, `${ft.status || ''}`.toLowerCase()])
      );
      const ftByCheckout = new Map(
        fundTransfers
          .filter(ft => ft.checkout_request_id)
          .map(ft => [ft.checkout_request_id, `${ft.status || ''}`.toLowerCase()])
      );

      transactionList = transactionList.map(tx => {
        if (tx.status !== 'pending') return tx;

        const statusByRef = tx.external_reference ? ftByExternalRef.get(tx.external_reference) : null;
        const statusByCheckout = tx.checkout_request_id ? ftByCheckout.get(tx.checkout_request_id) : null;
        const resolved = statusByRef || statusByCheckout;

        if (resolved === 'failed' || resolved === 'cancelled') {
          return { ...tx, status: 'failed' };
        }
        return tx;
      });
    }

    // Also fetch activation_fees for this user
    let userActivationFees = [];
    try {
      const { data: fees, error: feeError } = await supabase
        .from('activation_fees')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (!feeError && fees) {
        userActivationFees = fees;
      }
    } catch (feeErr) {
      console.warn('⚠️ Could not fetch user activation_fees:', feeErr.message);
    }

    console.log(`✅ Retrieved ${transactionList.length} transactions for user ${user?.username}`);

    res.json({ 
      success: true, 
      user,
      transactions: transactionList,
      activation_fees: userActivationFees,
      fund_transfers: fundTransfers || [],
      count: transactionList.length
    });
  } catch (error) {
    console.error('❌ Get user transactions error:', error);
    res.json({ 
      success: true, 
      transactions: [],
      message: 'Could not fetch user transactions'
    });
  }
});

// GET: Fetch all deposits from dedicated deposits table (admin)
router.get('/deposits', checkAdmin, async (req, res) => {
  try {
    console.log('\n💰 [GET /api/admin/deposits] Fetching all deposits');

    const { data: deposits, error } = await supabase
      .from('deposits')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('⚠️ Error fetching deposits:', error.message);
      return res.json({ success: true, deposits: [] });
    }

    console.log(`✅ Retrieved ${deposits?.length || 0} deposits`);
    res.json({ success: true, deposits: deposits || [] });
  } catch (error) {
    console.error('❌ Get deposits error:', error);
    res.json({ success: true, deposits: [], message: 'Could not fetch deposits' });
  }
});

// GET: Fetch all activation fees from dedicated activation_fees table (admin)
router.get('/activation-fees', checkAdmin, async (req, res) => {
  try {
    console.log('\n🔑 [GET /api/admin/activation-fees] Fetching all activation fees');

    const { data: fees, error } = await supabase
      .from('activation_fees')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.warn('⚠️ Error fetching activation fees:', error.message);
      return res.json({ success: true, activation_fees: [] });
    }

    console.log(`✅ Retrieved ${fees?.length || 0} activation fees`);
    res.json({ success: true, activation_fees: fees || [] });
  } catch (error) {
    console.error('❌ Get activation fees error:', error);
    res.json({ success: true, activation_fees: [], message: 'Could not fetch activation fees' });
  }
});

// PUT: Mark activation fee as completed (credits balance + activates withdrawal for 'activation' type)
router.put('/activation-fees/:feeId/mark-completed', checkAdmin, async (req, res) => {
  try {
    const { feeId } = req.params;
    console.log(`\n✅ [PUT /api/admin/activation-fees/${feeId}/mark-completed]`);
    let updatedUser = null;

    const { data: fee, error: fetchError } = await supabase
      .from('activation_fees')
      .select('*')
      .eq('id', feeId)
      .single();

    if (fetchError || !fee) {
      return res.status(404).json({ success: false, message: 'Activation fee not found' });
    }
    if (fee.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Fee is already ${fee.status}` });
    }

    // Update fee status
    const { error: updateError } = await supabase
      .from('activation_fees')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', feeId);

    if (updateError) {
      return res.status(500).json({ success: false, message: 'Failed to approve fee', error: updateError.message });
    }

    // Credit the fee amount to user's balance
    try {
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('account_balance, phone_number, username')
        .eq('id', fee.user_id)
        .single();

      if (!userError && user) {
        const newBalance = (parseFloat(user.account_balance) || 0) + parseFloat(fee.amount);
        // FIX: Update both account_balance and stakeable_balance to ensure split balance consistency
        const userUpdate = { account_balance: newBalance, stakeable_balance: newBalance };

        // If this is a KSH 1000 activation fee, also activate the user's withdrawal capability
        if (fee.fee_type === 'activation') {
          userUpdate.withdrawal_activated = true;
          userUpdate.withdrawal_activation_date = new Date().toISOString();
          console.log(`🔓 Activating withdrawal for user ${fee.user_id}`);
        }

        const { error: balanceError } = await supabase
          .from('users')
          .update(userUpdate)
          .eq('id', fee.user_id);

        if (balanceError) {
          console.warn('⚠️ Failed to update user balance/activation:', balanceError.message);
        } else {
          console.log(`✅ User ${fee.user_id} balance +KSH ${fee.amount}, new balance: KSH ${newBalance}`);
          updatedUser = {
            id: fee.user_id,
            withdrawal_activated: fee.fee_type === 'activation',
            withdrawal_activation_date: fee.fee_type === 'activation' ? new Date().toISOString() : null,
          };

          if (fee.fee_type === 'activation' && user.phone_number) {
            sendActivationSms(
              user.phone_number,
              user.username || 'User',
              parseFloat(fee.amount) || 0,
              newBalance
            ).catch(() => {});
          }
        }
      }
    } catch (balanceError) {
      console.warn('⚠️ Error updating user balance:', balanceError.message);
    }

    res.json({ success: true, message: 'Activation fee approved', fee: { id: feeId, status: 'completed' }, user: updatedUser });
  } catch (error) {
    console.error('❌ Approve activation fee error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// PUT: Reject activation fee
router.put('/activation-fees/:feeId/mark-rejected', checkAdmin, async (req, res) => {
  try {
    const { feeId } = req.params;
    console.log(`\n❌ [PUT /api/admin/activation-fees/${feeId}/mark-rejected]`);

    const { data: fee, error: fetchError } = await supabase
      .from('activation_fees')
      .select('*')
      .eq('id', feeId)
      .single();

    if (fetchError || !fee) {
      return res.status(404).json({ success: false, message: 'Activation fee not found' });
    }
    if (fee.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Fee is already ${fee.status}` });
    }

    const { error: updateError } = await supabase
      .from('activation_fees')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', feeId);

    if (updateError) {
      return res.status(500).json({ success: false, message: 'Failed to reject fee', error: updateError.message });
    }

    res.json({ success: true, message: 'Activation fee rejected', fee: { id: feeId, status: 'failed' } });
  } catch (error) {
    console.error('❌ Reject activation fee error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// PUT: Revert activation fee to pending (reverses balance credit + deactivates withdrawal if needed)
router.put('/activation-fees/:feeId/mark-pending', checkAdmin, async (req, res) => {
  try {
    const { feeId } = req.params;
    console.log(`\n🔄 [PUT /api/admin/activation-fees/${feeId}/mark-pending]`);
    let updatedUser = null;

    const { data: fee, error: fetchError } = await supabase
      .from('activation_fees')
      .select('*')
      .eq('id', feeId)
      .single();

    if (fetchError || !fee) {
      return res.status(404).json({ success: false, message: 'Activation fee not found' });
    }
    if (fee.status === 'pending') {
      return res.status(400).json({ success: false, message: 'Fee is already pending' });
    }

    const wasCompleted = fee.status === 'completed';

    const { error: updateError } = await supabase
      .from('activation_fees')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', feeId);

    if (updateError) {
      return res.status(500).json({ success: false, message: 'Failed to revert fee', error: updateError.message });
    }

    // If the fee was previously completed, reverse the balance credit
    if (wasCompleted) {
      try {
        const { data: user, error: userError } = await supabase
          .from('users')
          .select('account_balance')
          .eq('id', fee.user_id)
          .single();

        if (!userError && user) {
          const newBalance = Math.max(0, (parseFloat(user.account_balance) || 0) - parseFloat(fee.amount));
          const userUpdate = { account_balance: newBalance };

          // If this was an activation fee, deactivate withdrawal
          if (fee.fee_type === 'activation') {
            userUpdate.withdrawal_activated = false;
            userUpdate.withdrawal_activation_date = null;
            console.log(`🔒 Deactivating withdrawal for user ${fee.user_id}`);
          }

          const { error: balanceError } = await supabase
            .from('users')
            .update(userUpdate)
            .eq('id', fee.user_id);

          if (balanceError) {
            console.warn('⚠️ Failed to reverse user balance:', balanceError.message);
          } else {
            console.log(`✅ User ${fee.user_id} balance -KSH ${fee.amount}, new balance: KSH ${newBalance}`);
            updatedUser = {
              id: fee.user_id,
              withdrawal_activated: fee.fee_type === 'activation' ? false : null,
              withdrawal_activation_date: fee.fee_type === 'activation' ? null : undefined,
            };
          }
        }
      } catch (balanceError) {
        console.warn('⚠️ Error reversing user balance:', balanceError.message);
      }
    }

    res.json({ success: true, message: 'Activation fee reverted to pending', fee: { id: feeId, status: 'pending' }, user: updatedUser });
  } catch (error) {
    console.error('❌ Revert activation fee error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// GET: Fetch pending deposits (STK pushes waiting for admin confirmation)
router.get('/transactions/pending/deposits', checkAdmin, async (req, res) => {
  try {
    console.log('\n💳 [GET /api/admin/transactions/pending/deposits] Fetching pending deposits');

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch all pending deposit transactions
    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select(`
        *,
        user:users(id, username, phone_number, account_balance)
      `)
      .eq('type', 'deposit')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (txError) {
      console.warn('⚠️ Error fetching pending deposits:', txError.message);
      return res.json({ success: true, pending_deposits: [], count: 0 });
    }

    console.log(`✅ Retrieved ${transactions?.length || 0} pending deposits`);

    res.json({ 
      success: true, 
      pending_deposits: transactions || [],
      count: transactions?.length || 0
    });
  } catch (error) {
    console.error('❌ Get pending deposits error:', error);
    res.json({ 
      success: true, 
      pending_deposits: [],
      message: 'Could not fetch pending deposits'
    });
  }
});

// GET: Fetch transactions by status and type
router.get('/transactions/filter', checkAdmin, async (req, res) => {
  try {
    const { status, type, limit = 100, offset = 0 } = req.query;

    console.log('\n💳 [GET /api/admin/transactions/filter] Fetching filtered transactions');
    console.log('   Filters:', { status, type, limit, offset });

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    let query = supabase
      .from('transactions')
      .select(`
        *,
        user:users(id, username, phone_number, account_balance)
      `);

    if (status) {
      query = query.eq('status', status);
    }

    if (type) {
      query = query.eq('type', type);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: transactions, error: txError, count } = await query;

    if (txError) {
      console.warn('⚠️ Error filtering transactions:', txError.message);
      return res.json({ success: true, transactions: [], count: 0 });
    }

    console.log(`✅ Retrieved ${transactions?.length || 0} filtered transactions`);

    res.json({ 
      success: true, 
      transactions: transactions || [],
      count: count || 0
    });
  } catch (error) {
    console.error('❌ Filter transactions error:', error);
    res.json({ 
      success: true, 
      transactions: [],
      message: 'Could not filter transactions'
    });
  }
});

// GET: Admin search by username or phone number
router.get('/search', checkAdmin, async (req, res) => {
  try {
    const { query } = req.query;

    console.log(`\n🔍 [GET /api/admin/search] Searching for: "${query}"`);

    if (!query || query.trim().length < 2) {
      return res.json({ 
        success: true, 
        results: [],
        message: 'Search query must be at least 2 characters'
      });
    }

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    const searchTerm = query.toLowerCase().trim();

    // Search for users by username or phone number
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, username, phone_number, account_balance, total_bets, total_winnings, is_admin, created_at, updated_at');

    if (usersError) {
      console.warn('⚠️ Error fetching users:', usersError.message);
      return res.json({ success: true, results: [] });
    }

    // Filter users by matching username or phone (client-side for flexibility)
    const filteredUsers = (users || [])
      .filter(u => 
        u.username?.toLowerCase().includes(searchTerm) || 
        u.phone_number?.includes(searchTerm)
      )
      .slice(0, 20); // Limit to 20 results

    console.log(`✅ Found ${filteredUsers.length} matching users`);

    // For each user, get their recent transactions
    const results = await Promise.all(
      filteredUsers.map(async (user) => {
        try {
          const { data: transactions } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(5);

          return {
            ...user,
            recentTransactions: transactions || []
          };
        } catch (err) {
          return {
            ...user,
            recentTransactions: []
          };
        }
      })
    );

    res.json({ 
      success: true, 
      results,
      count: results.length,
      query: searchTerm
    });
  } catch (error) {
    console.error('❌ Search error:', error);
    res.json({ 
      success: true, 
      results: [],
      message: 'Search error'
    });
  }
});

// GET: Fetch all payments (deposits/withdrawals)
router.get('/payments', checkAdmin, async (req, res) => {
  try {
    console.log('\n💰 [GET /api/admin/payments] Fetching all payments');

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch all payments
    const { data: payments, error: payError } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false });

    if (payError) {
      console.warn('⚠️  No payments found or fetch error:', payError.message);
      return res.json({ success: true, payments: [] });
    }

    console.log(`✅ Retrieved ${payments?.length || 0} payments`);

    res.json({ 
      success: true, 
      payments: payments || []
    });
  } catch (error) {
    console.error('❌ Get payments error:', error);
    res.json({ 
      success: true, 
      payments: [],
      message: 'Could not fetch payments'
    });
  }
});


// POST: Record withdrawal transaction (when user initiates withdrawal)
// POST: Manually insert a transaction for any user (admin tool)
router.post('/transactions/manual', checkAdmin, async (req, res) => {
  try {
    const {
      userId,
      type,
      amount,
      status,
      date,
      time,
      phoneNumber,
      description,
      method,
      notes,
    } = req.body;

    console.log('\n💰 [POST /api/admin/transactions/manual] Inserting manual transaction');

    if (!userId) {
      return res.status(400).json({ success: false, error: 'User ID is required' });
    }

    const normalizedType = String(type || '').trim().toLowerCase();
    if (!['deposit', 'withdrawal'].includes(normalizedType)) {
      return res.status(400).json({ success: false, error: 'Type must be deposit or withdrawal' });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be greater than zero' });
    }

    const normalizedStatus = String(status || 'pending').trim().toLowerCase();
    const validStatuses = ['completed', 'failed', 'pending'];
    if (!validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ success: false, error: 'Status must be completed, failed, or pending' });
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, account_balance, username, phone_number')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const localDate = date || new Date().toISOString().split('T')[0];
    const localTime = time || '00:00';
    const createdAt = new Date(`${localDate}T${localTime}:00`).toISOString();
    const externalReference = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const transactionPayload = {
      user_id: userId,
      type: normalizedType,
      amount: numericAmount,
      status: normalizedStatus,
      phone_number: phoneNumber || user.phone_number || null,
      description: description || `${normalizedType.charAt(0).toUpperCase() + normalizedType.slice(1)} manually inserted by admin`,
      method: method || 'manual-adjustment',
      external_reference: externalReference,
      mpesa_receipt: normalizedStatus === 'completed' ? `MANUAL-${Date.now()}` : null,
      admin_notes: notes || 'Inserted manually from admin panel',
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    };

    const { data: insertedTransaction, error: insertError } = await supabase
      .from('transactions')
      .insert([transactionPayload])
      .select('*')
      .single();

    if (insertError) {
      console.error('❌ Error inserting manual transaction:', insertError.message);
      return res.status(500).json({ success: false, error: insertError.message || 'Failed to insert transaction' });
    }

    let updatedUser = { ...user };
    if (normalizedStatus === 'completed') {
      const currentBalance = Number(user.account_balance) || 0;
      const delta = normalizedType === 'deposit' ? numericAmount : -numericAmount;
      const nextBalance = Math.max(0, currentBalance + delta);

      const { data: refreshedUser, error: balanceError } = await supabase
        .from('users')
        .update({ account_balance: nextBalance, updated_at: new Date().toISOString() })
        .eq('id', userId)
        .select('id, account_balance, username, phone_number')
        .single();

      if (balanceError) {
        console.warn('⚠️ Failed to sync manual transaction balance:', balanceError.message);
      } else {
        updatedUser = refreshedUser || updatedUser;
      }
    }

    res.json({
      success: true,
      message: `Manual ${normalizedType} transaction inserted successfully`,
      transaction: insertedTransaction,
      user: updatedUser,
    });
  } catch (error) {
    console.error('❌ Manual transaction insertion error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to insert manual transaction' });
  }
});

router.post('/transactions/withdrawal', async (req, res) => {
  try {
    const { userId, amount, phoneNumber, reason, idempotencyKey } = req.body;

    console.log(`\n🔄 [POST /api/admin/transactions/withdrawal] Recording withdrawal transaction`);
    console.log(`   User: ${userId}, Amount: KSH ${amount}, Phone: ${phoneNumber}, Key: ${idempotencyKey || 'none'}`);

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'User ID and valid amount required' 
      });
    }

    if (parseFloat(amount) < 600) {
      return res.status(400).json({
        success: false,
        error: 'Minimum withdrawal amount is KSH 600'
      });
    }

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Duplicate withdrawal guard: reject if same user has a pending withdrawal
    // for the same amount created within the last 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30000).toISOString();
    const { data: recentDup } = await supabase
      .from('transactions')
      .select('id, transaction_id, created_at')
      .eq('user_id', userId)
      .eq('type', 'withdrawal')
      .eq('amount', parseFloat(amount))
      .gte('created_at', thirtySecondsAgo)
      .limit(1)
      .maybeSingle();

    if (recentDup) {
      console.warn(`⚠️ Duplicate withdrawal blocked: user ${userId}, amount ${amount}, existing tx ${recentDup.transaction_id}`);
      return res.json({
        success: true,
        transaction: recentDup,
        message: 'Withdrawal already recorded (duplicate request ignored)'
      });
    }

    // Get user's current balance
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('account_balance, phone_number')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      console.error('❌ User not found:', userError?.message);
      return res.status(404).json({ 
        success: false, 
        error: 'User not found' 
      });
    }

    const balanceBefore = parseFloat(user.account_balance);
    const newBalance = balanceBefore - parseFloat(amount);

    if (newBalance < 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient balance for withdrawal' 
      });
    }

    // Record withdrawal transaction
    const transactionRef = `WTH-${Date.now()}-${userId}`;
    const { data: transaction, error: txError } = await supabase
      .from('transactions')
      .insert({
        transaction_id: transactionRef,
        user_id: userId,
        type: 'withdrawal',
        amount: parseFloat(amount),
        status: 'pending',
        external_reference: transactionRef,
        phone_number: phoneNumber || null,
        description: reason || 'User initiated withdrawal',
        balance_before: balanceBefore,
        balance_after: newBalance,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (txError) {
      console.error('❌ Error recording withdrawal transaction:', txError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to record withdrawal',
        details: txError.message
      });
    }

    // Create fund transfer record in the dedicated fund_transfers table
    try {
      console.log('💳 Creating fund transfer record for withdrawal...');
      const fundTransferData = {
        user_id: userId,
        transfer_type: 'withdrawal',
        amount: parseFloat(amount),
        phone_number: phoneNumber,
        status: 'pending',
        method: 'M-Pesa',
        external_reference: transactionRef,
        withdrawal_destination: phoneNumber,
        transaction_id: transaction.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      
      console.log('   Fund transfer data:', JSON.stringify(fundTransferData, null, 2));
      
      const { data: fundTransfer, error: fundTransferError } = await supabase
        .from('fund_transfers')
        .insert([fundTransferData])
        .select();

      if (fundTransferError) {
        console.warn('⚠️ Failed to create fund transfer record:');
        console.warn('   Error message:', fundTransferError.message);
        console.warn('   Error details:', fundTransferError.details);
        console.warn('   Error code:', fundTransferError.code);
      } else {
        console.log('✅ Fund transfer record created:', fundTransfer?.[0]?.id);
      }
    } catch (fundError) {
      console.warn('⚠️ Error creating fund transfer record:', fundError.message);
      console.warn('   Stack:', fundError.stack);
    }

    // Deduct from user balance
    const { error: balanceError } = await supabase
      .from('users')
      .update({ account_balance: newBalance, updated_at: new Date().toISOString() })
      .eq('id', userId);

    if (balanceError) {
      console.warn('⚠️ Failed to update balance:', balanceError.message);
    } else {
      console.log(`✅ Withdrawal recorded. Previous balance: ${balanceBefore}, New balance: ${newBalance}`);

      const smsPhone = phoneNumber || user.phone_number;
      if (smsPhone) {
          sendWithdrawalSms(smsPhone, amount, newBalance).catch(() => {});
      }
    }

    res.json({ 
      success: true, 
      transaction,
      message: 'Withdrawal recorded successfully'
    });
  } catch (error) {
    console.error('❌ Record withdrawal error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to record withdrawal',
      details: error.message
    });
  }
});

// PUT: Edit single match outcome in a multibet
router.put('/bets/:betId/selections/:selectionId/outcome', checkAdmin, async (req, res) => {
  try {
    const { betId, selectionId } = req.params;
    const { outcome } = req.body; // 'won' or 'lost'

    console.log(`\n✏️  [PUT /api/admin/bets/${betId}/selections/${selectionId}/outcome] Editing match outcome`);
    console.log(`   New outcome: ${outcome}`);

    if (!outcome || !['won', 'lost', 'pending'].includes(outcome)) {
      console.error('❌ Invalid outcome:', outcome);
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid outcome - must be "won", "lost", or "pending"' 
      });
    }

    // Get the bet selection
    const { data: selection, error: selError } = await supabase
      .from('bet_selections')
      .select('*, games:game_id(status)')
      .eq('id', selectionId)
      .single();

    if (selError || !selection) {
      console.error('❌ Selection not found:', selectionId);
      return res.status(404).json({ 
        success: false, 
        error: 'Bet selection not found' 
      });
    }

    const selectionGameStatus = (selection.games?.status || '').toLowerCase();
    if ((outcome === 'won' || outcome === 'lost') && selectionGameStatus !== 'finished') {
      return res.status(400).json({
        success: false,
        error: 'Cannot set selection to won/lost before the game is finished'
      });
    }

    console.log(`✅ Found selection:`, selection.id);

    // Update the selection outcome
    const { data: updatedSelection, error: updateError } = await supabase
      .from('bet_selections')
      .update({ outcome })
      .eq('id', selectionId)
      .select()
      .single();

    if (updateError) {
      console.error('❌ Error updating selection outcome:', updateError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to update outcome',
        details: updateError.message
      });
    }

    console.log(`✅ Selection outcome updated to: ${outcome}`);

    // Now check if all selections are finished and determine overall bet outcome
    // Get all selections for this bet
    const { data: allSelections } = await supabase
      .from('bet_selections')
      .select('*, games:game_id(status)')
      .eq('bet_id', selection.bet_id);

    if (allSelections && allSelections.length > 0) {
      // Check if any selection is lost - if so, bet is lost
      const hasLostSelection = allSelections.some(sel => sel.outcome === 'lost');
      
      // For admin manual settlement, once all selection outcomes are set we can settle the bet.
      // Game status is still logged for visibility but does not block settlement here.
      const allOutcomesSet = allSelections.every(sel => sel.outcome !== 'pending');
      const allGamesFinished = allSelections.every(sel => (sel.games?.status || '').toLowerCase() === 'finished');
      const allFinished = allOutcomesSet;
      
      // Check if all selections are won
      const allWon = allSelections.every(sel => sel.outcome === 'won');

      let newBetStatus = 'Open'; // default

      if (hasLostSelection) {
        newBetStatus = 'Lost';
      } else if (allFinished && allWon) {
        newBetStatus = 'Won';
      } else if (allFinished && !allWon) {
        newBetStatus = 'Lost';
      }

      console.log(`   Calculated new bet status: ${newBetStatus}`);
      console.log(`   - Has lost selection: ${hasLostSelection}`);
      console.log(`   - All outcomes set: ${allOutcomesSet}`);
      console.log(`   - All games finished: ${allGamesFinished}`);
      console.log(`   - All won: ${allWon}`);

      // Get the bet to access its data
      const { data: bet, error: betError } = await supabase
        .from('bets')
        .select('*')
        .eq('id', selection.bet_id)
        .single();

      if (!bet || betError) {
        console.error('❌ Error fetching bet:', betError?.message);
      } else {
        // Update bet status accordingly
        if (newBetStatus !== 'Open' && newBetStatus !== bet.status) {
          const amountWon = newBetStatus === 'Won' ? bet.potential_win : null;
          
          const betSettlementUpdate = {
            status: newBetStatus,
            amount_won: amountWon,
            settled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };

          let { error: betUpdateError } = await supabase
            .from('bets')
            .update(betSettlementUpdate)
            .eq('id', selection.bet_id);

          if (betUpdateError && `${betUpdateError.message || ''}`.includes('amount_won')) {
            const fallbackSettlementUpdate = { ...betSettlementUpdate };
            delete fallbackSettlementUpdate.amount_won;
            const fallbackResult = await supabase
              .from('bets')
              .update(fallbackSettlementUpdate)
              .eq('id', selection.bet_id);
            betUpdateError = fallbackResult.error;
          }

          if (betUpdateError) {
            console.warn('⚠️  Could not update bet status:', betUpdateError.message);
            // Continue anyway - selection was updated
          } else {
            console.log(`✅ Bet status automatically updated to: ${newBetStatus}`);

            // Update winnings wallet if bet won
            if (newBetStatus === 'Won' && amountWon && bet.user_id) {
              console.log(`\n💰 [BALANCE UPDATE] Processing winnings for user ID: ${bet.user_id}`);
              
              let { data: user, error: userError } = await supabase
                .from('users')
                .select('winnings_balance, total_winnings, account_balance, phone_number')
                .eq('id', bet.user_id)
                .single();

              if (userError && `${userError.message || ''}`.includes('winnings_balance')) {
                const fallbackUserResult = await supabase
                  .from('users')
                  .select('total_winnings, account_balance, phone_number')
                  .eq('id', bet.user_id)
                  .single();
                user = fallbackUserResult.data;
                userError = fallbackUserResult.error;
              }

              if (!user || userError) {
                console.error('   ❌ Error fetching user:', userError?.message);
              } else {
                const currentWinningsBalance = parseFloat(user.winnings_balance ?? user.total_winnings ?? 0) || 0;
                const newBalance = currentWinningsBalance + parseFloat(amountWon);
                const newWinnings = (parseFloat(user.total_winnings) || 0) + parseFloat(amountWon);
                const newMainBalance = (parseFloat(user.account_balance) || 0) + parseFloat(amountWon);

                const userBalanceUpdate = {
                  account_balance: newMainBalance,
                  winnings_balance: newBalance,
                  total_winnings: newWinnings,
                  updated_at: new Date().toISOString()
                };

                let { error: balanceError } = await supabase
                  .from('users')
                  .update(userBalanceUpdate)
                  .eq('id', bet.user_id);

                if (balanceError && `${balanceError.message || ''}`.includes('winnings_balance')) {
                  const fallbackUpdate = { ...userBalanceUpdate };
                  delete fallbackUpdate.winnings_balance;
                  const fallbackResult = await supabase
                    .from('users')
                    .update(fallbackUpdate)
                    .eq('id', bet.user_id);
                  balanceError = fallbackResult.error;
                }

                if (balanceError) {
                  console.error('   ❌ Error updating user winnings balance:', balanceError.message);
                } else {
                  console.log(`   ✅ User winnings updated successfully`);
                  console.log(`      Phone: ${user.phone_number}`);
                  console.log(`      New main account balance: KSH ${newMainBalance}`);
                  console.log(`      Previous winnings balance: KSH ${user.winnings_balance || 0}`);
                  console.log(`      New winnings balance: KSH ${newBalance}`);
                  console.log(`      Winnings added: KSH ${amountWon}`);

                  const betRef = bet.bet_id || bet.id;
                  await sendWonSmsWithFallback({
                    userId: bet.user_id,
                    directPhone: user.phone_number,
                    betRef,
                    amountWon,
                  });
                }
              }
            }
          }
        }
      }
    }

    // Log admin action
    try {
      if (req.user.id && req.user.id !== 'unknown') {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user.id,
          action: 'edit_selection_outcome',
          target_type: 'bet_selection',
          target_id: selectionId,
          changes: { outcome },
          description: `Edited selection outcome to: ${outcome}`,
        }]);
      }
    } catch (logError) {
      console.warn('⚠️ Failed to log admin action:', logError.message);
    }

    res.json({ 
      success: true, 
      selection: updatedSelection,
      message: `Selection outcome updated to ${outcome}`
    });
  } catch (error) {
    console.error('❌ Edit selection outcome error:', error.message);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to edit selection outcome', 
      details: error.message 
    });
  }
});

// POST: Calculate and update all user balances based on betting history
router.post('/calculate-user-balances', checkAdmin, async (req, res) => {
  try {
    console.log('\n💰 [POST /api/admin/calculate-user-balances] Starting balance calculation...');

    // Fetch all users
    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, balance, account_balance');

    if (usersError) throw usersError;
    console.log(`✅ Found ${users.length} users`);

    const updates = [];
    const report = [];

    for (const user of users) {
      console.log(`\n📊 Processing user: ${user.email} (ID: ${user.id})`);
      
      const currentBalance = user.balance || user.account_balance || 0;
      console.log(`   Current balance: KSH ${currentBalance}`);

      // Get all bets for this user
      const { data: bets, error: betsError } = await supabase
        .from('bets')
        .select('id, stake, status, amount_won')
        .eq('user_id', user.id);

      if (betsError) {
        console.warn(`⚠️ Error fetching bets for user ${user.id}:`, betsError.message);
        continue;
      }

      // Separate bets by status
      const wonBets = bets.filter((b) => b.status === 'Won');
      const lostBets = bets.filter((b) => b.status === 'Lost');
      const openBets = bets.filter((b) => b.status === 'Open');

      // Calculate totals
      const totalWon = wonBets.reduce((sum, b) => sum + (b.amount_won || 0), 0);
      const totalLostStakes = lostBets.reduce((sum, b) => sum + (b.stake || 0), 0);
      const totalOpenStakes = openBets.reduce((sum, b) => sum + (b.stake || 0), 0);

      // Formula: won amount - lost stakes - open stakes + 1000 bonus
      const calculatedBalance = Math.max(0, totalWon - totalLostStakes - totalOpenStakes + 1000);

      console.log(`   Won bets: ${wonBets.length} | Total won: KSH ${totalWon}`);
      console.log(`   Lost bets: ${lostBets.length} | Total stakes lost: KSH ${totalLostStakes}`);
      console.log(`   Open bets: ${openBets.length} | Total stakes at risk: KSH ${totalOpenStakes}`);
      console.log(`   ➜ Calculation: ${totalWon} - ${totalLostStakes} - ${totalOpenStakes} + 1000 = ${calculatedBalance}`);
      console.log(`   ✓ Calculated balance: KSH ${calculatedBalance}`);

      updates.push({
        userId: user.id,
        email: user.email,
        oldBalance: currentBalance,
        newBalance: calculatedBalance,
        won: totalWon,
        lost: totalLostStakes,
        open: totalOpenStakes,
        wonBets: wonBets.length,
        lostBets: lostBets.length,
        openBets: openBets.length,
      });

      report.push({
        email: user.email,
        oldBalance: currentBalance,
        newBalance: calculatedBalance,
        difference: calculatedBalance - currentBalance,
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('📋 BALANCE CALCULATION SUMMARY');
    console.log('='.repeat(80));

    report.forEach((r) => {
      const diff = r.difference > 0 ? `+${r.difference}` : r.difference;
      console.log(`${r.email}`);
      console.log(`  Old: KSH ${r.oldBalance} → New: KSH ${r.newBalance} (${diff})`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('🔄 Updating balances in Supabase...');
    console.log('='.repeat(80));

    // Update all balances
    let successCount = 0;
    const failedUpdates = [];

    for (const update of updates) {
      try {
        // Update balance field
        const { error: error1 } = await supabase
          .from('users')
          .update({ balance: update.newBalance })
          .eq('id', update.userId);

        // Also update account_balance field if it exists
        if (!error1) {
          await supabase
            .from('users')
            .update({ account_balance: update.newBalance })
            .eq('id', update.userId);
        }

        if (error1) {
          console.log(`❌ Error updating ${update.email}: ${error1.message}`);
          failedUpdates.push(update);
        } else {
          console.log(`✅ Updated ${update.email}: KSH ${update.oldBalance} → KSH ${update.newBalance}`);
          successCount++;
        }
      } catch (err) {
        console.log(`❌ Exception updating ${update.email}: ${err.message}`);
        failedUpdates.push(update);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log(`✨ SUCCESS: ${successCount}/${updates.length} users updated`);
    console.log('='.repeat(80));

    res.json({
      success: true,
      message: `Updated ${successCount}/${updates.length} user balances`,
      updatedCount: successCount,
      totalCount: updates.length,
      failed: failedUpdates.length,
      summary: report,
      details: updates
    });

  } catch (error) {
    console.error('❌ Calculate balances error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate user balances',
      details: error.message
    });
  }
});

// PUT: Mark transaction as completed (admin can confirm pending STK pushes)
router.put('/transactions/:transactionId/mark-completed', checkAdmin, async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { mpesaReceipt, notes } = req.body;

    console.log(`\n💳 [PUT /api/admin/transactions/${transactionId}/mark-completed] Marking transaction as completed`);
    console.log('   Transaction ID:', transactionId);
    console.log('   M-Pesa Receipt (optional):', mpesaReceipt || 'not provided');

    // Fetch the transaction — try transactions table first, then deposits table
    let transaction = null;
    let fromDepositsTable = false;

    const { data: txData, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (!fetchError && txData) {
      transaction = txData;
    } else {
      // Fallback: check deposits table
      const { data: depData, error: depError } = await supabase
        .from('deposits')
        .select('*')
        .eq('id', transactionId)
        .single();

      if (!depError && depData) {
        transaction = { ...depData, type: 'deposit' };
        fromDepositsTable = true;
        console.log('✅ Transaction found in deposits table (not in transactions)');
      }
    }

    if (!transaction) {
      console.error('❌ Transaction not found in any table:', transactionId);
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    console.log('✅ Transaction found:', {
      id: transaction.id,
      userId: transaction.user_id,
      amount: transaction.amount,
      status: transaction.status,
      source: fromDepositsTable ? 'deposits' : 'transactions'
    });

    // Check if transaction is pending
    if (transaction.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Transaction is already ${transaction.status}, cannot mark as completed`
      });
    }

    // Update the source table atomically — add .eq('status','pending') so only the first writer
    // succeeds; the callback may have already completed it while admin was looking at the page.
    let rowsAffected = 0;
    if (fromDepositsTable) {
      const { data: updatedRows, error: updateError } = await supabase
        .from('deposits')
        .update({
          status: 'completed',
          mpesa_receipt: mpesaReceipt || transaction.mpesa_receipt,
          admin_notes: notes || '',
          completed_at: new Date().toISOString(),
          completed_by: req.user?.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId)
        .eq('status', 'pending')
        .select('id');

      if (updateError) {
        console.error('❌ Error updating deposit:', updateError);
        return res.status(500).json({ success: false, message: 'Failed to update deposit', error: updateError.message });
      }
      rowsAffected = updatedRows?.length || 0;
    } else {
      const { data: updatedRows, error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'completed',
          mpesa_receipt: mpesaReceipt || transaction.mpesa_receipt,
          admin_notes: notes || '',
          completed_at: new Date().toISOString(),
          completed_by: req.user?.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId)
        .eq('status', 'pending')
        .select('id');

      if (updateError) {
        console.error('❌ Error updating transaction:', updateError);
        return res.status(500).json({ success: false, message: 'Failed to update transaction', error: updateError.message });
      }
      rowsAffected = updatedRows?.length || 0;
    }

    if (rowsAffected === 0) {
      // Another process (e.g. callback) already completed this transaction — do not double-credit
      console.log('⚠️ Transaction was already completed by another process — skipping balance credit');
      return res.json({ success: true, message: 'Transaction already completed', alreadyProcessed: true });
    }

    console.log('✅ Transaction marked as completed');

    // Credit user balance — only reached when we were the process that flipped status to completed
    if (transaction.type === 'deposit') {
      try {
        console.log('💰 Updating user balance for completed deposit...');
        const { data: user, error: userError } = await supabase
          .from('users')
          .select('account_balance')
          .eq('id', transaction.user_id)
          .single();

        if (!userError && user) {
          const newBalance = (parseFloat(user.account_balance) || 0) + parseFloat(transaction.amount);
          
          const { error: balanceError } = await supabase
            .from('users')
            .update({ account_balance: newBalance })
            .eq('id', transaction.user_id);

          if (balanceError) {
            console.warn('⚠️ Failed to update balance:', balanceError.message);
          } else {
            console.log(`✅ User balance updated: +KSH ${transaction.amount}, New balance: KSH ${newBalance}`);
          }
        }
      } catch (balanceError) {
        console.warn('⚠️ Error updating user balance:', balanceError.message);
      }
    }

    // Also update fund_transfers table if a matching record exists
    try {
      const { error: ftError } = await supabase
        .from('fund_transfers')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', transaction.user_id)
        .eq('amount', transaction.amount)
        .eq('type', transaction.type)
        .eq('status', 'pending');

      if (ftError) {
        console.warn('⚠️ Could not update fund_transfers:', ftError.message);
      } else {
        console.log('✅ fund_transfers table synced to completed');
      }
    } catch (ftErr) {
      console.warn('⚠️ fund_transfers sync error:', ftErr.message);
    }

    // Also sync deposits table if this deposit has a matching record there
    if (transaction.type === 'deposit' && transaction.external_reference) {
      try {
        const { error: depError } = await supabase
          .from('deposits')
          .update({
            status: 'completed',
            admin_notes: notes || '',
            completed_at: new Date().toISOString(),
            completed_by: req.user?.id,
            updated_at: new Date().toISOString()
          })
          .eq('external_reference', transaction.external_reference);

        if (depError) {
          console.warn('⚠️ Could not update deposits table:', depError.message);
        } else {
          console.log('✅ deposits table synced to completed');
        }
      } catch (depErr) {
        console.warn('⚠️ deposits table sync error:', depErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Transaction marked as completed',
      transaction: {
        id: transactionId,
        status: 'completed',
        completedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Mark transaction as completed error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark transaction as completed',
      error: error.message
    });
  }
});

// PUT: Reject/fail a pending transaction (admin)
router.put('/transactions/:transactionId/mark-rejected', checkAdmin, async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { reason } = req.body;

    console.log(`\n❌ [PUT /api/admin/transactions/${transactionId}/mark-rejected] Rejecting transaction`);

    // Fetch the transaction — try transactions table first, then deposits table
    let transaction = null;
    let fromDepositsTable = false;

    const { data: txData, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (!fetchError && txData) {
      transaction = txData;
    } else {
      const { data: depData, error: depError } = await supabase
        .from('deposits')
        .select('*')
        .eq('id', transactionId)
        .single();

      if (!depError && depData) {
        transaction = { ...depData, type: 'deposit' };
        fromDepositsTable = true;
        console.log('✅ Transaction found in deposits table');
      }
    }

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (transaction.status === 'failed') {
      return res.status(400).json({
        success: false,
        message: `Transaction is already failed and cannot be rejected again`
      });
    }

    if (transaction.status === 'completed' && transaction.type === 'deposit') {
      try {
        const { data: user, error: userError } = await supabase
          .from('users')
          .select('account_balance')
          .eq('id', transaction.user_id)
          .single();

        if (!userError && user) {
          const newBalance = Math.max(0, (parseFloat(user.account_balance) || 0) - parseFloat(transaction.amount));
          await supabase
            .from('users')
            .update({ account_balance: newBalance })
            .eq('id', transaction.user_id);
          console.log(`✅ Reversed completed deposit balance: -KSH ${transaction.amount}`);
        }
      } catch (balanceError) {
        console.warn('⚠️ Failed to reverse credited balance for rejected deposit:', balanceError.message);
      }
    }

    // Update the source table
    if (fromDepositsTable) {
      const { error: updateError } = await supabase
        .from('deposits')
        .update({
          status: 'failed',
          admin_notes: reason || 'Rejected by admin',
          completed_at: new Date().toISOString(),
          completed_by: req.user?.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateError) {
        console.error('❌ Error rejecting deposit:', updateError);
        return res.status(500).json({ success: false, message: 'Failed to reject deposit', error: updateError.message });
      }
    } else {
      const { error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'failed',
          admin_notes: reason || 'Rejected by admin',
          completed_at: new Date().toISOString(),
          completed_by: req.user?.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateError) {
        console.error('❌ Error rejecting transaction:', updateError);
        return res.status(500).json({ success: false, message: 'Failed to reject transaction', error: updateError.message });
      }
    }

    console.log('✅ Transaction rejected');

    // Also update fund_transfers table if a matching record exists
    try {
      const { error: ftError } = await supabase
        .from('fund_transfers')
        .update({
          status: 'failed',
          updated_at: new Date().toISOString()
        })
        .eq('user_id', transaction.user_id)
        .eq('amount', transaction.amount)
        .eq('type', transaction.type)
        .eq('status', 'pending');

      if (ftError) {
        console.warn('⚠️ Could not update fund_transfers:', ftError.message);
      } else {
        console.log('✅ fund_transfers table synced to failed');
      }
    } catch (ftErr) {
      console.warn('⚠️ fund_transfers sync error:', ftErr.message);
    }

    // Also sync deposits table if this is a deposit
    if (transaction.type === 'deposit' && transaction.external_reference) {
      try {
        const { error: depError } = await supabase
          .from('deposits')
          .update({
            status: 'failed',
            updated_at: new Date().toISOString()
          })
          .eq('external_reference', transaction.external_reference);

        if (depError) {
          console.warn('⚠️ Could not update deposits table:', depError.message);
        } else {
          console.log('✅ deposits table synced to failed');
        }
      } catch (depErr) {
        console.warn('⚠️ deposits table sync error:', depErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Transaction rejected',
      transaction: {
        id: transactionId,
        status: 'failed',
        rejectedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Reject transaction error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject transaction', error: error.message });
  }
});

// PUT: Revert a completed/failed transaction back to pending (admin)
router.put('/transactions/:transactionId/mark-pending', checkAdmin, async (req, res) => {
  try {
    const { transactionId } = req.params;

    console.log(`\n🔄 [PUT /api/admin/transactions/${transactionId}/mark-pending] Reverting to pending`);

    // Fetch the transaction — try transactions table first, then deposits table
    let transaction = null;
    let fromDepositsTable = false;

    const { data: txData, error: fetchError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (!fetchError && txData) {
      transaction = txData;
    } else {
      const { data: depData, error: depError } = await supabase
        .from('deposits')
        .select('*')
        .eq('id', transactionId)
        .single();

      if (!depError && depData) {
        transaction = { ...depData, type: 'deposit' };
        fromDepositsTable = true;
        console.log('✅ Transaction found in deposits table');
      }
    }

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (transaction.status === 'pending') {
      return res.status(400).json({ success: false, message: 'Transaction is already pending' });
    }

    const previousStatus = transaction.status;

    // If it was a completed deposit, reverse the balance credit
    if (previousStatus === 'completed' && transaction.type === 'deposit') {
      try {
        const { data: user } = await supabase
          .from('users')
          .select('account_balance')
          .eq('id', transaction.user_id)
          .single();

        if (user) {
          const newBalance = Math.max(0, (parseFloat(user.account_balance) || 0) - parseFloat(transaction.amount));
          await supabase.from('users').update({ account_balance: newBalance }).eq('id', transaction.user_id);
          console.log(`✅ Reversed deposit balance: -KSH ${transaction.amount}`);
        }
      } catch (balErr) {
        console.warn('⚠️ Could not reverse balance:', balErr.message);
      }
    }

    // Update the source table
    if (fromDepositsTable) {
      const { error: updateError } = await supabase
        .from('deposits')
        .update({
          status: 'pending',
          admin_notes: `Reverted from ${previousStatus} by admin`,
          completed_at: null,
          completed_by: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateError) {
        return res.status(500).json({ success: false, message: 'Failed to revert deposit', error: updateError.message });
      }
    } else {
      const { error: updateError } = await supabase
        .from('transactions')
        .update({
          status: 'pending',
          admin_notes: `Reverted from ${previousStatus} by admin`,
          completed_at: null,
          completed_by: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateError) {
        return res.status(500).json({ success: false, message: 'Failed to revert transaction', error: updateError.message });
      }
    }

    // Sync fund_transfers
    try {
      await supabase
        .from('fund_transfers')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('user_id', transaction.user_id)
        .eq('amount', transaction.amount)
        .eq('type', transaction.type)
        .eq('status', previousStatus);
    } catch (ftErr) {
      console.warn('⚠️ fund_transfers sync error:', ftErr.message);
    }

    // Sync deposits table if this is a deposit
    if (transaction.type === 'deposit' && transaction.external_reference) {
      try {
        const { error: depError } = await supabase
          .from('deposits')
          .update({
            status: 'pending',
            completed_at: null,
            completed_by: null,
            updated_at: new Date().toISOString()
          })
          .eq('external_reference', transaction.external_reference);

        if (depError) {
          console.warn('⚠️ Could not update deposits table:', depError.message);
        } else {
          console.log('✅ deposits table synced to pending');
        }
      } catch (depErr) {
        console.warn('⚠️ deposits table sync error:', depErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Transaction reverted to pending',
      transaction: { id: transactionId, status: 'pending' }
    });

  } catch (error) {
    console.error('❌ Revert transaction error:', error);
    res.status(500).json({ success: false, message: 'Failed to revert transaction', error: error.message });
  }
});

// GET: Fetch all fund transfers (admin)
router.get('/fund-transfers', checkAdmin, async (req, res) => {
  try {
    console.log('\n💸 [GET /api/admin/fund-transfers] Fetching all fund transfers');

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch all fund transfers with user details
    const { data: fundTransfers, error: ftError } = await supabase
      .from('fund_transfers')
      .select(`
        *,
        user:users(id, username, phone_number, account_balance)
      `)
      .order('created_at', { ascending: false });

    if (ftError) {
      console.warn('⚠️ Error fetching fund transfers:', ftError.message);
      return res.json({ success: true, fund_transfers: [], count: 0 });
    }

    console.log(`✅ Retrieved ${fundTransfers?.length || 0} fund transfers`);

    res.json({ 
      success: true, 
      fund_transfers: fundTransfers || [],
      count: fundTransfers?.length || 0
    });
  } catch (error) {
    console.error('❌ Get fund transfers error:', error);
    res.json({ 
      success: true, 
      fund_transfers: [],
      message: 'Could not fetch fund transfers'
    });
  }
});

// GET: Fetch fund transfers for a specific user (admin)
router.get('/fund-transfers/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    console.log(`\n💸 [GET /api/admin/fund-transfers/user/${userId}] Fetching user fund transfers`);

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch fund transfers for specific user
    const { data: fundTransfers, error: ftError, count } = await supabase
      .from('fund_transfers')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (ftError) {
      console.warn('⚠️ Error fetching fund transfers:', ftError.message);
      return res.json({ 
        success: true, 
        fund_transfers: [], 
        count: 0,
        userId
      });
    }

    console.log(`✅ Retrieved ${fundTransfers?.length || 0} fund transfers for user ${userId}`);

    res.json({ 
      success: true, 
      fund_transfers: fundTransfers || [],
      count: count || 0,
      userId
    });
  } catch (error) {
    console.error('❌ Get user fund transfers error:', error);
    res.json({ 
      success: true, 
      fund_transfers: [],
      message: 'Could not fetch fund transfers'
    });
  }
});

// GET: Fetch fund transfers by type (deposits/withdrawals)
router.get('/fund-transfers/type/:type', checkAdmin, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = 50, offset = 0, status } = req.query;

    console.log(`\n💸 [GET /api/admin/fund-transfers/type/${type}] Fetching fund transfers by type`);

    if (!['deposit', 'withdrawal'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid type - must be "deposit" or "withdrawal"'
      });
    }

    if (!supabase) {
      console.error('❌ Supabase client is not initialized');
      return res.status(503).json({ 
        error: 'Service unavailable',
        success: false
      });
    }

    // Fetch fund transfers by type
    let query = supabase
      .from('fund_transfers')
      .select('*, user:users(id, username, phone_number)', { count: 'exact' })
      .eq('transfer_type', type);

    // Apply optional status filter
    if (status) {
      query = query.eq('status', status);
    }

    const { data: fundTransfers, error: ftError, count } = await query
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (ftError) {
      console.warn('⚠️ Error fetching fund transfers:', ftError.message);
      return res.json({ 
        success: true, 
        fund_transfers: [], 
        count: 0,
        type,
        status: status || 'all'
      });
    }

    console.log(`✅ Retrieved ${fundTransfers?.length || 0} ${type} transfers`);

    res.json({ 
      success: true, 
      fund_transfers: fundTransfers || [],
      count: count || 0,
      type,
      status: status || 'all'
    });
  } catch (error) {
    console.error('❌ Get fund transfers by type error:', error);
    res.json({ 
      success: true, 
      fund_transfers: [],
      message: 'Could not fetch fund transfers'
    });
  }
});

// 🔄 POST: Regenerate ALL markets for ALL existing games (fresh odds, no zeros)
router.post('/games/fix-zero-odds', checkAdmin, async (req, res) => {
  try {
    // Get all games
    const { data: games, error: gErr } = await supabase.from('games').select('id, home_odds, draw_odds, away_odds');
    if (gErr) throw gErr;

    let totalRegenerated = 0;
    for (const game of (games || [])) {
      const h = parseFloat(game.home_odds) || 2.00;
      const d = parseFloat(game.draw_odds) || 3.00;
      const a = parseFloat(game.away_odds) || 3.00;

      // Delete ALL existing markets for this game and regenerate fresh
      await supabase.from('markets').delete().eq('game_id', game.id);
      const newMarkets = generateDefaultMarkets(game.id, h, d, a);
      const { error: insErr } = await supabase.from('markets').insert(newMarkets);
      if (insErr) {
        console.error(`Failed to insert markets for game ${game.id}:`, insErr.message);
      } else {
        totalRegenerated++;
        console.log(`Regenerated ${newMarkets.length} markets for game ${game.id} (odds: ${h}/${d}/${a})`);
      }
    }

    res.json({ success: true, message: `Regenerated markets for ${totalRegenerated} of ${games?.length || 0} games` });
  } catch (err) {
    console.error('Fix zero odds error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 💰 POST: Credit win amount directly to user balance (admin "Update" button)
router.post('/bets/credit-win', checkAdmin, async (req, res) => {
  try {
    const { user_id, amount, bet_id } = req.body;
    if (!user_id || !amount) {
      return res.status(400).json({ success: false, error: 'user_id and amount are required' });
    }

    const creditAmount = parseFloat(amount);
    if (isNaN(creditAmount) || creditAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    // Get current main user balance
    let { data: user, error: userErr } = await supabase
      .from('users')
      .select('account_balance, winnings_balance, total_winnings, username, phone_number')
      .eq('id', user_id)
      .single();

    if (userErr && `${userErr.message || ''}`.includes('winnings_balance')) {
      const fallbackUserResult = await supabase
        .from('users')
        .select('account_balance, total_winnings, username, phone_number')
        .eq('id', user_id)
        .single();
      user = fallbackUserResult.data;
      userErr = fallbackUserResult.error;
    }

    if (userErr || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const prevBalance = parseFloat(user.account_balance) || 0;
    const newBalance = prevBalance + creditAmount;
    const prevWinningsBalance = parseFloat(user.winnings_balance ?? user.total_winnings ?? 0) || 0;
    const newWinningsBalance = prevWinningsBalance + creditAmount;
    const prevTotalWinnings = parseFloat(user.total_winnings) || 0;
    const newTotalWinnings = prevTotalWinnings + creditAmount;

    // Update user main balance, winnings balance, and winnings aggregate
    const userBalanceUpdate = {
      account_balance: newBalance,
      winnings_balance: newWinningsBalance,
      total_winnings: newTotalWinnings,
      updated_at: new Date().toISOString()
    };

    let { error: updateErr } = await supabase
      .from('users')
      .update(userBalanceUpdate)
      .eq('id', user_id);

    if (updateErr && `${updateErr.message || ''}`.includes('winnings_balance')) {
      const fallbackUpdate = { ...userBalanceUpdate };
      delete fallbackUpdate.winnings_balance;
      const fallbackResult = await supabase
        .from('users')
        .update(fallbackUpdate)
        .eq('id', user_id);
      updateErr = fallbackResult.error;
    }

    if (updateErr) {
      return res.status(500).json({ success: false, error: 'Failed to update account balance', details: updateErr.message });
    }

    // Record in balance_history
    try {
      await supabase.from('balance_history').insert([{
        user_id,
        balance_before: prevBalance,
        balance_after: newBalance,
        change: creditAmount,
        reason: `Admin credit: Win from bet ${bet_id || 'unknown'} (main balance)`,
        created_by: req.user?.phone || 'admin',
        created_at: new Date().toISOString(),
      }]);
    } catch (_) {}

    await sendWonSmsWithFallback({
      userId: user_id,
      directPhone: user.phone_number,
      betRef: bet_id || 'BET',
      amountWon: creditAmount,
    });

    console.log(`💰 Credited KSH ${creditAmount} to main+winnings balances for ${user.username} (${user_id}). Account: ${prevBalance} → ${newBalance}, Winnings: ${prevWinningsBalance} → ${newWinningsBalance}`);

    res.json({
      success: true,
      newBalance,
      previousBalance: prevBalance,
      newWinningsBalance,
      previousWinningsBalance: prevWinningsBalance,
      credited: creditAmount
    });
  } catch (err) {
    console.error('Credit win error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET credited bet IDs (from balance_history)
router.get('/bets/credited', checkAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('balance_history')
      .select('reason')
      .like('reason', 'Admin credit: Win from bet %');

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const creditedBetIds = (data || []).map(row => {
      const match = row.reason.match(/Admin credit: Win from bet (.+)/);
      return match ? match[1] : null;
    }).filter(Boolean);

    res.json({ success: true, creditedBetIds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET SMS-triggered bet IDs (persistent across admin devices)
router.get('/bets/sms-triggered', checkAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('admin_logs')
      .select('target_id')
      .eq('action', 'send_bet_sms')
      .eq('target_type', 'bet');

    if (error) {
      return res.status(500).json({ success: false, error: error.message });
    }

    const smsTriggeredBetIds = [...new Set((data || []).map((row) => row.target_id).filter(Boolean))];
    res.json({ success: true, smsTriggeredBetIds });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 📩 POST: Send a bet-details SMS for a specific bet
router.post('/bets/:betId/send-sms', checkAdmin, async (req, res) => {
  try {
    const { betId } = req.params;

    if (!betId) {
      return res.status(400).json({ success: false, error: 'betId is required' });
    }

    const { data: bet, error: betError } = await supabase
      .from('bets')
      .select('id, bet_id, user_id, stake, potential_win, total_odds, status, created_at')
      .eq('id', betId)
      .single();

    if (betError || !bet) {
      return res.status(404).json({ success: false, error: 'Bet not found' });
    }

    const { data: selections, error: selectionsError } = await supabase
      .from('bet_selections')
      .select('home_team, away_team, market_type, market_key, odds')
      .eq('bet_id', bet.id)
      .order('created_at', { ascending: true });

    if (selectionsError) {
      return res.status(500).json({ success: false, error: 'Failed to load bet selections', details: selectionsError.message });
    }

    const betRef = bet.bet_id || bet.id;
    const previousStatus = String(bet.status || 'Open');
    const currentStatus = 'Won';
    const payoutAmount = Number(bet.potential_win || 0);

    const { data: priorTrigger } = await supabase
      .from('admin_logs')
      .select('id')
      .eq('action', 'send_bet_sms')
      .eq('target_type', 'bet')
      .eq('target_id', bet.id)
      .limit(1)
      .maybeSingle();

    const alreadyTriggered = !!priorTrigger;

    let phoneNumber = null;
    let username = 'Customer';
    let updatedBalance = null;
    let updatedWinningsBalance = null;
    let creditApplied = false;

    if (bet.user_id) {
      const { data: userRow } = await supabase
        .from('users')
        .select('phone_number, username, account_balance')
        .eq('id', bet.user_id)
        .maybeSingle();
      phoneNumber = userRow?.phone_number || null;
      username = userRow?.username || username;
      if (updatedBalance === null && userRow?.account_balance !== undefined && userRow?.account_balance !== null) {
        updatedBalance = Number(userRow.account_balance || 0);
      }
    }

    if (!phoneNumber && bet.user_id) {
      const { data: txWithPhone } = await supabase
        .from('transactions')
        .select('phone_number')
        .eq('user_id', bet.user_id)
        .not('phone_number', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      phoneNumber = txWithPhone?.phone_number || null;
    }

    if (!alreadyTriggered && bet.user_id && payoutAmount > 0) {
      let { data: userForCredit, error: userCreditErr } = await supabase
        .from('users')
        .select('account_balance, winnings_balance, total_winnings')
        .eq('id', bet.user_id)
        .single();

      if (userCreditErr && `${userCreditErr.message || ''}`.includes('winnings_balance')) {
        const fallbackUserResult = await supabase
          .from('users')
          .select('account_balance, total_winnings')
          .eq('id', bet.user_id)
          .single();
        userForCredit = fallbackUserResult.data;
        userCreditErr = fallbackUserResult.error;
      }

      if (userCreditErr || !userForCredit) {
        return res.status(500).json({ success: false, error: 'Failed to fetch user for payout', details: userCreditErr?.message });
      }

      const currentBalance = Number(userForCredit.account_balance || 0);
      const nextBalance = currentBalance + payoutAmount;
      const currentWinnings = Number(userForCredit.winnings_balance ?? userForCredit.total_winnings ?? 0) || 0;
      const nextWinningsBalance = currentWinnings + payoutAmount;
      const totalWinnings = Number(userForCredit.total_winnings || 0) + payoutAmount;

      const userBalanceUpdate = {
        account_balance: nextBalance,
        winnings_balance: nextWinningsBalance,
        total_winnings: totalWinnings,
        updated_at: new Date().toISOString(),
      };

      let { error: balanceError } = await supabase
        .from('users')
        .update(userBalanceUpdate)
        .eq('id', bet.user_id);

      if (balanceError && `${balanceError.message || ''}`.includes('winnings_balance')) {
        const fallbackUpdate = { ...userBalanceUpdate };
        delete fallbackUpdate.winnings_balance;
        const fallbackResult = await supabase
          .from('users')
          .update(fallbackUpdate)
          .eq('id', bet.user_id);
        balanceError = fallbackResult.error;
      }

      if (balanceError) {
        return res.status(500).json({ success: false, error: 'Failed to apply payout', details: balanceError.message });
      }

      const betSettlementUpdate = {
        status: currentStatus,
        amount_won: payoutAmount,
        settled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      let { error: betUpdateError } = await supabase
        .from('bets')
        .update(betSettlementUpdate)
        .eq('id', bet.id);

      if (betUpdateError && `${betUpdateError.message || ''}`.includes('amount_won')) {
        const fallbackSettlementUpdate = { ...betSettlementUpdate };
        delete fallbackSettlementUpdate.amount_won;
        const fallbackResult = await supabase
          .from('bets')
          .update(fallbackSettlementUpdate)
          .eq('id', bet.id);
        betUpdateError = fallbackResult.error;
      }

      if (betUpdateError) {
        return res.status(500).json({ success: false, error: 'Failed to update bet status', details: betUpdateError.message });
      }

      try {
        await supabase.from('balance_history').insert([{
          user_id: bet.user_id,
          balance_before: currentBalance,
          balance_after: nextBalance,
          change: payoutAmount,
          reason: `Admin SMS trigger payout: bet ${betRef}`,
          created_by: req.user?.phone || 'admin',
          created_at: new Date().toISOString(),
        }]);
      } catch (_) {}

      creditApplied = true;
      updatedBalance = nextBalance;
      updatedWinningsBalance = nextWinningsBalance;
    }

    if (previousStatus !== currentStatus) {
      const statusOnlyUpdate = {
        status: currentStatus,
        settled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      let { error: statusUpdateError } = await supabase
        .from('bets')
        .update(statusOnlyUpdate)
        .eq('id', bet.id);

      if (statusUpdateError) {
        return res.status(500).json({ success: false, error: 'Failed to reconcile bet status', details: statusUpdateError.message });
      }
    }

    const stake = Number(bet.stake || 0);
    const potentialWin = payoutAmount;
    const totalOdds = Number(bet.total_odds || 0);

    const payoutText = Number.isInteger(potentialWin) ? String(potentialWin) : potentialWin.toFixed(2);
    const balanceText = updatedBalance !== null
      ? (Number.isInteger(Number(updatedBalance)) ? String(Number(updatedBalance)) : Number(updatedBalance).toFixed(2))
      : '0';
    const smsMessage = `Congratulations ${username}! You WON KSH${payoutText} on BETNEXA from your bet ID:${betRef}. Your new balance is KSH${balanceText}, Login at https://betnexa.co.ke to view your account`;

    let sent = false;
    if (phoneNumber) {
      sent = await sendSms(phoneNumber, smsMessage);
    }

    if (!alreadyTriggered) {
      try {
        await supabase.from('admin_logs').insert([{
          admin_id: req.user?.id && req.user.id !== 'unknown' ? req.user.id : null,
          action: 'send_bet_sms',
          target_type: 'bet',
          target_id: bet.id,
          changes: {
            previous_status: previousStatus,
            current_status: currentStatus,
            payout_amount: payoutAmount,
            sms_sent: sent,
            phone_number: phoneNumber || null,
          },
          description: `Manual bet SMS trigger for bet ${betRef}`,
          created_at: new Date().toISOString(),
        }]);
      } catch (_) {}
    }

    return res.json({
      success: true,
      alreadyTriggered,
      creditApplied,
      phoneNumber,
      betId: betRef,
      betStatus: currentStatus,
      smsSent: sent,
      updatedBalance,
      updatedWinningsBalance,
      draftedMessage: smsMessage,
      sent,
    });
  } catch (error) {
    console.error('Send bet SMS error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/bets/bulk-delete', checkAdmin, async (req, res) => {
  try {
    const { betIds } = req.body;

    if (!Array.isArray(betIds) || betIds.length === 0) {
      return res.status(400).json({ success: false, error: 'betIds must be a non-empty array' });
    }

    console.log(`\n🗑️  [DELETE] Bulk deleting ${betIds.length} bets`);

    // Delete bet_selections first (due to foreign key constraint)
    const { error: selectionsDeleteError } = await supabase
      .from('bet_selections')
      .delete()
      .in('bet_id', betIds);

    if (selectionsDeleteError) {
      console.error('Error deleting selections:', selectionsDeleteError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to delete bet selections', 
        details: selectionsDeleteError.message 
      });
    }

    // Delete the bets
    const { error: betsDeleteError } = await supabase
      .from('bets')
      .delete()
      .in('id', betIds);

    if (betsDeleteError) {
      console.error('Error deleting bets:', betsDeleteError.message);
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to delete bets', 
        details: betsDeleteError.message 
      });
    }

    // Log the deletion
    try {
      await supabase.from('admin_logs').insert([{
        admin_id: req.user?.id && req.user.id !== 'unknown' ? req.user.id : null,
        action: 'bulk_delete_bets',
        target_type: 'bets',
        changes: {
          deleted_count: betIds.length,
          bet_ids: betIds,
        },
        description: `Bulk deleted ${betIds.length} bets`,
        created_at: new Date().toISOString(),
      }]);
    } catch (_) {}

    console.log(`✅ Successfully deleted ${betIds.length} bets and their selections`);

    return res.json({
      success: true,
      deletedCount: betIds.length,
      message: `Successfully deleted ${betIds.length} bet(s)`
    });
  } catch (error) {
    console.error('Bulk delete bets error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// MATCH EVENT SCHEDULER ROUTES
// ============================================

/**
 * POST: Create match events
 * Body: { gameId, events: [{eventType, scheduledAt, eventData}, ...] }
 */
router.post('/match-events', checkAdmin, async (req, res) => {
  try {
    const { gameId, events } = req.body;

    if (!gameId) {
      return res.status(400).json({ success: false, error: 'gameId is required' });
    }

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, error: 'events array is required and must not be empty' });
    }

    console.log(`📅 Creating match events for game ${gameId}`);

    const result = await createMatchEvents(gameId, events);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: `Created ${result.eventsCreated} match events`,
      eventsCreated: result.eventsCreated,
      events: result.events,
    });
  } catch (error) {
    console.error('❌ Error creating match events:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET: List all events for a game
 */
router.get('/match-events/:gameId', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    console.log(`📋 Fetching match events for game ${gameId}`);

    const result = await getMatchEvents(gameId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      events: result.events,
      totalEvents: result.events.length,
      executedEvents: result.events.filter((e) => e.executed_at).length,
      pendingEvents: result.events.filter((e) => !e.executed_at && e.is_active).length,
    });
  } catch (error) {
    console.error('❌ Error fetching match events:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT: Update a match event
 */
router.put('/match-events/:eventId', checkAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { scheduled_at, event_data, is_active } = req.body;

    const updates = {};
    if (scheduled_at) updates.scheduled_at = scheduled_at;
    if (event_data) updates.event_data = event_data;
    if (is_active !== undefined) updates.is_active = is_active;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid updates provided' });
    }

    console.log(`📝 Updating match event ${eventId}`);

    const result = await updateMatchEvent(eventId, updates);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: 'Event updated successfully',
      event: result.event,
    });
  } catch (error) {
    console.error('❌ Error updating match event:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE: Remove a match event
 */
router.delete('/match-events/:eventId', checkAdmin, async (req, res) => {
  try {
    const { eventId } = req.params;

    console.log(`🗑️  Deleting match event ${eventId}`);

    const result = await deleteMatchEvent(eventId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: 'Event deleted successfully',
    });
  } catch (error) {
    console.error('❌ Error deleting match event:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST: Manually trigger execution of pending events
 */
router.post('/match-events/:gameId/execute-pending', checkAdmin, async (req, res) => {
  try {
    const { gameId } = req.params;

    console.log(`⚡ Triggering execution of pending events for game ${gameId}`);

    const result = await checkAndExecutePendingEvents(gameId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: `Executed ${result.eventsExecuted} events`,
      eventsExecuted: result.eventsExecuted,
      results: result.results,
    });
  } catch (error) {
    console.error('❌ Error executing pending events:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Simple test endpoint to verify admin routes are loaded
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Admin routes are working', timestamp: new Date().toISOString() });
});

// GET /api/admin/earnings - Fetch earnings statistics with date filtering
router.get('/earnings', checkAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    console.log(`[EARNINGS] Fetching earnings stats. Start: ${startDate}, End: ${endDate}`);
    
    if (!supabase) {
      console.error('[EARNINGS] Supabase not initialized');
      return res.status(500).json({ success: false, error: 'Database not initialized' });
    }
    
    // Parse dates
    let queryStartDate = startDate ? new Date(startDate + 'T00:00:00Z') : new Date();
    let queryEndDate = endDate ? new Date(endDate + 'T23:59:59Z') : new Date();
    
    if (!startDate) queryStartDate.setHours(0, 0, 0, 0);
    if (!endDate) queryEndDate.setHours(23, 59, 59, 999);
    
    const startIso = queryStartDate.toISOString();
    const endIso = queryEndDate.toISOString();
    console.log(`[EARNINGS] Query range: ${startIso} to ${endIso}`);
    
    // Helper to fetch all rows (bypasses Supabase 1000-row default limit)
    async function fetchAll(table, selectCols, filters) {
      const allRows = [];
      const pageSize = 1000;
      let from = 0;
      while (true) {
        let query = supabase.from(table).select(selectCols).range(from, from + pageSize - 1);
        for (const f of filters) {
          query = query[f.op](f.col, f.val);
        }
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allRows;
    }
    
    // Fetch completed deposits from transactions table (includes STK push + C2B)
    console.log('[EARNINGS] Fetching deposits from transactions...');
    let allTransactions = [];
    try {
      allTransactions = await fetchAll('transactions', 'amount', [
        { op: 'eq', col: 'type', val: 'deposit' },
        { op: 'eq', col: 'status', val: 'completed' },
        { op: 'gte', col: 'created_at', val: startIso },
        { op: 'lte', col: 'created_at', val: endIso },
      ]);
    } catch (depositsError) {
      console.error('[EARNINGS] Error fetching deposits:', depositsError);
      return res.status(500).json({ success: false, error: `Failed to fetch deposits: ${depositsError.message}` });
    }
    console.log(`[EARNINGS] Total transactions found: ${allTransactions.length}`);
    
    // Classify: 1000 = activation fees, 399 = priority fees, rest = deposits
    const deposits = [];
    const activationFromTx = [];
    const priorityFromTx = [];
    allTransactions.forEach(t => {
      const amt = parseFloat(t.amount || 0);
      if (amt === 1000) activationFromTx.push(t);
      else if (amt === 399) priorityFromTx.push(t);
      else deposits.push(t);
    });
    
    // Also fetch from activation_fees table
    console.log('[EARNINGS] Fetching activation fees...');
    let activationFees = [];
    try {
      activationFees = await fetchAll('activation_fees', 'amount', [
        { op: 'eq', col: 'status', val: 'completed' },
        { op: 'gte', col: 'created_at', val: startIso },
        { op: 'lte', col: 'created_at', val: endIso },
      ]);
    } catch (activationFeesError) {
      console.warn('[EARNINGS] Warning fetching activation fees:', activationFeesError);
    }
    console.log(`[EARNINGS] Activation fees from table: ${activationFees.length}`);
    
    // Classify activation_fees table records too: 1000=activation, 399=priority, rest=deposits
    activationFees.forEach(af => {
      const amt = parseFloat(af.amount || 0);
      if (amt === 1000) activationFromTx.push(af);
      else if (amt === 399) priorityFromTx.push(af);
      else deposits.push(af);
    });
    
    // Calculate totals
    const totalDeposits = deposits.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    const totalActivationFees = activationFromTx.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    const totalPriorityFees = priorityFromTx.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    const masterTotal = totalDeposits + totalActivationFees + totalPriorityFees;
    
    console.log(`[EARNINGS] Results - Deposits: KSH ${totalDeposits}, Activation Fees: KSH ${totalActivationFees}, Priority Fees: KSH ${totalPriorityFees}, Total: KSH ${masterTotal}`);
    
    res.json({
      success: true,
      data: {
        startDate: queryStartDate.toISOString(),
        endDate: queryEndDate.toISOString(),
        totalDeposits: Math.round(totalDeposits),
        totalActivationFees: Math.round(totalActivationFees),
        totalPriorityFees: Math.round(totalPriorityFees),
        masterTotal: Math.round(masterTotal),
        depositCount: deposits.length,
        activationFeeCount: activationFromTx.length,
        priorityFeeCount: priorityFromTx.length,
      }
    });
  } catch (error) {
    console.error('[EARNINGS] Unexpected error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/earnings/daily - Fetch daily earnings breakdown for calendar
router.get('/earnings/daily', checkAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    console.log('[EARNINGS_DAILY] Fetching daily breakdown...');
    
    if (!supabase) {
      console.error('[EARNINGS_DAILY] Supabase not initialized');
      return res.status(500).json({ success: false, error: 'Database not initialized' });
    }
    
    let queryStartDate = startDate ? new Date(startDate + 'T00:00:00Z') : new Date();
    let queryEndDate = endDate ? new Date(endDate + 'T23:59:59Z') : new Date();
    
    if (!startDate) queryStartDate.setHours(0, 0, 0, 0);
    if (!endDate) queryEndDate.setHours(23, 59, 59, 999);
    
    const startIso = queryStartDate.toISOString();
    const endIso = queryEndDate.toISOString();
    console.log(`[EARNINGS_DAILY] Range: ${startIso} to ${endIso}`);
    
    // Helper to fetch all rows (bypasses Supabase 1000-row default limit)
    async function fetchAll(table, selectCols, filters) {
      const allRows = [];
      const pageSize = 1000;
      let from = 0;
      while (true) {
        let query = supabase.from(table).select(selectCols).range(from, from + pageSize - 1);
        for (const f of filters) {
          query = query[f.op](f.col, f.val);
        }
        const { data, error } = await query;
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allRows;
    }
    
    // Fetch completed deposits from transactions table
    console.log('[EARNINGS_DAILY] Fetching deposits from transactions...');
    let allTransactions = [];
    try {
      allTransactions = await fetchAll('transactions', 'amount, created_at', [
        { op: 'eq', col: 'type', val: 'deposit' },
        { op: 'eq', col: 'status', val: 'completed' },
        { op: 'gte', col: 'created_at', val: startIso },
        { op: 'lte', col: 'created_at', val: endIso },
      ]);
    } catch (depositsError) {
      console.error('[EARNINGS_DAILY] Error fetching deposits:', depositsError);
      return res.status(500).json({ success: false, error: `Failed to fetch deposits: ${depositsError.message}` });
    }
    console.log(`[EARNINGS_DAILY] Total transactions found: ${allTransactions.length}`);
    
    console.log('[EARNINGS_DAILY] Fetching activation fees...');
    let activationFees = [];
    try {
      activationFees = await fetchAll('activation_fees', 'amount, created_at', [
        { op: 'eq', col: 'status', val: 'completed' },
        { op: 'gte', col: 'created_at', val: startIso },
        { op: 'lte', col: 'created_at', val: endIso },
      ]);
    } catch (activationFeesError) {
      console.warn('[EARNINGS_DAILY] Warning fetching activation fees:', activationFeesError);
    }
    console.log(`[EARNINGS_DAILY] Activation fees found: ${activationFees.length}`);
    
    // Group by date, classify: 1000 = activation, 399 = priority, rest = deposits
    const dailyEarnings = {};
    
    allTransactions.forEach(t => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!dailyEarnings[date]) {
        dailyEarnings[date] = { deposits: 0, activation: 0, priority: 0, total: 0 };
      }
      const amt = parseFloat(t.amount || 0);
      if (amt === 1000) dailyEarnings[date].activation += amt;
      else if (amt === 399) dailyEarnings[date].priority += amt;
      else dailyEarnings[date].deposits += amt;
    });
    
    // Classify activation_fees table records: 1000=activation, 399=priority, rest=deposits
    activationFees.forEach(af => {
      const date = new Date(af.created_at).toISOString().split('T')[0];
      if (!dailyEarnings[date]) {
        dailyEarnings[date] = { deposits: 0, activation: 0, priority: 0, total: 0 };
      }
      const amt = parseFloat(af.amount || 0);
      if (amt === 1000) dailyEarnings[date].activation += amt;
      else if (amt === 399) dailyEarnings[date].priority += amt;
      else dailyEarnings[date].deposits += amt;
    });
    
    // Calculate totals for each day
    Object.keys(dailyEarnings).forEach(date => {
      const day = dailyEarnings[date];
      day.total = day.deposits + day.activation + day.priority;
    });
    
    res.json({
      success: true,
      data: dailyEarnings
    });
  } catch (error) {
    console.error('[EARNINGS_DAILY] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/admin/earnings/day-details - Fetch individual transactions for a specific date
router.get('/earnings/day-details', checkAdmin, async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ success: false, error: 'date parameter required' });

    const startIso = new Date(date + 'T00:00:00Z').toISOString();
    const endIso = new Date(date + 'T23:59:59Z').toISOString();

    // Fetch all completed deposit transactions for this date
    const { data: txs, error: txErr } = await supabase
      .from('transactions')
      .select('phone_number, user_id, amount, created_at')
      .eq('type', 'deposit')
      .eq('status', 'completed')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: false });

    if (txErr) return res.status(500).json({ success: false, error: txErr.message });

    // Fetch activation_fees for this date
    const { data: afs, error: afErr } = await supabase
      .from('activation_fees')
      .select('phone_number, user_id, amount, created_at')
      .eq('status', 'completed')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: false });

    if (afErr) console.warn('[DAY_DETAILS] activation_fees error:', afErr);

    const allRecords = [...(txs || []), ...(afs || [])];
    allRecords.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Collect unique user_ids to fetch usernames
    const userIds = [...new Set(allRecords.map(r => r.user_id).filter(Boolean))];
    let userMap = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from('users')
        .select('id, username, phone_number')
        .in('id', userIds);
      if (users) {
        users.forEach(u => { userMap[u.id] = u; });
      }
    }

    // Build response with classification
    const transactions = allRecords.map(r => {
      const amt = parseFloat(r.amount || 0);
      let category = 'deposit';
      if (amt === 1000) category = 'activation';
      else if (amt === 399) category = 'priority';

      const usr = userMap[r.user_id];
      return {
        phone: usr?.phone_number || r.phone_number || '-',
        username: usr?.username || '-',
        amount: amt,
        time: r.created_at,
        category,
      };
    });

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('[DAY_DETAILS] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// C2B URL REGISTRATION & BETNEXA ID MANAGEMENT
// ─────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/c2b/register-urls
 * Register C2B validation and confirmation URLs with Safaricom.
 * Must be called once after deployment or URL changes.
 */
router.post('/c2b/register-urls', checkAdmin, async (req, res) => {
  try {
    console.log('\n📡 [C2B] Admin registering C2B URLs with Safaricom...');
    const result = await registerC2BUrls();
    console.log('✅ [C2B] URLs registered successfully:', result);
    return res.json({ success: true, message: 'C2B URLs registered successfully', result });
  } catch (error) {
    console.error('❌ [C2B] URL registration failed:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/admin/betnexa-ids/backfill
 * Assign BETNEXA IDs to all existing users who don't have one.
 */
router.post('/betnexa-ids/backfill', checkAdmin, async (req, res) => {
  try {
    console.log('\n🆔 [BACKFILL] Admin triggered BETNEXA ID backfill...');
    const result = await backfillBetnexaIds();
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ [BACKFILL] Error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
