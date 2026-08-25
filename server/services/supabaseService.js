// server/services/supabaseService.js
// Comprehensive Supabase integration service for BETNEXA

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabaseUrl = process.env.SUPABASE_URL || 'https://your-project.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// ==================== USER OPERATIONS ====================

export const supabaseService = {
  // ==================== USER OPERATIONS ====================

  /**
   * Get user by ID with full profile
   */
  async getUserById(userId) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw new Error(`Failed to fetch user: ${error.message}`);
    return data;
  },

  /**
   * Get user by phone number
   */
  async getUserByPhone(phoneNumber) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone_number', phoneNumber)
      .single();

    if (error) return null;
    return data;
  },

  /**
   * Get admin users
   */
  async getAdminUsers() {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_admin', true)
      .is('deleted_at', null);

    if (error) throw new Error(`Failed to fetch admin users: ${error.message}`);
    return data;
  },

  /**
   * Create new user
   */
  async createUser(userData) {
    const { data, error } = await supabase
      .from('users')
      .insert([{
        username: userData.username,
        phone_number: userData.phoneNumber,
        password: userData.password,
        email: userData.email || null,
        account_balance: 0,
        is_admin: userData.isAdmin || false,
        is_verified: userData.isVerified || false,
        role: userData.isAdmin ? 'admin' : 'user',
        status: 'active'
      }])
      .select()
      .single();

    if (error) throw new Error(`Failed to create user: ${error.message}`);
    return data;
  },

  /**
   * Update user profile
   */
  async updateUser(userId, updateData) {
    const { data, error } = await supabase
      .from('users')
      .update({
        ...updateData,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw new Error(`Failed to update user: ${error.message}`);
    return data;
  },

  /**
   * Update user balance (admin operation)
   */
  async updateUserBalance(userId, amount, reason, adminId) {
    try {
      const user = await this.getUserById(userId);
      const oldBalance = user.account_balance;
      const newBalance = oldBalance + parseFloat(amount);

      const { data: updatedUser, error: updateError } = await supabase
        .from('users')
        .update({
          account_balance: newBalance,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select()
        .single();

      if (updateError) throw updateError;

      // Log the balance changes in balance_history
      await supabase
        .from('balance_history')
        .insert([{
          user_id: userId,
          balance_before: oldBalance,
          balance_after: newBalance,
          change: parseFloat(amount),
          reason: reason,
          created_by: 'admin'
        }]);

      // Log admin action
      await this.logAdminAction(adminId, 'balance_adjust', 'user', userId, {
        oldBalance,
        newBalance,
        reason
      });

      return updatedUser;
    } catch (error) {
      throw new Error(`Failed to update balance: ${error.message}`);
    }
  },

  /**
   * Delete user (soft delete)
   */
  async deleteUser(userId, adminId) {
    try {
      // Soft delete by setting deleted_at
      const { data, error } = await supabase
        .from('users')
        .update({
          deleted_at: new Date().toISOString(),
          status: 'inactive',
          updated_at: new Date().toISOString()
        })
        .eq('id', userId)
        .select();

      if (error) throw error;

      // Delete all user transactions
      await supabase
        .from('transactions')
        .delete()
        .eq('user_id', userId);

      // Delete all user bets
      await supabase
        .from('bets')
        .delete()
        .eq('user_id', userId);

      // Log admin action
      await this.logAdminAction(adminId, 'user_delete', 'user', userId, {
        status: 'deleted'
      });

      return data;
    } catch (error) {
      throw new Error(`Failed to delete user: ${error.message}`);
    }
  },

  // ==================== GAME OPERATIONS ====================

  /**
   * Get all games
   */
  async getAllGames() {
    const { data, error } = await supabase
      .from('games')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to fetch games: ${error.message}`);
    return data;
  },

  /**
   * Get game with markets
   */
  async getGameWithMarkets(gameId) {
    const { data: gameData, error: gameError } = await supabase
      .from('games')
      .select('*')
      .eq('id', gameId)
      .single();

    if (gameError) throw gameError;

    const { data: markets, error: marketError } = await supabase
      .from('markets')
      .select('*')
      .eq('game_id', gameId);

    if (marketError) throw marketError;

    return {
      ...gameData,
      markets: markets || []
    };
  },

  /**
   * Create new game
   */
  async createGame(gameData) {
    const { data, error } = await supabase
      .from('games')
      .insert([{
        game_id: `game_${Date.now()}`,
        league: gameData.league,
        home_team: gameData.homeTeam,
        away_team: gameData.awayTeam,
        home_odds: parseFloat(gameData.homeOdds),
        draw_odds: parseFloat(gameData.drawOdds),
        away_odds: parseFloat(gameData.awayOdds),
        time: gameData.time,
        status: gameData.status || 'upcoming'
      }])
      .select()
      .single();

    if (error) throw new Error(`Failed to create game: ${error.message}`);
    return data;
  },

  /**
   * Update game (admin operation)
   */
  async updateGame(gameId, updateData, adminId) {
    try {
      const oldGame = await supabase
        .from('games')
        .select('*')
        .eq('id', gameId)
        .single();

      const { data, error } = await supabase
        .from('games')
        .update({
          ...updateData,
          updated_at: new Date().toISOString()
        })
        .eq('id', gameId)
        .select()
        .single();

      if (error) throw error;

      // Log admin action
      await this.logAdminAction(adminId, 'game_update', 'game', gameId, {
        oldValues: oldGame.data,
        newValues: updateData
      });

      return data;
    } catch (error) {
      throw new Error(`Failed to update game: ${error.message}`);
    }
  },

  /**
   * Update game score and status
   */
  async updateGameScore(gameId, homeScore, awayScore, status, adminId) {
    try {
      const { data, error } = await supabase
        .from('games')
        .update({
          home_score: homeScore,
          away_score: awayScore,
          status: status,
          updated_at: new Date().toISOString()
        })
        .eq('id', gameId)
        .select()
        .single();

      if (error) throw error;

      // Log admin action
      await this.logAdminAction(adminId, 'game_score_update', 'game', gameId, {
        homeScore,
        awayScore,
        status
      });

      return data;
    } catch (error) {
      throw new Error(`Failed to update game score: ${error.message}`);
    }
  },

  // ==================== BET OPERATIONS ====================

  /**
   * Create new bet
   */
  async createBet(userId, betData) {
    try {
      // Create bet record
      const betId = `BET${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
      const now = new Date();
      const eatFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Nairobi',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const eatParts = eatFormatter.formatToParts(now);
      const eatMap = Object.fromEntries(eatParts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));

      const { data: bet, error: betError } = await supabase
        .from('bets')
        .insert([{
          bet_id: betId,
          user_id: userId,
          stake: parseFloat(betData.stake),
          potential_win: parseFloat(betData.potentialWin),
          total_odds: parseFloat(betData.totalOdds),
          status: 'Open',
          bet_date: `${eatMap.day}/${eatMap.month}/${eatMap.year}`,
          bet_time: `${eatMap.hour}:${eatMap.minute}`
        }])
        .select()
        .single();

      if (betError) throw betError;

      // Create bet selections
      for (const selection of betData.selections) {
        await supabase
          .from('bet_selections')
          .insert([{
            bet_id: bet.id,
            game_id: selection.matchId,
            market_key: selection.type,
            market_type: selection.market,
            market_label: selection.marketLabel || selection.type,
            home_team: selection.homeTeam,
            away_team: selection.awayTeam,
            odds: parseFloat(selection.odds),
            outcome: 'pending'
          }]);
      }

      // Deduct stake from user balance
      const user = await this.getUserById(userId);
      const newBalance = user.account_balance - parseFloat(betData.stake);

      await supabase
        .from('users')
        .update({
          account_balance: newBalance,
          total_bets: (user.total_bets || 0) + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);

      // Record transaction
      await this.createTransaction({
        userId,
        betId: bet.id,
        type: 'bet_placement',
        amount: betData.stake,
        balanceBefore: user.account_balance,
        balanceAfter: newBalance,
        status: 'completed',
        description: `Bet placement: ${betId}`
      });

      return bet;
    } catch (error) {
      throw new Error(`Failed to create bet: ${error.message}`);
    }
  },

  /**
   * Settle bet with outcome
   */
  async settleBet(betId, status, payoutAmount = 0, adminId = null) {
    try {
      const bet = await supabase
        .from('bets')
        .select('*')
        .eq('id', betId)
        .single();

      if (!bet) throw new Error('Bet not found');

      const { data, error } = await supabase
        .from('bets')
        .update({
          status: status,
          settled_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', betId)
        .select()
        .single();

      if (error) throw error;

      // If bet won, add payout to balance
      if (status === 'Won' && payoutAmount > 0) {
        const user = await this.getUserById(bet.data.user_id);
        const newBalance = user.account_balance + payoutAmount;

        await supabase
          .from('users')
          .update({
            account_balance: newBalance,
            total_winnings: user.total_winnings + payoutAmount,
            updated_at: new Date().toISOString()
          })
          .eq('id', bet.data.user_id);

        // Record payout transaction
        await this.createTransaction({
          userId: bet.data.user_id,
          betId: betId,
          type: 'bet_payout',
          amount: payoutAmount,
          balanceBefore: user.account_balance,
          balanceAfter: newBalance,
          status: 'completed',
          description: `Bet payout: ${payoutAmount}`
        });

        // Log if admin settled it
        if (adminId) {
          await this.logAdminAction(adminId, 'bet_settle', 'bet', betId, {
            status,
            payoutAmount
          });
        }
      }

      return data;
    } catch (error) {
      throw new Error(`Failed to settle bet: ${error.message}`);
    }
  },

  /**
   * Get user bets with selections
   */
  async getUserBets(userId) {
    try {
      const { data: bets, error } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Get selections for each bet
      const betsWithSelections = await Promise.all(
        bets.map(async (bet) => {
          const { data: selections } = await supabase
            .from('bet_selections')
            .select('*')
            .eq('bet_id', bet.id);

          return {
            ...bet,
            selections: selections || []
          };
        })
      );

      return betsWithSelections;
    } catch (error) {
      throw new Error(`Failed to fetch user bets: ${error.message}`);
    }
  },

  // ==================== TRANSACTION OPERATIONS ====================

  /**
   * Create transaction
   */
  async createTransaction(transactionData) {
    const { data, error } = await supabase
      .from('transactions')
      .insert([{
        transaction_id: `TXN${Date.now()}`,
        user_id: transactionData.userId,
        bet_id: transactionData.betId || null,
        type: transactionData.type,
        amount: transactionData.amount,
        balance_before: transactionData.balanceBefore,
        balance_after: transactionData.balanceAfter,
        status: transactionData.status || 'pending',
        method: transactionData.method || 'M-Pesa',
        phone_number: transactionData.phoneNumber || null,
        external_reference: transactionData.externalReference || null,
        mpesa_receipt: transactionData.mpesaReceipt || null,
        description: transactionData.description || ''
      }])
      .select()
      .single();

    if (error) throw new Error(`Failed to create transaction: ${error.message}`);
    return data;
  },

  /**
   * Get user transactions
   */
  async getUserTransactions(userId, limit = 50) {
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(`Failed to fetch transactions: ${error.message}`);
    return data;
  },

  /**
   * Update transaction status
   */
  async updateTransactionStatus(transactionId, status) {
    const { data, error } = await supabase
      .from('transactions')
      .update({
        status: status,
        updated_at: new Date().toISOString()
      })
      .eq('id', transactionId)
      .select()
      .single();

    if (error) throw new Error(`Failed to update transaction: ${error.message}`);
    return data;
  },

  // ==================== PAYMENT OPERATIONS ====================

  /**
   * Create payment record
   */
  async createPayment(paymentData) {
    const { data, error } = await supabase
      .from('payments')
      .insert([{
        payment_id: `PAY${Date.now()}`,
        transaction_id: paymentData.transactionId,
        user_id: paymentData.userId,
        amount: paymentData.amount,
        phone_number: paymentData.phoneNumber,
        status: 'pending',
        external_reference: paymentData.externalReference || null,
        is_activation: paymentData.isActivation || false
      }])
      .select()
      .single();

    if (error) throw new Error(`Failed to create payment: ${error.message}`);
    return data;
  },

  /**
   * Update payment status
   */
  async updatePaymentStatus(externalReference, status, mpesaReceipt = null, resultDesc = null) {
    const { data, error } = await supabase
      .from('payments')
      .update({
        status: status,
        mpesa_receipt: mpesaReceipt,
        result_description: resultDesc,
        completed_at: status === 'completed' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      })
      .eq('external_reference', externalReference)
      .select()
      .single();

    if (error) throw new Error(`Failed to update payment: ${error.message}`);
    return data;
  },

  /**
   * Get payment by external reference
   */
  async getPaymentByReference(externalReference) {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('external_reference', externalReference)
      .single();

    if (error) return null;
    return data;
  },

  // ==================== ADMIN OPERATIONS ====================

  /**
   * Log admin action for audit trail
   */
  async logAdminAction(adminId, action, targetType, targetId, changes = {}, description = null) {
    const { data, error } = await supabase
      .from('admin_logs')
      .insert([{
        admin_id: adminId,
        action: action,
        target_type: targetType,
        target_id: targetId,
        changes: changes,
        description: description,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) {
      console.error('Failed to log admin action:', error);
    }
    return data;
  },

  /**
   * Get admin logs
   */
  async getAdminLogs(adminId = null, limit = 100) {
    let query = supabase
      .from('admin_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (adminId) {
      query = query.eq('admin_id', adminId);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to fetch admin logs: ${error.message}`);
    return data;
  },

  // ==================== SETTINGS OPERATIONS ====================

  /**
   * Get setting value
   */
  async getSetting(settingKey) {
    const { data, error } = await supabase
      .from('settings')
      .select('setting_value')
      .eq('setting_key', settingKey)
      .single();

    if (error) return null;
    return data?.setting_value;
  },

  /**
   * Update setting (admin only)
   */
  async updateSetting(settingKey, settingValue, adminId) {
    const { data, error } = await supabase
      .from('settings')
      .update({
        setting_value: settingValue,
        updated_by: adminId,
        updated_at: new Date().toISOString()
      })
      .eq('setting_key', settingKey)
      .select()
      .single();

    if (error) throw new Error(`Failed to update setting: ${error.message}`);

    await this.logAdminAction(adminId, 'setting_update', 'setting', settingKey, {
      settingValue
    });

    return data;
  },

  // ==================== STATISTICS OPERATIONS ====================

  /**
   * Get user summary statistics
   */
  async getUserStats(userId) {
    const { data, error } = await supabase
      .from('user_balance_summary')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Get transaction summary for user
   */
  async getTransactionSummary(userId) {
    const { data, error } = await supabase
      .from('transaction_summary')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    return data;
  },

  /**
   * Get all users with stats (admin)
   */
  async getAllUsersWithStats() {
    const { data, error } = await supabase
      .from('user_balance_summary')
      .select('*');

    if (error) throw error;
    return data;
  },

  /**
   * Get platform statistics (admin)
   */
  async getPlatformStats() {
    try {
      const [usersData, betsData, transactionsData] = await Promise.all([
        supabase.from('users').select('id, account_balance').is('deleted_at', null),
        supabase.from('bets').select('stake, potential_win, status'),
        supabase.from('transactions').select('amount, type, status')
      ]);

      const totalUsers = usersData.data?.length || 0;
      const totalBalance = usersData.data?.reduce((sum, u) => sum + (u.account_balance || 0), 0) || 0;
      const totalBets = betsData.data?.length || 0;
      const totalBetAmount = betsData.data?.reduce((sum, b) => sum + (b.stake || 0), 0) || 0;
      const totalDeposits = transactionsData.data
        ?.filter(t => t.type === 'deposit' && t.status === 'completed')
        .reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
      const totalPayouts = transactionsData.data
        ?.filter(t => t.type === 'bet_payout' && t.status === 'completed')
        .reduce((sum, t) => sum + (t.amount || 0), 0) || 0;

      return {
        totalUsers,
        totalBalance,
        totalBets,
        totalBetAmount,
        totalDeposits,
        totalPayouts,
        platformRevenue: totalDeposits - totalPayouts
      };
    } catch (error) {
      throw new Error(`Failed to get platform stats: ${error.message}`);
    }
  }
};

export default supabaseService;
